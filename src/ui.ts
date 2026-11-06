import blessed from "blessed";
import type { LogEntry, LogLevel } from "./logger.js";

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: "white",
  success: "green",
  warn: "yellow",
  error: "red",
  action: "cyan",
  debug: "gray",
};

const LEVEL_TAG: Record<LogLevel, string> = {
  info: "INFO ",
  success: "OK   ",
  warn: "WATCH",
  error: "ERR  ",
  action: "ACT  ",
  debug: "DBG  ",
};

export interface StatusView {
  network: string;
  chainId: number;
  market: string;
  mode: string; // "LIVE" | "DRY RUN"
  account: string;
  ethBalance: string;
  usdcBalance: string;
  allowance: string;
  btcPrice: string;
  recipient: string;
  cycle: number;
  lastPoll: string;
  nextPollIn: string;
  activePositions: number;
  auctionsSeen: number;
  watched: number;
  opened: number;
  bought: number;
}

export interface MonitorRow {
  kind: string; // POS | AUCTION
  id: string;
  detail: string;
  status: string;
  action: string;
  color?: string;
}

export interface Dashboard {
  logEntry(e: LogEntry): void;
  setStatus(s: StatusView): void;
  setMonitor(rows: MonitorRow[]): void;
  onQuit(cb: () => void): void;
  destroy(): void;
}

function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

/** Full-screen blessed dashboard: status header, live monitor, scrolling feed. */
class BlessedDashboard implements Dashboard {
  private screen: blessed.Widgets.Screen;
  private header: blessed.Widgets.BoxElement;
  private monitor: blessed.Widgets.BoxElement;
  private feed: blessed.Widgets.Log;
  private quitCbs: Array<() => void> = [];

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Liquidation Engine",
      fullUnicode: true,
    });

    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 9,
      tags: true,
      border: { type: "line" },
      label: " engine ",
      style: { border: { fg: "cyan" } },
    });

    this.monitor = blessed.box({
      parent: this.screen,
      top: 9,
      left: 0,
      width: "100%",
      height: 11,
      tags: true,
      border: { type: "line" },
      label: " positions & auctions ",
      style: { border: { fg: "blue" } },
      scrollable: true,
      alwaysScroll: true,
    });

    this.feed = blessed.log({
      parent: this.screen,
      top: 20,
      left: 0,
      width: "100%",
      bottom: 0,
      tags: true,
      border: { type: "line" },
      label: " feed  (q or Ctrl-C to quit) ",
      style: { border: { fg: "green" } },
      scrollback: 2000,
      scrollbar: { ch: " ", style: { bg: "green" } },
      mouse: true,
      keys: true,
      alwaysScroll: true,
    });

    this.screen.key(["q", "C-c"], () => {
      for (const cb of this.quitCbs) cb();
    });

    this.screen.render();
  }

  logEntry(e: LogEntry): void {
    const color = LEVEL_COLOR[e.level];
    const line = `{gray-fg}${fmtTime(e.ts)}{/gray-fg} {${color}-fg}${LEVEL_TAG[e.level]}{/${color}-fg} ${e.msg}`;
    this.feed.log(line);
    this.screen.render();
  }

  setStatus(s: StatusView): void {
    const modeColor = s.mode === "LIVE" ? "red-fg" : "yellow-fg";
    const lines = [
      `  {bold}Network{/bold} {cyan-fg}${s.network}{/cyan-fg} (chain ${s.chainId})     {bold}Market{/bold} {cyan-fg}${s.market}{/cyan-fg}     {bold}Mode{/bold} {${modeColor}}${s.mode}{/}     {bold}Cycle{/bold} ${s.cycle}     {bold}Next poll{/bold} ${s.nextPollIn}`,
      `  {bold}Wallet{/bold}  ${s.account}`,
      `  {bold}ETH{/bold} ${s.ethBalance}    {bold}USDC{/bold} {green-fg}${s.usdcBalance}{/green-fg}    {bold}Allowance{/bold} ${s.allowance}    {bold}BTC/USD{/bold} {yellow-fg}${s.btcPrice}{/yellow-fg}`,
      `  {bold}BTC payout -> {/bold} ${s.recipient}`,
      `  {gray-fg}last poll ${s.lastPoll}   |   active positions ${s.activePositions}   watched ${s.watched}   auctions seen ${s.auctionsSeen}   opened ${s.opened}   bought ${s.bought}{/gray-fg}`,
    ];
    this.header.setContent(lines.join("\n"));
    this.screen.render();
  }

  setMonitor(rows: MonitorRow[]): void {
    const header = `  {bold}{gray-fg}${"TYPE".padEnd(8)}${"ID".padEnd(12)}${"DETAIL".padEnd(58)}${"STATUS".padEnd(16)}ACTION{/gray-fg}{/bold}`;
    const body =
      rows.length === 0
        ? "  {gray-fg}no positions on watch and no live auctions this cycle{/gray-fg}"
        : rows
            .map((r) => {
              const c = r.color ?? "white";
              return `  {${c}-fg}${r.kind.padEnd(8)}${r.id.padEnd(12)}${truncate(r.detail, 57).padEnd(58)}${truncate(r.status, 15).padEnd(16)}${r.action}{/${c}-fg}`;
            })
            .join("\n");
    this.monitor.setContent(`${header}\n${body}`);
    this.screen.render();
  }

  onQuit(cb: () => void): void {
    this.quitCbs.push(cb);
  }

  destroy(): void {
    try {
      this.screen.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** Plain line logger for non-TTY environments (pipes, CI, --no-ui). */
class PlainDashboard implements Dashboard {
  private quitCbs: Array<() => void> = [];

  constructor() {
    process.on("SIGINT", () => {
      for (const cb of this.quitCbs) cb();
    });
  }

  logEntry(e: LogEntry): void {
    // eslint-disable-next-line no-console
    console.log(`${fmtTime(e.ts)} [${LEVEL_TAG[e.level].trim()}] ${e.msg}`);
  }

  setStatus(s: StatusView): void {
    // eslint-disable-next-line no-console
    console.log(
      `${fmtTime(new Date())} [STATUS] cycle=${s.cycle} ${s.network} market=${s.market} ${s.mode} ETH=${s.ethBalance} USDC=${s.usdcBalance} BTC/USD=${s.btcPrice} positions=${s.activePositions} watched=${s.watched} seen=${s.auctionsSeen} opened=${s.opened} bought=${s.bought} next=${s.nextPollIn}`,
    );
  }

  setMonitor(_rows: MonitorRow[]): void {
    /* rows are conveyed through the feed in plain mode */
  }

  onQuit(cb: () => void): void {
    this.quitCbs.push(cb);
  }

  destroy(): void {
    /* nothing to tear down */
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fans every Dashboard call out to several dashboards (e.g. TUI + web). */
export class MultiDashboard implements Dashboard {
  constructor(private readonly targets: Dashboard[]) {}
  logEntry(e: LogEntry): void { for (const t of this.targets) t.logEntry(e); }
  setStatus(s: StatusView): void { for (const t of this.targets) t.setStatus(s); }
  setMonitor(rows: MonitorRow[]): void { for (const t of this.targets) t.setMonitor(rows); }
  onQuit(cb: () => void): void { for (const t of this.targets) t.onQuit(cb); }
  destroy(): void { for (const t of this.targets) t.destroy(); }
}

export function createDashboard(useTui: boolean): Dashboard {
  if (useTui && process.stdout.isTTY) return new BlessedDashboard();
  return new PlainDashboard();
}
