import http from "node:http";
import type { Dashboard, MonitorRow, StatusView } from "./ui.js";
import type { LogEntry } from "./logger.js";

const MAX_FEED = 500;

type WireLog = { ts: string; level: string; msg: string };

/**
 * Serves the same live feed as the terminal UI at http://localhost:<port> over
 * Server-Sent Events. Self-contained: no framework, no external assets. A newly
 * connected browser gets the current status, monitor rows and recent feed, then
 * live updates. Implements the same Dashboard interface, so the engine is
 * unaware of it.
 */
export class WebDashboard implements Dashboard {
  private readonly server: http.Server;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly feed: WireLog[] = [];
  private status?: StatusView;
  private monitor: MonitorRow[] = [];
  private readonly quitCbs: Array<() => void> = [];

  constructor(
    private readonly port: number,
    private readonly host: string,
    private readonly onReady?: (url: string) => void,
    private readonly onError?: (msg: string) => void,
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (err) => this.onError?.(`web UI server error: ${err.message}`));
    this.server.listen(this.port, this.host, () => this.onReady?.(`http://${this.host}:${this.port}`));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      // Backfill current state so a fresh tab is immediately populated.
      if (this.status) this.send(res, "status", this.status);
      this.send(res, "monitor", this.monitor);
      for (const l of this.feed) this.send(res, "log", l);
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }

  private send(res: http.ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  logEntry(e: LogEntry): void {
    const wire: WireLog = { ts: e.ts.toISOString(), level: e.level, msg: e.msg };
    this.feed.push(wire);
    if (this.feed.length > MAX_FEED) this.feed.shift();
    this.broadcast("log", wire);
  }

  setStatus(s: StatusView): void {
    this.status = s;
    this.broadcast("status", s);
  }

  setMonitor(rows: MonitorRow[]): void {
    this.monitor = rows;
    this.broadcast("monitor", rows);
  }

  onQuit(cb: () => void): void {
    this.quitCbs.push(cb);
  }

  destroy(): void {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.server.close();
  }
}

// Self-contained dark dashboard. Mirrors the TUI: status header, positions &
// auctions table, live feed. Colors match the terminal levels.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Liquidation Engine</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #d5dbe2;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 12px 16px; border-bottom: 1px solid #1e2733; background: #0e141b; }
  .title { font-size: 15px; font-weight: 700; color: #e8eef5; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 20px; }
  .cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k { color: #6b7785; }
  .v { color: #e8eef5; font-weight: 600; }
  .mode-LIVE { color: #f87171; } .mode-DRY.RUN, .mode-DRY { color: #fbbf24; }
  .green { color: #4ade80; } .yellow { color: #fbbf24; } .cyan { color: #22d3ee; }
  section { padding: 10px 16px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #6b7785; margin: 4px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 10px 3px 0; white-space: nowrap; }
  th { color: #6b7785; font-weight: 600; border-bottom: 1px solid #1e2733; }
  td.detail { white-space: normal; color: #aeb7c2; }
  tr.red td { color: #f87171; } tr.yellow td { color: #fbbf24; }
  tr.cyan td { color: #22d3ee; } tr.green td { color: #4ade80; } tr.gray td { color: #7b8794; }
  #feedWrap { border-top: 1px solid #1e2733; }
  #feed { height: 42vh; overflow-y: auto; padding: 8px 16px; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .ts { color: #55606d; } .tag { font-weight: 700; margin: 0 8px; }
  .info { color: #d5dbe2; } .success { color: #4ade80; } .warn { color: #fbbf24; }
  .error { color: #f87171; } .action { color: #22d3ee; } .debug { color: #7b8794; }
  .empty { color: #55606d; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#f87171; margin-right:6px; vertical-align:middle; }
  .dot.on { background:#4ade80; }
</style>
</head>
<body>
<header>
  <div class="title"><span id="dot" class="dot"></span>Liquidation Engine</div>
  <div class="grid">
    <div class="cell"><span class="k">Network</span> <span id="network" class="v cyan">-</span> <span id="chain" class="k"></span></div>
    <div class="cell"><span class="k">Market</span> <span id="market" class="v cyan">-</span></div>
    <div class="cell"><span class="k">Mode</span> <span id="mode" class="v">-</span></div>
    <div class="cell"><span class="k">Cycle</span> <span id="cycle" class="v">0</span></div>
    <div class="cell"><span class="k">Next poll</span> <span id="nextPollIn" class="v">-</span></div>
    <div class="cell"><span class="k">ETH</span> <span id="ethBalance" class="v">-</span></div>
    <div class="cell"><span class="k">USDC</span> <span id="usdcBalance" class="v green">-</span></div>
    <div class="cell"><span class="k">Allowance</span> <span id="allowance" class="v">-</span></div>
    <div class="cell"><span class="k">BTC/USD</span> <span id="btcPrice" class="v yellow">-</span></div>
    <div class="cell"><span class="k">Active</span> <span id="activePositions" class="v">0</span></div>
    <div class="cell"><span class="k">Watched</span> <span id="watched" class="v">0</span></div>
    <div class="cell"><span class="k">Auctions</span> <span id="auctionsSeen" class="v">0</span></div>
    <div class="cell"><span class="k">Opened</span> <span id="opened" class="v">0</span></div>
    <div class="cell"><span class="k">Bought</span> <span id="bought" class="v">0</span></div>
    <div class="cell" style="grid-column: 1 / -1;"><span class="k">Wallet</span> <span id="account" class="v">-</span></div>
    <div class="cell" style="grid-column: 1 / -1;"><span class="k">BTC payout →</span> <span id="recipient" class="v">-</span></div>
  </div>
</header>
<section>
  <h2>Positions &amp; Auctions</h2>
  <table>
    <thead><tr><th>Type</th><th>Id</th><th>Detail</th><th>Status</th><th>Action</th></tr></thead>
    <tbody id="monitor"><tr><td colspan="5" class="empty">waiting for first poll…</td></tr></tbody>
  </table>
</section>
<div id="feedWrap">
  <section><h2>Feed</h2></section>
  <div id="feed"></div>
</div>
<script>
  var $ = function (id) { return document.getElementById(id); };
  var STATUS_FIELDS = ["network","market","mode","cycle","nextPollIn","ethBalance","usdcBalance",
    "allowance","btcPrice","activePositions","watched","auctionsSeen","opened","bought","account","recipient"];
  function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }

  var es = new EventSource("/events");
  es.addEventListener("status", function (ev) {
    var s = JSON.parse(ev.data);
    STATUS_FIELDS.forEach(function (f) { if ($(f) && s[f] !== undefined) $(f).textContent = s[f]; });
    $("chain").textContent = s.chainId ? "(chain " + s.chainId + ")" : "";
    var mode = $("mode"); mode.className = "v " + (s.mode === "LIVE" ? "mode-LIVE" : "mode-DRY");
    $("dot").className = "dot on";
  });
  es.addEventListener("monitor", function (ev) {
    var rows = JSON.parse(ev.data);
    var tb = $("monitor");
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">no positions on watch and no live auctions this cycle</td></tr>'; return; }
    tb.innerHTML = rows.map(function (r) {
      return '<tr class="' + (r.color || "") + '"><td>' + esc(r.kind) + '</td><td>' + esc(r.id) +
        '</td><td class="detail">' + esc(r.detail) + '</td><td>' + esc(r.status) + '</td><td>' + esc(r.action) + '</td></tr>';
    }).join("");
  });
  var feed = $("feed");
  es.addEventListener("log", function (ev) {
    var l = JSON.parse(ev.data);
    var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    var t = l.ts.slice(11, 19);
    var div = document.createElement("div");
    div.className = "line";
    div.innerHTML = '<span class="ts">' + t + '</span><span class="tag ' + l.level + '">' +
      l.level.toUpperCase() + '</span><span class="' + l.level + '">' + esc(l.msg) + '</span>';
    feed.appendChild(div);
    while (feed.childNodes.length > 600) feed.removeChild(feed.firstChild);
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  });
  es.onerror = function () { $("dot").className = "dot"; };
</script>
</body>
</html>`;
