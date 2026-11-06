import {
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  parseUnits,
  maxUint256,
  toHex,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Account } from "viem";
import {
  SurgeAuctionClient,
  getAuctionNetworkConfig,
  createSurgeAuctionPublicClient,
  SurgeAuctionError,
  vaultManagerAbi,
  liquidityPoolAbi,
  auctionHouseAbi,
  erc20Abi,
  type AuctionNetworkConfig,
  type AuctionSnapshot,
  type BuyQuote,
} from "@surgecredit/auction-sdk";
import type { Config } from "./config.js";
import { Logger, errMsg } from "./logger.js";
import type { Dashboard, MonitorRow, StatusView } from "./ui.js";
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }),
  );
}

// How long to wait on a buy receipt before giving up for this cycle. viem's
// default is 180s; a transaction stranded behind an unfilled nonce would block
// the poll loop for that whole time, freezing position discovery. The next poll
// re-attempts anything unresolved, so failing fast here costs nothing.
const RECEIPT_TIMEOUT_MS = 40_000;

// Positions opened per BatchBuyer.run() transaction. Chunks still land in the
// same block, so this bounds the blast radius of one bad transaction without
// costing latency. ~265k gas per checkHealth, so 25 is ~6.6M -- far inside any
// block limit, with room for the buy batch in the same block.
// Sized so a batch splits into balanced chunks rather than one large one plus a
// remainder: 30 positions becomes 15+15, not 25+5. Same transaction count, but
// the largest single transaction is much smaller, so a failure costs less and
// there is more room under any per-transaction gas cap the RPC imposes.
// Kept small enough that a chunk's gas limit stays well under the per-transaction
// cap the sequencer enforces. Observed directly: a 15-id open chunk (18.3M gas)
// was rejected with "Transaction creation failed" while a 10-id one (12.3M)
// went through, so the ceiling sits between them -- likely 2^24 (16,777,216).
// 10 leaves a wide margin and costs only an extra transaction per batch, and
// chunks land in the same block anyway.
// In-flight cap for the per-position scan reads. High enough to collapse a
// 107-position cycle from ~75s to seconds, low enough that the public RPC does
// not start returning "over rate limit" -- which it does readily.
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY ?? 10);

// How often the engine re-derives "is this position in auction" from the chain
// instead of from its own record of what it opened. inLiquidation() is the
// authoritative answer but costs one read per relevant position per cycle, and
// at a 500ms poll that is the bulk of the scan's request volume. The local set
// is correct for every auction this engine opened; the periodic read is what
// catches the rest -- auctions opened by another actor, and ones that outlived
// a restart. Kept well under the auction lifetime so a missed one is picked up
// long before it expires.
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000);

// How often the wallet-state reads (ETH, USDC, allowance) are refreshed. Only
// the oracle price has to be current every cycle -- it is what moves a position
// across the liquidation threshold. The other three change only when this
// engine itself transacts, and every transacting path already calls
// refreshStatus() when it finishes. Reading all four sequentially every cycle
// cost ~1.3s at ~330ms per round trip, which landed directly in detection
// latency: measured 2.15s from oracle drop to checkHealth submitted, against a
// 3.0s cycle that was mostly this.
const STATUS_REFRESH_MS = Number(process.env.STATUS_REFRESH_MS ?? 15_000);

// How often the nonce cursor is re-derived from the chain. The cursor is
// authoritative between transactions -- takeNonces() advances it locally -- so
// per-cycle syncing bought nothing and cost a round trip. Startup still syncs
// immediately (lastNonceSyncTs starts at 0), and any send failure forces a
// resync so a drifted cursor cannot wedge the loop.
const NONCE_SYNC_MS = Number(process.env.NONCE_SYNC_MS ?? 10_000);

const OPEN_CHUNK_SIZE = 10;

// Open and buy inside a single BatchBuyer.run(). The contract has always
// supported it -- run(openIds, buyIds, ...) opens then buys in the same
// transaction, and its own docstring recommends "openIds plus any already open"
// for buyIds. A comment here previously asserted the opposite without citing a
// measurement. Doing both in one transaction removes an entire block plus a
// receipt round-trip from the critical path: measured 7.22s (10 positions) and
// 7.41s (1 position) between checkHealth and bought when they are separate
// transactions, nearly all of it block time rather than our own work.
// Set OPEN_AND_BUY_SAME_TX=0 to fall back to the two-transaction path.
const SAME_TX_OPEN_BUY = process.env.OPEN_AND_BUY_SAME_TX !== "0";

// A same-tx id costs GAS_PER_OPEN + GAS_PER_BUY (2.1M), so ten would request
// 21.3M and be rejected outright -- the sequencer ceiling sits between the
// 12.3M that was accepted and the 18.3M that was not (likely 2^24). Six ids is
// 12.9M, inside the known-good bracket.
const SAME_TX_CHUNK_SIZE = Number(process.env.SAME_TX_CHUNK_SIZE ?? 6);

// PIPELINE_CHUNKS=1 submits all of a lane's chunks at once instead of waiting
// for each receipt before sending the next.
//
// The serial wait exists because of the note in openViaBatchBuyer about nonce
// ordering, but that note conflates two different things. Measured 2026-08-25
// against base-sepolia-rpc.publicnode.com: nonce N+1 submitted while N is still
// PENDING is accepted, and both land in the SAME block. What is fatal is a nonce
// that is never submitted at all -- then every successor queues behind a gap the
// chain will never fill. That is what cost 94 of 100 positions on the 17-chunk
// run this file already documents.
//
// So pipelining is safe exactly as long as every reserved nonce reaches the
// mempool. When a submit fails, fillNonceGap() below spends the orphaned nonce
// on a 0-value self-transfer so the chunks behind it can mine. Without that
// repair this flag reproduces the 94-position loss, which is why it is opt-in
// and defaults to the old serial behaviour.
//
// Round structure is what this removes: chunks/lanes rounds at ~4s each becomes
// one round, because Base Sepolia's block gas limit (1.2B) is ~111 same-tx
// chunks -- the block was never the constraint.
const PIPELINE_CHUNKS = process.env.PIPELINE_CHUNKS === "1";

// ERC-20 Transfer(address,address,uint256); used to derive what a same-tx run
// actually spent (budget pulled, minus the unspent remainder it refunds).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BUY_CHUNK_SIZE = 10;

// How long an unsold auction's timing entry is kept before being discarded.
// Auctions observed to last 24h (createdAt -> expiresAt), so this only reaps
// entries that are genuinely never going to complete.
const TIMER_TTL_MS = 30 * 60_000;

// How long a submitted checkHealth suppresses re-opening the same position.
// Long enough to cover a few poll cycles (the transaction has to mine before
// inLiquidation() reports true), short enough that a lost open still retries.
const OPEN_COOLDOWN_MS = 90_000;

// Explicit gas for BatchBuyer.run(). eth_estimateGas CANNOT be used here: run()
// wraps each call in try/catch, so the transaction succeeds even when inner
// calls fail. The estimator's binary search therefore converges on the smallest
// gas where the OUTER call succeeds -- which is exactly the amount where the
// last buy runs out of gas and gets swallowed. Observed twice: 3 buys sent,
// 2 landed, the third died inside repayFromLiquidation with [OutOfGas] while
// the transaction still reported success.
//
// Measured on Base Sepolia: ~440k per buy and ~208k per checkHealth when
// batched (warm storage), ~61k of fixed overhead (base + budget pull + refund).
// The multipliers below carry a wide margin -- unused gas is refunded, an
// under-estimate silently drops auctions.
// Traced on Base Sepolia: checkHealth costs 445k-520k (the first in a market is
// dearest -- cold storage), buy ~285k when batched. An earlier 199k/open figure
// came from a single unrepresentative sample and caused opens to run out of gas
// mid-batch. Margins here are deliberately wide: unused gas is refunded, while
// an under-estimate silently drops positions or reverts the whole transaction.
// Traced worst case is ~520k per checkHealth and ~369k per buy. These carry a
// ~2.4x margin on top, because the two failure modes are wildly asymmetric:
// unused gas is refunded and costs nothing, while an under-estimate silently
// drops positions from the batch (or reverts the whole transaction, as the
// 6-position open did at 300k/open). At 0.006 gwei a full 30-position run is
// ~0.0004 ETH, so there is no reason to run these close.
const GAS_BASE = 300_000n;
const GAS_PER_BUY = 900_000n;
const GAS_PER_OPEN = 1_200_000n;

/** BatchBuyer (contracts/BatchBuyer.sol) -- N auctions in one transaction. */
const batchBuyerAbi = [
  {
    type: "function",
    name: "run",
    stateMutability: "nonpayable",
    inputs: [
      { name: "openIds", type: "uint256[]" },
      { name: "buyIds", type: "uint256[]" },
      { name: "btcAddress", type: "bytes" },
      { name: "budget", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "nftId", type: "uint256", indexed: true },
      { name: "ok", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "nftId", type: "uint256", indexed: true },
      { name: "ok", type: "bool", indexed: false },
    ],
  },
] as const;

/** Reject if a promise does not settle within `ms`, so a slow RPC cannot wedge a cycle. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface BuyDecision {
  buy: boolean;
  reason: string;
}

// Position debt (incl. interest) in USDC base units — the ~amount of USDC a buy
// of this position's auction would need. Read on demand for surfaced positions.
const vaultDebtAbi = [
  {
    type: "function",
    name: "getPositionDebtWithInterest",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// The SDK's vaultManagerAbi doesn't expose these getters.
const vaultManagerHouseAbi = [
  {
    type: "function",
    name: "auctionHouse",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  // Authoritative, address-independent source of truth for "already in
  // liquidation" — reads VaultManager's own state directly instead of going
  // through the (possibly misconfigured) AuctionHouse address.
  {
    type: "function",
    name: "inLiquidation",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** LTV% (debt/collateral) from a collateral-ratio %. 0 when cr is 0. */
const ltvFromCrPct = (crPct: number): number => (crPct > 0 ? 10000 / crPct : 0);

// Health zones mirror surge-credit-web: Safe < maxLtv/2; Watch < maxLtv;
// Warning < liquidationLtv; otherwise Danger.
type Zone = { label: string; color: string };
function healthZone(ltv: number, maxLtv: number | undefined, liqLtv: number): Zone {
  if (ltv >= liqLtv) return { label: "Danger", color: "red" };
  if (maxLtv !== undefined) {
    if (ltv >= maxLtv) return { label: "Warning", color: "yellow" };
    if (ltv >= maxLtv / 2) return { label: "Watch", color: "cyan" };
    return { label: "Safe", color: "green" };
  }
  // No maxLtv: fall back to proximity to the liquidation LTV.
  if (ltv >= liqLtv * 0.95) return { label: "Warning", color: "yellow" };
  return { label: "Watch", color: "cyan" };
}

export class Engine {
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly dash: Dashboard;
  private readonly publicClient: PublicClient;
  /**
   * One signing lane: a key, its wallet client, its own BatchBuyer, and its own
   * nonce cursor. Cursors are per-lane because that is the entire point --
   * chunk N+1 on one key waits for chunk N to mine (measured 4.35s), while
   * chunks on different keys are submitted together and land in the same block.
   */
  private readonly lanes: Array<{
    index: number;
    account: Account;
    wallet: WalletClient;
    batchBuyer?: Address;
    nonceCursor: number;
    usdcBalance: number;
  }>;
  /** Lane 0's client. The single-position fallback paths still use it directly. */
  private readonly walletClient: WalletClient;
  private client: SurgeAuctionClient;
  private auctionHouseAddress: Address;
  private readonly net: AuctionNetworkConfig;

  private running = false;
  private cycle = 0;
  private nextPollTs = 0;
  private lastPoll = "-";

  // live status snapshot
  private ethBalance = "-";
  private usdcBalance = 0;
  private allowanceRaw = 0n;
  private btcPrice = 0;

  // counters
  private activePositions = 0;
  private auctionsSeen = 0;
  private watched = 0;
  private opened = 0;
  private bought = 0;
  private readonly handled = new Set<string>();
  // Market max-LTV%, keyed by marketId; thresholds rarely change, so cache them.
  private readonly maxLtvCache = new Map<string, number>();
  // nftId -> data captured when checkHealth() opened its auction; used to
  // build a full record for the timing log (liquidation-timings.md).
  private readonly liqStart = new Map<string, { t0: number; ltvPct?: number; crPct?: number; checkHealthTx?: string }>();
  // nftId -> when we last submitted a checkHealth for it. Opens are not awaited,
  // and VaultManager.inLiquidation() only flips once the transaction mines, so
  // without this the next poll sees the position still "not in auction" and
  // opens it again -- observed three times over for the same ten positions.
  private readonly openSubmitted = new Map<string, number>();
  // nftIds believed to have a live auction right now. Maintained locally --
  // added when checkHealth mines, dropped once bought or once a reconcile finds
  // the auction gone -- so auction discovery no longer needs a per-position
  // inLiquidation() read every cycle. Reconciled against the chain on the
  // RECONCILE_INTERVAL_MS cadence.
  private readonly openAuctionIds = new Set<string>();
  private lastReconcileTs = 0;
  private lastStatusTs = 0;
  private lastNonceSyncTs = 0;
  private readonly timingLogPath = join(process.cwd(), "liquidation-timings.md");

  // Next nonce to hand out. Opens are fire-and-forget, so by the time the buy
  // pass runs in the same cycle the chain still reports the pre-open nonce --
  // both passes would then pick the same one and the second is rejected. One
  // cursor, allocated from by both, removes the overlap.
  private nonceCursor = 0;

  private clock?: NodeJS.Timeout;

  constructor(cfg: Config, log: Logger, dash: Dashboard) {
    this.cfg = cfg;
    this.log = log;
    this.dash = dash;
    this.net = getAuctionNetworkConfig(cfg.network);

    this.publicClient = createSurgeAuctionPublicClient(cfg.rpcUrl, cfg.chain);
    this.lanes = cfg.lanes.map((l, i) => ({
      index: i,
      account: l.account,
      wallet: createWalletClient({ account: l.account, chain: cfg.chain, transport: http(cfg.rpcUrl) }),
      batchBuyer: l.batchBuyerAddress,
      nonceCursor: 0,
      usdcBalance: 0,
    }));
    this.walletClient = this.lanes[0].wallet;
    // Build the client from an explicit config (not just `network`) so an
    // optional LIQUIDITY_POOL_ADDRESS/AUCTION_HOUSE_ADDRESS override can flow
    // through. Defaults come from the SDK's network config, so with no
    // override this matches `network`. This is provisional: start() verifies
    // auctionHouseAddress against the on-chain VaultManager and rebuilds the
    // client if the SDK constant is stale (see resolveAuctionHouseAddress).
    this.auctionHouseAddress = cfg.auctionHouseAddress ?? this.net.auctionHouseAddress;
    this.client = this.buildClient(this.auctionHouseAddress);
  }

  /**
   * Check every lane can actually transact, before a liquidation depends on it.
   *
   * BatchBuyer.run() pulls its budget with transferFrom(owner, ...) BEFORE the
   * try/catch loops, so a lane with no allowance does not lose one buy -- it
   * reverts the whole chunk. And run() is onlyOwner against an immutable owner,
   * so a lane pointed at another lane's contract reverts every time.
   *
   * A lane that fails these checks is dropped from rotation rather than left to
   * fail mid-cycle: losing a chunk to a silent misconfiguration is far worse
   * than running with fewer lanes.
   */
  private async verifyLanes(): Promise<void> {
    const bad: number[] = [];
    await Promise.all(
      this.lanes.map(async (lane) => {
        const who = `lane ${lane.index} (${lane.account.address.slice(0, 10)}…)`;
        if (!lane.batchBuyer) {
          if (this.lanes.length > 1) {
            this.log.error(`${who} has no BatchBuyer; excluded from rotation`);
            bad.push(lane.index);
          }
          return;
        }
        try {
          const [owner, allowance, eth] = await Promise.all([
            this.publicClient.readContract({
              address: lane.batchBuyer,
              abi: [{ name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const,
              functionName: "owner",
            }),
            this.publicClient.readContract({
              address: this.net.usdcAddress,
              abi: erc20Abi,
              functionName: "allowance",
              args: [lane.account.address, lane.batchBuyer],
            }),
            this.publicClient.getBalance({ address: lane.account.address }),
          ]);
          if (String(owner).toLowerCase() !== lane.account.address.toLowerCase()) {
            this.log.error(`${who} does not own its BatchBuyer ${lane.batchBuyer} (owner ${owner}); excluded — run() would revert NotOwner()`);
            bad.push(lane.index);
            return;
          }
          if ((allowance as bigint) === 0n) {
            this.log.error(`${who} has no USDC allowance to ${lane.batchBuyer}; excluded — run() reverts on the budget pull`);
            bad.push(lane.index);
            return;
          }
          if (eth === 0n) {
            this.log.error(`${who} has no ETH for gas; excluded`);
            bad.push(lane.index);
            return;
          }
          this.log.debug(`${who} ok: owns ${lane.batchBuyer.slice(0, 10)}…, allowance set, ${formatEther(eth)} ETH`);
        } catch (e) {
          this.log.warn(`${who} verification failed (${errMsg(e)}); keeping it, but it may fail on send`);
        }
      }),
    );
    if (bad.length) {
      for (const i of bad.sort((a, b) => b - a)) {
        const at = this.lanes.findIndex((l) => l.index === i);
        if (at >= 0 && this.lanes.length > 1) this.lanes.splice(at, 1);
      }
      this.log.warn(`Running with ${this.lanes.length} usable lane(s) after verification`);
    }
  }

  private buildClient(auctionHouseAddress: Address): SurgeAuctionClient {
    return new SurgeAuctionClient({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      config: {
        chain: this.cfg.chain,
        chainId: this.cfg.chainId,
        auctionHouseAddress,
        vaultManagerAddress: this.net.vaultManagerAddress,
        liquidityPoolAddress: this.cfg.liquidityPoolAddress,
        oracleAddress: this.net.oracleAddress,
        usdcAddress: this.net.usdcAddress,
        usdcDecimals: this.net.usdcDecimals,
      },
    });
  }

  // The SDK's per-network auctionHouseAddress constant can go stale (it has
  // for signet): checkHealth() opens auctions on whatever house the
  // VaultManager itself trusts, not on the SDK's constant. If the two
  // diverge, getAuction()/listAuctions()/buy() silently query a dead
  // contract — the engine never sees the resulting auction and keeps
  // re-calling checkHealth on positions that are already in liquidation.
  // Ask the VaultManager directly and rebuild the client if they disagree.
  // An explicit AUCTION_HOUSE_ADDRESS override skips this (assumed correct).
  private async resolveAuctionHouseAddress(): Promise<void> {
    if (this.cfg.auctionHouseAddress) return;
    try {
      const onChain = await this.publicClient.readContract({
        address: this.net.vaultManagerAddress,
        abi: vaultManagerHouseAbi,
        functionName: "auctionHouse",
      });
      if (onChain && onChain.toLowerCase() !== this.net.auctionHouseAddress.toLowerCase()) {
        this.log.warn(
          `SDK auctionHouseAddress (${this.net.auctionHouseAddress}) is stale; ` +
            `VaultManager trusts ${onChain}. Rebuilding client with the on-chain address.`,
        );
        this.auctionHouseAddress = onChain;
        this.client = this.buildClient(onChain);
      }
    } catch (e) {
      this.log.debug(`VaultManager.auctionHouse() lookup failed, keeping SDK default: ${errMsg(e)}`);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.banner();
    await this.resolveAuctionHouseAddress();
    await this.verifyLanes();
    // 1s clock to keep the countdown fresh between polls
    this.clock = setInterval(() => this.renderStatus(), 1000);
    while (this.running) {
      try {
        await this.runCycle();
      } catch (e) {
        this.log.error(`Cycle failed: ${errMsg(e)}`);
      }
      this.nextPollTs = Date.now() + this.cfg.pollIntervalMs;
      this.renderStatus();
      await sleep(this.cfg.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    if (this.clock) clearInterval(this.clock);
  }

  private banner(): void {
    this.log.info(`Liquidation Engine starting on ${this.cfg.network} (chain ${this.cfg.chainId})`);
    if (this.lanes.length > 1) {
      this.log.info(
        `MULTI-LANE: ${this.lanes.length} keys — ` +
          this.lanes
            .map((l) => `L${l.index} ${l.account.address.slice(0, 10)}…→${(l.batchBuyer ?? "none").slice(0, 10)}…`)
            .join("  "),
      );
    } else {
      this.log.info(`SINGLE-LANE: ${this.cfg.account.address}`);
    }
    this.log.info(`Seized BTC will be sent to ${this.cfg.recipientBtcAddress}`);
    this.log.info(
      `Watch >= ${this.cfg.watchHealthPct}% health · poll every ${this.cfg.pollIntervalMs}ms · ` +
        `margin ${this.cfg.targetMarginBps}bps · requireProfitable=${this.cfg.requireProfitable}`,
    );
    if (this.cfg.positionIds.length) {
      this.log.info(`Health-checking explicit positions: ${this.cfg.positionIds.join(", ")}`);
    } else {
      this.log.info(`Auto-discovering all positions on-chain (PositionNFT.totalSupply, cap ${this.cfg.maxScanIds}).`);
    }
    if (this.cfg.marketId !== undefined) {
      this.log.info(`Scoped to market ${this.marketLabel()}.`);
    }
    if (this.cfg.dryRun) {
      this.log.warn("DRY RUN: no transactions will be sent. Set DRY_RUN=false to go live.");
    } else {
      this.log.warn(`LIVE MODE on ${this.cfg.network}: real transactions will be sent from this wallet.`);
    }
  }

  private async runCycle(): Promise<void> {
    this.cycle += 1;
    // Price every cycle; wallet state only on the slower cadence. Both of these
    // used to run unconditionally and sequentially, and together they were the
    // bulk of the cycle -- i.e. the bulk of detection latency.
    await this.refreshStatus(Date.now() - this.lastStatusTs >= STATUS_REFRESH_MS);
    this.expireStaleTimers();
    if (Date.now() - this.lastNonceSyncTs >= NONCE_SYNC_MS) await this.syncNonce();

    const rows: MonitorRow[] = [];

    // ── Part A: auction discovery ──
    // Auctions are found via VaultManager.inLiquidation() during the position
    // scan below, not by replaying event logs.
    //
    // listAuctions() is skipped outright: it walks LOOKBACK_BLOCKS in 2000-block
    // chunks (25 eth_getLogs calls per cycle at the default 50k) and every log
    // it returns fails to decode -- the SDK's LogAuctionCreated ABI marks all six
    // fields non-indexed, while the deployed contract emits two of them indexed
    // (topics=3, data=128 bytes, not topics=1/data=192). Measured: 136 of 136
    // logs undecodable, so viem hands back args === undefined and the SDK's
    // unguarded log.args.nftId throws. Zero useful output for 25 round-trips
    // against the endpoint that has been rate-limiting us. Set SCAN_AUCTION_LOGS=1
    // to re-enable once the SDK ABI is corrected.
    const inAuctionIds = new Set<string>();
    let auctions: AuctionSnapshot[] = [];
    if (process.env.SCAN_AUCTION_LOGS === "1") {
      try {
        auctions = await withTimeout(
          this.client.listAuctions({ onlyBuyable: true, lookbackBlocks: this.cfg.lookbackBlocks }),
          this.cfg.scanTimeoutMs,
          "listAuctions",
        );
      } catch (e) {
        this.log.debug(`listAuctions failed (inLiquidation scan is authoritative anyway): ${errMsg(e)}`);
      }
    }

    // ── Part B: discover positions via the SDK (contract-only listPositions)
    //           and open auctions on any that crossed the liquidation threshold. ──
    let watched = 0;
    let liquidatableCount = 0;
    const toOpen: Array<{ nftId: string; ltvPct: number; crPct: number; debtUsd?: number }> = [];
    try {
      const positions = await withTimeout(
        this.client.listPositions({
          maxScan: this.cfg.maxScanIds,
          ids: this.cfg.positionIds.length ? this.cfg.positionIds : undefined,
          marketId: this.cfg.marketId,
        }),
        this.cfg.scanTimeoutMs,
        "listPositions",
      );
      this.activePositions = positions.length;

      // Only surface positions that matter: liquidatable or on the watch list.
      // (A full mainnet scan can return many healthy positions; showing them all
      // would bury the feed.)
      const relevant = positions.filter(
        (h) => h.liquidatable || ltvFromCrPct(h.collateralRatioPct) >= this.cfg.watchHealthPct,
      );

      // Both per-position reads are issued up front, bounded in flight, rather
      // than one at a time inside the loop. Serially this was two round-trips per
      // position -- ~214 of them at 107 positions, roughly 75s before the cycle
      // could send a single transaction. The cap keeps the burst from tripping
      // the public RPC's rate limiter, which is the other failure mode.
      // On most cycles "in auction?" is answered from openAuctionIds, which the
      // engine maintains itself; only every RECONCILE_INTERVAL_MS is it re-read
      // from the chain. The debt read still goes out every cycle -- it feeds the
      // funding display and cannot be derived locally.
      const reconcile = Date.now() - this.lastReconcileTs >= RECONCILE_INTERVAL_MS;
      const inAuctionBy = new Map<string, boolean>();
      const debtBy = new Map<string, number>();
      await pooled(relevant, SCAN_CONCURRENCY, async (h) => {
        const [auction, debt] = await Promise.all([
          reconcile ? this.isInLiquidation(h.nftId) : Promise.resolve(this.openAuctionIds.has(h.nftId)),
          this.readPositionDebt(h.nftId).catch((e) => {
            this.log.debug(`debt read #${h.nftId} failed: ${errMsg(e)}`);
            return undefined;
          }),
        ]);
        inAuctionBy.set(h.nftId, auction);
        if (debt !== undefined) debtBy.set(h.nftId, debt);
      });
      if (reconcile) {
        this.lastReconcileTs = Date.now();
        // Chain wins over the local record for every position just checked: this
        // both adopts auctions the engine did not open and drops ones that have
        // since resolved.
        for (const [nftId, live] of inAuctionBy) {
          if (live) this.openAuctionIds.add(nftId);
          else this.openAuctionIds.delete(nftId);
        }
      }

      for (const h of relevant) {
        const ltv = ltvFromCrPct(h.collateralRatioPct);
        const liqLtv = ltvFromCrPct(h.thresholdPct);
        // Authoritative on-chain check, not a heuristic off listAuctions/collateral
        // math: listPositions().liquidatable keeps reporting true even after
        // checkHealth() has already opened the auction (it doesn't clear until
        // the auction resolves), so it alone can't distinguish "needs
        // checkHealth" from "already in auction, awaiting buy".
        const inAuction = inAuctionBy.get(h.nftId) ?? false;

        const detail = `LTV ${ltv.toFixed(1)}%  liq at ${liqLtv.toFixed(1)}%  (CR ${h.collateralRatioPct.toFixed(1)}%)`;

        if (inAuction) {
          liquidatableCount += 1;
          // VaultManager.inLiquidation() is the authoritative source for "there
          // is an auction here", and we already paid for the call. Feeding it to
          // the buy pass means discovery no longer depends on listAuctions()
          // scanning event logs -- which throws outright when viem hands back a
          // log it could not decode (SDK reads log.args.nftId unguarded).
          inAuctionIds.add(h.nftId);
          rows.push({ kind: "POS", id: h.nftId, detail, status: "In Auction", action: "buy pass will handle it", color: "cyan" });
          continue;
        }

        const maxLtv = await this.readMaxLtvPct(h.marketId);
        const zone = healthZone(ltv, maxLtv, liqLtv);

        // Funding status: what a buy would need (~debt) vs USDC on hand.
        let fund = `have ${this.usdcBalance.toFixed(0)} USDC`;
        let short = false;
        const debt = debtBy.get(h.nftId);
        if (debt !== undefined) {
          short = debt > this.usdcBalance;
          fund = short
            ? `LOW USDC: need ~${debt.toFixed(0)}, have ${this.usdcBalance.toFixed(0)}`
            : `need ~${debt.toFixed(0)} USDC, have ${this.usdcBalance.toFixed(0)}`;
        }

        if (h.liquidatable) {
          liquidatableCount += 1;
          rows.push({ kind: "POS", id: h.nftId, detail, status: `${zone.label} · LIQUIDATABLE`, action: `open + buy · ${fund}`, color: "red" });
          // Collected, not opened here: opening inline blocked the loop on each
          // receipt, which spaced the auctions ~6s apart. Because an auction is
          // only buyable after a minimum age, that spread meant the youngest was
          // still too young when the buy pass fired and it lost a whole cycle.
          toOpen.push({ nftId: h.nftId, ltvPct: ltv, crPct: h.collateralRatioPct, debtUsd: debtBy.get(h.nftId) });
        } else {
          watched += 1;
          rows.push({
            kind: "POS",
            id: h.nftId,
            detail,
            status: `${zone.label} · LTV ${ltv.toFixed(1)}%`,
            action: fund,
            color: short ? "red" : zone.color,
          });
          this.log.warn(`Position #${h.nftId}: ${zone.label} · LTV ${ltv.toFixed(1)}% (liq at ${liqLtv.toFixed(1)}%). ${fund}.`);
        }
      }
    } catch (e) {
      this.log.error(`Position discovery failed: ${errMsg(e)}`);
    }
    this.watched = watched;

    const justOpened = await this.openAuctions(toOpen);

    // Quote every open auction first (reads only), then submit all the buys
    // together via buyAuctionsBatch instead of one-by-one, so multiple
    // simultaneously-open auctions don't wait on each other's confirmation.
    //
    // `justOpened` is included so a position opened THIS cycle is also bought
    // this cycle. Previously the buy list was built from the scan, which ran
    // before the opens, so every position waited a full poll interval between
    // its auction opening and being bought -- the single largest contributor to
    // end-to-end time. openAuctions only returns ids whose checkHealth actually
    // mined, so the auctions are on-chain by the time they are quoted.
    // checkHealth has mined for these, so their auctions are on-chain now.
    for (const id of justOpened) this.openAuctionIds.add(id);
    // Bought positions stay in `handled` for the life of the process; drop them
    // so they are neither re-quoted nor counted as live auctions. (Deleting
    // during iteration of a Set is well-defined.)
    for (const id of this.openAuctionIds) if (this.handled.has(id)) this.openAuctionIds.delete(id);

    // openAuctionIds is the discovery source now that the per-cycle
    // inLiquidation sweep is gone. inAuctionIds still contributes on reconcile
    // cycles, where it carries fresh on-chain truth.
    const candidateIds = [...new Set([...auctions.map((a) => a.nftId), ...inAuctionIds, ...this.openAuctionIds, ...justOpened])];
    this.auctionsSeen = candidateIds.length;

    // Quotes are issued concurrently rather than one at a time. Serially this
    // was one round-trip per candidate sitting immediately before the buy
    // fires, so the whole batch waited on the sum of them -- and every second
    // of it lands inside the checkHealth->bought window the timing ledger
    // measures. Same in-flight cap as the scan reads, for the same reason: a
    // wider burst is what makes the public RPC start rate-limiting.
    const quoteBy = new Map<string, BuyQuote>();
    const quoteErrBy = new Map<string, string>();
    await pooled(candidateIds, SCAN_CONCURRENCY, async (nftId) => {
      try {
        quoteBy.set(
          nftId,
          await this.client.quoteBuy(nftId, {
            estBtcDeliveryFeeUsd: this.cfg.estBtcDeliveryFeeUsd,
            targetMarginBps: this.cfg.targetMarginBps,
          }),
        );
      } catch (e) {
        quoteErrBy.set(nftId, errMsg(e));
      }
    });

    // Decisions stay sequential and in candidateIds order, so the feed and the
    // buy batch keep the same deterministic ordering they had before.
    const toBuy: Array<{ nftId: string; q: BuyQuote }> = [];
    for (const nftId of candidateIds) {
      const q = quoteBy.get(nftId);
      if (q === undefined) {
        const msg = quoteErrBy.get(nftId) ?? "quote returned no result";
        rows.push({ kind: "AUCTION", id: nftId, detail: msg, status: "quote error", action: "", color: "red" });
        this.log.error(`Auction #${nftId} quote failed: ${msg}`);
        continue;
      }
      const decision = this.decideBuy(q);
      rows.push({
        kind: "AUCTION",
        id: nftId,
        detail:
          `price ${q.priceUsdc.toFixed(2)} USDC  collat ${q.collateralBtc.toFixed(6)}btc ` +
          `($${q.collateralValueUsd.toFixed(2)})  net ${q.netProfitUsd >= 0 ? "+" : ""}${q.netProfitUsd.toFixed(2)}`,
        status: q.profitable ? "profitable" : "unprofitable",
        action: decision.buy ? "BUY" : `skip: ${decision.reason}`,
        color: decision.buy ? "cyan" : q.profitable ? "green" : "gray",
      });
      if (decision.buy) {
        toBuy.push({ nftId, q });
      } else {
        this.log.debug(`Auction #${nftId} skipped: ${decision.reason} (price ${q.priceUsdc.toFixed(2)} USDC)`);
      }
    }
    await this.buyAuctionsBatch(toBuy);

    this.lastPoll = new Date().toTimeString().slice(0, 8);
    this.dash.setMonitor(rows);
    this.renderStatus();

    // Heartbeat: always emit one line per cycle so the feed visibly stays alive,
    // even when there is nothing to act on.
    const scope = this.cfg.marketId !== undefined ? ` in ${this.marketLabel()}` : "";
    if (liquidatableCount === 0 && this.watched === 0 && this.auctionsSeen === 0) {
      this.log.info(`Poll ${this.cycle}: scanned ${this.activePositions} position(s)${scope}, nothing on watch or in auction.`);
    } else {
      this.log.info(
        `Poll ${this.cycle}: ${this.activePositions} active${scope} · ${liquidatableCount} liquidatable · ${this.watched} on watch · ${this.auctionsSeen} auction(s).`,
      );
    }
  }

  /**
   * Same-tx open+buy cannot quote the auction before buying it, so it would skip
   * REQUIRE_PROFITABLE and MAX_SPEND_USDC. Use it only when both are off; otherwise
   * opens go alone and the buys go through decideBuy() the same cycle.
   */
  private get sameTxOpenBuy(): boolean {
    return SAME_TX_OPEN_BUY && !this.cfg.requireProfitable && this.cfg.maxSpendUsdc === 0;
  }

  private decideBuy(q: BuyQuote): BuyDecision {
    // NB: `expired` is deliberately NOT a gate. The AuctionHouse does not enforce
    // expiry in buy() -- simulateContract on auctions 302,911s (3.5 days) past
    // expiresAt succeeds against the live contract. Treating expired as
    // unbuyable stranded 101 signet auctions at the Dutch floor (1.58 USDC for
    // 8458 sats, ~$16.92 of collateral) that were all still purchasable.
    // `active` is the real liveness flag; `won` is the real "someone beat us".
    if (!q.active || q.won) return { buy: false, reason: "not buyable" };
    // The SDK reports a failed price read as 0; never treat that as a real price.
    if (!(q.priceUsdc > 0)) return { buy: false, reason: "price unavailable" };
    if (this.cfg.requireProfitable && !q.profitable) return { buy: false, reason: "unprofitable" };
    if (q.priceUsdc > this.usdcBalance) {
      return { buy: false, reason: `need ${q.priceUsdc.toFixed(2)} USDC, have ${this.usdcBalance.toFixed(2)}` };
    }
    if (this.cfg.maxSpendUsdc > 0 && q.priceUsdc > this.cfg.maxSpendUsdc) {
      return { buy: false, reason: `over MAX_SPEND_USDC (${this.cfg.maxSpendUsdc})` };
    }
    return { buy: true, reason: "" };
  }

  /** Authoritative on-chain check: is this position currently in liquidation/auction? */
  private async isInLiquidation(nftId: string): Promise<boolean> {
    try {
      return await this.publicClient.readContract({
        address: this.net.vaultManagerAddress,
        abi: vaultManagerHouseAbi,
        functionName: "inLiquidation",
        args: [BigInt(nftId)],
      });
    } catch (e) {
      // Unknown counts as "in auction": skip opening it this cycle; the buy path still quotes it.
      this.log.debug(`inLiquidation(${nftId}) check failed: ${errMsg(e)}`);
      return true;
    }
  }

  /**
   * Open every liquidatable position found this cycle, submitting the
   * checkHealth transactions concurrently and NOT waiting for their receipts.
   *
   * Waiting was the old behaviour and it cost ~6s per position, so N positions
   * had their auctions created ~6N seconds apart. That matters because an
   * auction is only buyable after a minimum age (~30-36s observed): a spread of
   * starts means a spread of eligibility, and the youngest auction gets rejected
   * by the buy batch and loses a full poll cycle. Firing them together gives
   * them near-identical creation times, so they become buyable together.
   *
   * Nonces are assigned locally rather than left to the RPC. Concurrent sends
   * that each fetch their own "pending" nonce race and collide -- the same
   * failure that broke the buy path. Assigning up front makes that impossible.
   *
   * Receipts are deliberately not awaited: nothing in this cycle can act on the
   * result anyway, since the new auction cannot be bought until it ages. The
   * next poll picks it up from listAuctions.
   */
  private async openAuctions(items: Array<{ nftId: string; ltvPct: number; crPct: number; debtUsd?: number }>): Promise<string[]> {
    const cooldown = Date.now() - OPEN_COOLDOWN_MS;
    const pending = items.filter((it) => {
      if (this.handled.has(it.nftId)) return false;
      const submittedAt = this.openSubmitted.get(it.nftId);
      if (submittedAt !== undefined && submittedAt > cooldown) {
        this.log.debug(`Skipping open of #${it.nftId}: checkHealth already submitted, awaiting confirmation`);
        return false;
      }
      return true;
    });
    if (pending.length === 0) return [];

    // Marked before dispatch, not after: a submission that throws may still have
    // reached the mempool, and re-opening is the more expensive mistake. The TTL
    // means a genuinely lost open is retried a cycle or two later.
    const now = Date.now();
    for (const it of pending) this.openSubmitted.set(it.nftId, now);

    this.log.action(
      `Opening ${pending.length} auction(s) via checkHealth (fire-and-forget): #${pending.map((p) => p.nftId).join(", #")}`,
    );
    if (this.cfg.dryRun) {
      for (const it of pending) this.log.warn(`[DRY RUN] would call checkHealth(${it.nftId})`);
      return [];
    }

    // One transaction opens the whole set, so every auction shares an identical
    // createdAt. Separate transactions usually land in the same block but are
    // not guaranteed to, and any spread reappears later as one auction being
    // too young for the buy batch. It also avoids firing N concurrent sends at
    // the RPC, which is the burst pattern that has been rejected before.
    if (this.cfg.batchBuyerAddress) {
      return this.openViaBatchBuyer(pending, this.cfg.batchBuyerAddress);
    }

    let nonce: number;
    try {
      nonce = await this.publicClient.getTransactionCount({ address: this.cfg.account.address, blockTag: "latest" });
    } catch (e) {
      this.log.error(`Nonce fetch failed, falling back to sequential opens: ${errMsg(e)}`);
      for (const it of pending) await this.openAuction(it.nftId, { ltvPct: it.ltvPct, crPct: it.crPct });
      return [];
    }

    const slots = pending.map((it, i) => ({ ...it, nonce: nonce + i }));
    await Promise.all(
      slots.map(async (slot) => {
        try {
          const hash = await this.walletClient.writeContract({
            account: this.cfg.account,
            address: this.net.vaultManagerAddress,
            abi: vaultManagerAbi,
            functionName: "checkHealth",
            args: [BigInt(slot.nftId)],
            chain: this.cfg.chain,
            nonce: slot.nonce,
          });
          this.opened += 1;
          // Stamp the clock at submission. The old code stamped it after the
          // receipt, which quietly excluded the time checkHealth itself took --
          // flattering, and not what "how fast did we react" should mean.
          this.liqStart.set(slot.nftId, {
            t0: Date.now(),
            ltvPct: slot.ltvPct,
            crPct: slot.crPct,
            checkHealthTx: hash,
          });
          this.log.success(`checkHealth(${slot.nftId}) submitted (nonce ${slot.nonce}, tx ${hash.slice(0, 10)}…)`);
        } catch (e) {
          this.log.error(`checkHealth(${slot.nftId}) submission failed (nonce ${slot.nonce}): ${errMsg(e)}`);
        }
      }),
    );
    // Fallback path: nothing is awaited here, so nothing is known to be open.
    // The next poll picks these up once inLiquidation() reports them.
    return [];
  }

  /**
   * Open every position in `items` through BatchBuyer.run(), so they all share
   * one block and therefore one creation timestamp.
   *
   * Chunked: a single transaction covering hundreds of positions would put the
   * whole set behind one point of failure, and run() swallows per-id failures
   * rather than reverting, so a bad batch is paid for either way. Chunks still
   * land in the same block, so this costs no latency.
   *
   * budget is 0 -- opening pulls no USDC, so run() skips the transfer entirely.
   */
  private async openViaBatchBuyer(
    items: Array<{ nftId: string; ltvPct: number; crPct: number; debtUsd?: number }>,
    buyer: Address,
  ): Promise<string[]> {
    const chunkSize = this.sameTxOpenBuy ? SAME_TX_CHUNK_SIZE : OPEN_CHUNK_SIZE;
    const chunks: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));

    const btcAddressBytes = toHex(this.cfg.recipientBtcAddress);
    // Ids whose checkHealth transaction actually mined, so the caller can buy
    // them in this same cycle rather than waiting for the next poll.
    const opened: string[] = [];
    // PIPELINE_CHUNKS only: receipt waits deferred so a lane can submit its next
    // chunk immediately. Settled together after every lane has finished sending.
    // Nonce allocation stays lazy either way -- the send is still awaited, so a
    // failed submit rolls its nonce back before the next chunk claims one and no
    // gap can open. That is the distinction from the 17-chunk run that reserved
    // nonces up front and lost 94 positions behind an unfilled 219.
    const pendingSettles: Array<Promise<void>> = [];

    // Chunks are dealt round-robin across lanes. WITHIN a lane they stay
    // sequential -- the RPC rejects a nonce whose predecessor it has not seen,
    // so one key's chunks must mine in order (measured 4.35s apart). ACROSS
    // lanes they are submitted together: separate accounts have independent
    // nonce sequences, so they land in the same block instead of queueing.
    const perLane: Array<(typeof chunks)> = this.lanes.map(() => []);
    chunks.forEach((c, i) => perLane[i % this.lanes.length].push(c));
    if (this.lanes.length > 1) {
      this.log.info(
        `Dispatching ${chunks.length} chunk(s) across ${this.lanes.length} lane(s): ` +
          perLane.map((cs, i) => `L${i}=${cs.length}`).join(" "),
      );
    }

    await Promise.all(
      this.lanes.map(async (lane, li) => {
        const myChunks = perLane[li];
        if (myChunks.length === 0) return;
        const laneBuyer = lane.batchBuyer ?? buyer;
        if (!laneBuyer) {
          this.log.error(`Lane ${li} has no BatchBuyer configured; its ${myChunks.length} chunk(s) are skipped`);
          return;
        }
        for (let i = 0; i < myChunks.length; i++) {
          const chunk = myChunks[i];
          {
        // Allocated one at a time, NOT as a block reserved up front. Reserving
        // the whole run's nonces ahead of time is fatal at scale: if any single
        // chunk fails to submit, its nonce is never consumed and every later
        // chunk sits beyond that gap, so the chain rejects all of them forever.
        // Observed on a 17-chunk run -- chunk 1 mined at nonce 218, chunk 2
        // failed transiently at 219, and chunks 3..17 then marched through
        // 220..234 against a chain still waiting for 219. 94 of 100 positions
        // were lost that way. On failure the cursor is rolled back below so the
        // next chunk reuses the gap instead of stepping past it.
        const useNonce = this.takeNonces(1, lane);
        const ids = chunk.map((it) => BigInt(it.nftId));
        // Budget only matters on the same-tx path: run() pulls it up front and
        // refunds whatever the buys did not spend, so an over-estimate costs
        // nothing while an under-estimate silently drops buys. The auction price
        // tracks the debt (observed 10.50 against 10.00), so 2x the known debt
        // is ample; capped at the wallet balance because transferFrom reverts
        // above it and would take the opens down with it.
        let budgetRaw = 0n;
        if (this.sameTxOpenBuy) {
          const est = chunk.reduce((a, it) => a + (it.debtUsd ?? 0), 0) * 2;
          // Against this lane's own balance: run() pulls from the lane's key, so
          // the aggregate across lanes is not what this transaction can spend.
          const laneFunds = this.lanes.length > 1 ? lane.usdcBalance : this.usdcBalance;
          const capped = Math.max(0, Math.min(est, laneFunds));
          budgetRaw = parseUnits(capped.toFixed(this.net.usdcDecimals), this.net.usdcDecimals);
        }
        const label = this.sameTxOpenBuy ? "Batched open+buy" : "Batched open";
        try {
          const hash = await this.sendWithNonceRetry(`${label} (lane ${li}, nonce ${useNonce}, ${chunk.length} ids)`, () =>
            lane.wallet.writeContract({
              account: lane.account,
              address: laneBuyer,
              abi: batchBuyerAbi,
              functionName: "run",
              args: this.sameTxOpenBuy
                ? [ids, ids, btcAddressBytes, budgetRaw]
                : [ids, [], btcAddressBytes, 0n],
              chain: this.cfg.chain,
              nonce: useNonce,
              gas: this.sameTxOpenBuy
                ? GAS_BASE + BigInt(chunk.length) * (GAS_PER_OPEN + GAS_PER_BUY)
                : GAS_BASE + BigInt(chunk.length) * GAS_PER_OPEN,
            }),
          );
          if (!hash) {
            // Give the nonce back: it was never consumed on-chain, so the next
            // chunk must reuse it or it becomes a permanent gap.
            lane.nonceCursor = useNonce;
            this.lastNonceSyncTs = 0;
            // And un-mark the ids. openSubmitted is set BEFORE dispatch on the
            // theory that a throwing send may still have reached the mempool --
            // true in general, but not here: we only reach this branch when
            // sendWithNonceRetry produced no hash after exhausting its attempts,
            // which is the same evidence that justifies rolling the nonce back.
            // Leaving them marked costs OPEN_COOLDOWN_MS before they can be
            // retried. Measured on the 4-lane run: one chunk failed to submit
            // and its 6 positions waited the full 90s, landing at drop+94.46s
            // while everything else was done by drop+9.61s.
            for (const it of chunk) this.openSubmitted.delete(it.nftId);
            this.log.warn(
              `Lane ${li} chunk not submitted; returning nonce ${useNonce} and clearing ${chunk.length} id(s) for immediate retry`,
            );
            continue;
          }
          // One t0 for the chunk: they are opened by the same transaction, so
          // they genuinely do start their clock at the same instant.
          const t0 = Date.now();
          this.opened += chunk.length;
          for (const it of chunk) {
            this.liqStart.set(it.nftId, { t0, ltvPct: it.ltvPct, crPct: it.crPct, checkHealthTx: hash });
          }
          this.log.success(
            `Opened ${chunk.length} auction(s) in ONE tx (lane ${li}, nonce ${useNonce}, tx ${hash.slice(0, 10)}…): #${chunk.map((c) => c.nftId).join(", #")}`,
          );
          // The auction only exists on-chain once checkHealth mines, and the buy
          // in this same cycle depends on that -- so every chunk is settled,
          // the only question is when. Serially (the default) the next chunk in
          // this lane waits for it, which is what makes latency step by ~4s per
          // round. Under PIPELINE_CHUNKS the wait is deferred and the lane sends
          // its next chunk straight away, so all of them reach the mempool
          // within a block or two instead of one per round.
          const settle = async (): Promise<void> => {
            try {
              const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
              if (receipt.status === "success") {
                // On the same-tx path the buys already happened inside this very
                // transaction, so harvest them here rather than handing the ids to
                // a buy pass that would find the auctions already won. run()
                // swallows per-id failures, so the events are the only per-id
                // truth -- anything not bought falls through to the buy pass.
                const boughtHere = this.sameTxOpenBuy ? this.harvestSameTxBuys(receipt, chunk, hash, budgetRaw) : new Set<string>();
                opened.push(...chunk.map((c) => c.nftId).filter((id) => !boughtHere.has(id)));
              } else this.log.error(`Open chunk reverted (tx ${hash.slice(0, 10)}…); ids retried next poll`);
            } catch (e) {
              // Unconfirmed, not necessarily failed -- leave it for the next poll
              // rather than quoting an auction that may not exist.
              this.log.debug(`Open chunk receipt wait failed, deferring its buys: ${errMsg(e)}`);
            }
          };
          if (PIPELINE_CHUNKS) pendingSettles.push(settle());
          else await settle();
        } catch (e) {
          this.log.error(`Batched open failed (lane ${li}, nonce ${useNonce}, ${chunk.length} ids): ${errMsg(e)}`);
        }
          }
        }
      }),
    );
    // Every lane has now sent everything it had. Under PIPELINE_CHUNKS the
    // receipts are still outstanding, and `opened` is only populated by settle(),
    // so this await is what makes the same-cycle buy path work at all.
    if (pendingSettles.length) {
      this.log.info(`All chunks submitted; awaiting ${pendingSettles.length} receipt(s)`);
      await Promise.all(pendingSettles);
    }
    if (opened.length) this.log.info(`${opened.length} auction(s) confirmed open; buying them this cycle`);
    return opened;
  }

  /**
   * Record the buys that happened inside an open+buy transaction.
   *
   * run() swallows per-id failures, so a successful transaction does not mean
   * every buy landed -- the Bought events are the only per-id truth. Ids that
   * did not sell are returned to the caller's `opened` list so the ordinary buy
   * pass retries them this same cycle.
   *
   * There is no BuyQuote on this path (the auction did not exist when the
   * transaction was built), so the price is derived from what the run actually
   * spent: the budget pulled, less the remainder run() refunds before it ends.
   */
  private harvestSameTxBuys(
    receipt: { logs: readonly unknown[] },
    chunk: Array<{ nftId: string; ltvPct: number; crPct: number; debtUsd?: number }>,
    hash: `0x${string}`,
    budgetRaw: bigint,
  ): Set<string> {
    const bought = new Set<string>();
    try {
      for (const lg of parseEventLogs({ abi: batchBuyerAbi, eventName: "Bought", logs: receipt.logs as never })) {
        const { nftId, ok } = lg.args as { nftId: bigint; ok: boolean };
        if (ok) bought.add(nftId.toString());
      }
    } catch (e) {
      this.log.error(`same-tx Bought decode failed: ${errMsg(e)}`);
      return bought;
    }
    if (bought.size === 0) {
      this.log.warn(
        `Opened ${chunk.length} auction(s) but none sold in the same tx (${hash.slice(0, 10)}…); buy pass will retry them`,
      );
      return bought;
    }

    const me = this.cfg.account.address.toLowerCase();
    let refund = 0n;
    for (const lg of receipt.logs as Array<{ address?: string; topics?: string[]; data?: string }>) {
      if ((lg.address ?? "").toLowerCase() !== this.net.usdcAddress.toLowerCase()) continue;
      if ((lg.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
      const to = `0x${(lg.topics?.[2] ?? "").slice(-40)}`.toLowerCase();
      if (to === me) refund += BigInt(lg.data ?? "0x0");
    }
    const spent = budgetRaw > refund ? budgetRaw - refund : 0n;
    const avg = Number(formatUnits(spent, this.net.usdcDecimals)) / bought.size;

    for (const id of bought) {
      this.bought += 1;
      this.handled.add(id);
      this.openAuctionIds.delete(id);
      this.log.success(
        `BOUGHT #${id} for ~${avg.toFixed(2)} USDC in the SAME tx as its open (${hash.slice(0, 10)}…). ` +
          `BTC payout to ${this.cfg.recipientBtcAddress} pending.`,
      );
      this.recordTiming(id, { priceUsdc: avg }, hash);
    }
    // These buys happened outside buyAuctionsBatch (which refreshes on exit), so
    // invalidate the status snapshot: decideBuy gates on usdcBalance.
    this.lastStatusTs = 0;
    return bought;
  }

  /** Single-position open, awaiting the receipt. Fallback path only. */
  private async openAuction(nftId: string, trigger?: { ltvPct: number; crPct: number }): Promise<void> {
    // A liquidatable position keeps reporting liquidatable until its auction
    // clears, so guard against re-opening: if an auction is already live, leave
    // it for the buy pass instead of spending gas on a redundant checkHealth.
    // Check VaultManager.inLiquidation() first: it's authoritative and doesn't
    // depend on the AuctionHouse address being configured correctly (unlike
    // getAuction(), which silently queries the wrong contract if it isn't).
    if (await this.isInLiquidation(nftId)) {
      this.log.debug(`Position #${nftId} already in liquidation (VaultManager); skipping checkHealth`);
      return;
    }
    try {
      const existing = await this.client.getAuction(nftId);
      // Same reasoning as decideBuy: an expired-but-active auction is still a
      // live, buyable auction, so it counts as "already open" and must not
      // trigger another checkHealth. Only `active` and `won` decide.
      if (existing && existing.active && !existing.won) {
        this.log.debug(`Position #${nftId} already has an open auction; skipping checkHealth`);
        return;
      }
    } catch (e) {
      this.log.debug(`getAuction(${nftId}) pre-check failed: ${errMsg(e)}`);
    }

    this.log.action(`Position #${nftId} is LIQUIDATABLE -> opening auction via checkHealth`);
    if (this.cfg.dryRun) {
      this.log.warn(`[DRY RUN] would call checkHealth(${nftId})`);
      return;
    }
    try {
      const res = await this.client.checkHealth({
        nftId,
        account: this.cfg.account,
        waitForReceipt: true,
      });
      this.opened += 1;
      this.liqStart.set(nftId, {
        t0: Date.now(),
        ltvPct: trigger?.ltvPct,
        crPct: trigger?.crPct,
        checkHealthTx: txHash(res),
      });
      this.log.success(`Auction opened for #${nftId} (${txRef(res)})`);
      // The auction is now live; try to buy it immediately rather than waiting a cycle.
      await this.tryBuyById(nftId);
    } catch (e) {
      if (e instanceof SurgeAuctionError && e.code === "NOT_LIQUIDATABLE") {
        this.log.info(`checkHealth(${nftId}) no-op: position healthy again or auction already open`);
      } else {
        this.log.error(`checkHealth(${nftId}) failed: ${errMsg(e)}`);
      }
    }
  }

  /** Quote + buy a specific nftId if it is a buyable, affordable auction. */
  private async tryBuyById(nftId: string): Promise<void> {
    try {
      const q = await this.client.quoteBuy(nftId, {
        estBtcDeliveryFeeUsd: this.cfg.estBtcDeliveryFeeUsd,
        targetMarginBps: this.cfg.targetMarginBps,
      });
      const decision = this.decideBuy(q);
      if (decision.buy) await this.buyAuction(nftId, q);
      else this.log.debug(`Fresh auction #${nftId} not bought: ${decision.reason}`);
    } catch (e) {
      this.log.debug(`Fresh auction #${nftId} quote failed: ${errMsg(e)}`);
    }
  }

  private async buyAuction(nftId: string, q: BuyQuote): Promise<void> {
    if (this.handled.has(nftId)) return;
    const priceUsdc = q.priceUsdc;

    this.log.action(`Buying auction #${nftId} at ${priceUsdc.toFixed(2)} USDC -> BTC to ${this.cfg.recipientBtcAddress}`);
    if (this.cfg.dryRun) {
      this.log.warn(`[DRY RUN] would approve USDC + buy(#${nftId}) and pay out to ${this.cfg.recipientBtcAddress}`);
      this.handled.add(nftId);
      return;
    }

    try {
      // Ensure allowance covers the price (Dutch price only steps down, so an
      // allowance sized to the current quote stays sufficient through the buy).
      const needRaw = parseUnits(priceUsdc.toFixed(this.net.usdcDecimals), this.net.usdcDecimals);
      if (this.allowanceRaw < needRaw) {
        this.log.info(`Approving USDC to AuctionHouse (${this.cfg.unlimitedApproval ? "unlimited" : priceUsdc.toFixed(2)})`);
        const appr = await this.client.approveUsdc({
          account: this.cfg.account,
          waitForReceipt: true,
          ...(this.cfg.unlimitedApproval ? {} : { amountUsdc: priceUsdc.toFixed(this.net.usdcDecimals) }),
        });
        this.log.success(`Approval confirmed (${txRef(appr)})`);
        // The public RPC can serve a stale read (behind the node that just
        // confirmed the approve tx) for a beat, which makes buy()'s allowance
        // preflight see 0 right after a successful approval. Poll briefly
        // instead of reading once, so we don't burn this buy opportunity.
        for (let attempt = 0; attempt < 5; attempt++) {
          this.allowanceRaw = await this.client.getAllowance(this.cfg.account.address);
          if (this.allowanceRaw >= needRaw) break;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
        }
        if (this.allowanceRaw < needRaw) {
          this.log.warn(`Allowance still stale after approval; will retry buy #${nftId} next cycle.`);
          return;
        }
      }

      const res = await this.client.buy({
        nftId,
        btcAddress: this.cfg.recipientBtcAddress,
        account: this.cfg.account,
        waitForReceipt: true,
      });
      this.bought += 1;
      this.handled.add(nftId);
      this.log.success(`BOUGHT #${nftId} for ~${priceUsdc.toFixed(2)} USDC (${txRef(res)}). BTC payout to ${this.cfg.recipientBtcAddress} pending.`);
      this.recordTiming(nftId, q, txHash(res));
      await this.refreshStatus();
    } catch (e) {
      if (e instanceof SurgeAuctionError) {
        switch (e.code) {
          case "AUCTION_ALREADY_WON":
            this.handled.add(nftId);
            this.log.warn(`Auction #${nftId} already won by another bidder`);
            return;
          case "AUCTION_EXPIRED":
          case "AUCTION_INACTIVE":
          case "AUCTION_NOT_FOUND":
            this.log.warn(`Auction #${nftId} no longer buyable (${e.code})`);
            return;
          case "INSUFFICIENT_USDC_BALANCE":
            this.log.error(`Not enough USDC to buy #${nftId}`);
            return;
          default:
            this.log.error(`Buy #${nftId} failed (${e.code}): ${e.message}`);
            return;
        }
      }
      this.log.error(`Buy #${nftId} failed: ${errMsg(e)}`);
    }
  }

  /**
   * Buy several already-open auctions without waiting for each one's
   * confirmation before submitting the next (the AuctionHouse contract has no
   * native multi-buy function, so this isn't a single atomic transaction --
   * it's N independent `buy()` transactions submitted back-to-back with
   * manually-assigned sequential nonces, instead of sequentially waiting on
   * each receipt like buyAuction() does).
   */
  private async buyAuctionsBatch(items: Array<{ nftId: string; q: BuyQuote }>): Promise<void> {
    const pending = items.filter((it) => !this.handled.has(it.nftId));
    if (pending.length === 0) return;

    // Guard against submitting more buys than the wallet's USDC can actually
    // cover in total (decideBuy() only checks each auction against the full
    // balance individually, not cumulatively across the batch).
    let running = 0;
    const affordable: typeof pending = [];
    for (const it of pending) {
      if (running + it.q.priceUsdc > this.usdcBalance) {
        this.log.warn(`Skipping #${it.nftId} in this batch: cumulative cost would exceed USDC balance (${this.usdcBalance.toFixed(2)})`);
        continue;
      }
      running += it.q.priceUsdc;
      affordable.push(it);
    }
    if (affordable.length === 0) return;
    if (affordable.length === 1) {
      // No pipelining benefit for a single auction; reuse the normal path.
      await this.buyAuction(affordable[0].nftId, affordable[0].q);
      return;
    }

    this.log.action(`Batch-buying ${affordable.length} auctions: #${affordable.map((p) => p.nftId).join(", #")}`);
    if (this.cfg.dryRun) {
      for (const it of affordable) {
        this.log.warn(`[DRY RUN] would approve USDC + buy(#${it.nftId})`);
        this.handled.add(it.nftId);
      }
      return;
    }

    // With a BatchBuyer deployed, every buy in this cycle goes out as one
    // transaction: one nonce, one block. That removes the nonce sequencing
    // below entirely rather than making it more robust.
    if (this.cfg.batchBuyerAddress) {
      await this.buyViaBatchBuyer(affordable, this.cfg.batchBuyerAddress);
      return;
    }

    // One approval covers the whole batch (needs the sum of prices, unless unlimited).
    const totalUsdc = affordable.reduce((sum, it) => sum + it.q.priceUsdc, 0);
    const totalNeedRaw = parseUnits(totalUsdc.toFixed(this.net.usdcDecimals), this.net.usdcDecimals);
    if (this.allowanceRaw < totalNeedRaw) {
      this.log.info(`Approving USDC to AuctionHouse for batch (${this.cfg.unlimitedApproval ? "unlimited" : totalUsdc.toFixed(2)})`);
      try {
        const appr = await this.client.approveUsdc({
          account: this.cfg.account,
          waitForReceipt: true,
          ...(this.cfg.unlimitedApproval ? {} : { amountUsdc: totalUsdc.toFixed(this.net.usdcDecimals) }),
        });
        this.log.success(`Approval confirmed (${txRef(appr)})`);
        for (let attempt = 0; attempt < 5; attempt++) {
          this.allowanceRaw = await this.client.getAllowance(this.cfg.account.address);
          if (this.allowanceRaw >= totalNeedRaw) break;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
        }
        if (this.allowanceRaw < totalNeedRaw) {
          this.log.warn(`Allowance still stale after batch approval; will retry these buys next cycle.`);
          return;
        }
      } catch (e) {
        this.log.error(`Batch approval failed: ${errMsg(e)}`);
        return;
      }
    }

    // Submit every buy tx one after another without waiting for confirmation
    // in between. Letting each writeContract() call auto-fetch its own nonce
    // via the RPC's "pending" tag is NOT safe here: on this public RPC that
    // tag lags behind just-broadcast, unconfirmed transactions, so two calls
    // submitted seconds apart can still race and get the same nonce (seen: the
    // 2nd buy in a batch failing "Missing or invalid parameters" right after
    // the 1st succeeded). Instead, read the confirmed ("latest") nonce once
    // and increment it ourselves locally -- deterministic, no dependency on
    // the RPC noticing our own still-pending transactions.
    let nonce: number;
    try {
      const [latest, pending] = await Promise.all([
        this.publicClient.getTransactionCount({ address: this.cfg.account.address, blockTag: "latest" }),
        this.publicClient.getTransactionCount({ address: this.cfg.account.address, blockTag: "pending" }),
      ]);
      // Start past in-flight txs (e.g. this cycle's opens) so the buys do not reuse their nonces.
      nonce = Math.max(latest, pending);
      if (pending !== latest) {
        this.log.warn(`Nonce: latest=${latest} pending=${pending} -- other tx(s) already in-flight; batch will start at ${nonce}.`);
      }
    } catch (e) {
      this.log.error(`Nonce fetch failed, falling back to sequential buys: ${errMsg(e)}`);
      for (const it of affordable) await this.buyAuction(it.nftId, it.q);
      return;
    }

    const btcAddressBytes = toHex(this.cfg.recipientBtcAddress);

    // Price gas and fees once for the whole batch. Every buy() is near-identical,
    // so estimating per-transaction buys no accuracy and only multiplies RPC
    // calls -- a real cost on a rate-limited public endpoint. Falls back to
    // viem's per-tx estimation if this fails.
    let gas: bigint | undefined;
    let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {};
    try {
      const [est, fee] = await Promise.all([
        this.publicClient.estimateContractGas({
          account: this.cfg.account,
          address: this.auctionHouseAddress,
          abi: auctionHouseAbi,
          functionName: "buy",
          args: [BigInt(affordable[0].nftId), btcAddressBytes],
        }),
        this.publicClient.estimateFeesPerGas(),
      ]);
      // Generous buffer: an under-estimate burns gas and loses the auction,
      // while an over-estimate only reserves headroom the tx never spends.
      gas = (est * 3n) / 2n;
      fees = { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
      this.log.debug(`Batch gas: estimated ${est}, using ${gas}; maxFeePerGas ${fee.maxFeePerGas}`);
    } catch (e) {
      this.log.debug(`Batch gas/fee pre-compute failed, falling back to per-tx estimation: ${errMsg(e)}`);
    }

    // Every buy gets a fixed nonce assigned up front. Nonces must be contiguous
    // for transactions to mine, so a submission that fails leaves a hole that
    // strands every higher nonce behind it. That is why a retry resubmits the
    // SAME nonce the slot was originally given, rather than refetching a
    // "pending" nonce from the RPC -- refetching would skip the hole and leave
    // the rest of the batch permanently unmineable.
    const slots = affordable.map((it, i) => ({
      nftId: it.nftId,
      q: it.q,
      nonce: nonce + i,
      hash: undefined as `0x${string}` | undefined,
    }));

    const submitOne = async (slot: (typeof slots)[number]): Promise<void> => {
      try {
        slot.hash = await this.walletClient.writeContract({
          account: this.cfg.account,
          address: this.auctionHouseAddress,
          abi: auctionHouseAbi,
          functionName: "buy",
          args: [BigInt(slot.nftId), btcAddressBytes],
          chain: this.cfg.chain,
          nonce: slot.nonce,
          ...(gas !== undefined ? { gas } : {}),
          ...fees,
        });
        this.log.info(`Submitted buy #${slot.nftId} (nonce ${slot.nonce}, tx ${slot.hash.slice(0, 10)}…)`);
      } catch (e) {
        this.log.error(`Buy #${slot.nftId} submission failed (nonce ${slot.nonce}): ${errMsg(e)}`);
      }
    };

    // Submit the batch concurrently: the nonces are already fixed, so there is
    // nothing left for a stagger to protect against.
    await Promise.all(slots.map(submitOne));

    // Retry only the holes, each at its original nonce. Two short rounds: the
    // 15s poll cycle is the real backstop, and a longer loop here would just
    // delay the receipt wait -- and the next scan -- for everything else.
    for (let round = 1; round <= 2; round++) {
      const holes = slots.filter((s) => !s.hash);
      if (holes.length === 0) break;
      await sleep(500 * round);
      this.log.warn(`Retry round ${round}: resubmitting ${holes.length} buy(s): #${holes.map((h) => h.nftId).join(", #")}`);
      await Promise.all(holes.map(submitOne));
    }

    const stranded = slots.filter((s) => !s.hash);
    if (stranded.length > 0) {
      const lowest = Math.min(...stranded.map((s) => s.nonce));
      const blocked = slots.filter((s) => s.hash && s.nonce > lowest);
      this.log.warn(
        `Giving up on ${stranded.length} buy submission(s) this cycle: #${stranded.map((s) => s.nftId).join(", #")}` +
          (blocked.length > 0
            ? `. Nonce ${lowest} is unfilled, so #${blocked.map((b) => b.nftId).join(", #")} cannot mine until it is; both will be retried next poll.`
            : ". Will retry next poll."),
      );
    }

    // Wait for all receipts concurrently, with an explicit timeout: a tx
    // stranded behind an unfilled nonce would otherwise hold this cycle open
    // for viem's 180s default and freeze position discovery entirely.
    await Promise.all(
      slots.map(async (s) => {
        if (!s.hash) return;
        try {
          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: s.hash,
            timeout: RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status !== "success") {
            this.log.error(`Buy #${s.nftId} reverted (tx ${s.hash.slice(0, 10)}…)`);
            return;
          }
          this.bought += 1;
          this.handled.add(s.nftId);
          this.log.success(
            `BOUGHT #${s.nftId} for ~${s.q.priceUsdc.toFixed(2)} USDC (tx ${s.hash.slice(0, 10)}…). BTC payout to ${this.cfg.recipientBtcAddress} pending.`,
          );
          this.recordTiming(s.nftId, s.q, s.hash);
        } catch (e) {
          this.log.error(`Buy #${s.nftId} receipt wait failed: ${errMsg(e)}`);
        }
      }),
    );
    await this.refreshStatus();
  }

  /**
   * Buy every auction in `items` with a single BatchBuyer.run() transaction.
   *
   * One nonce and one block for N auctions, so the whole class of problems the
   * per-transaction path has to manage -- nonce gaps, submission races,
   * staggering, resubmits -- cannot arise here.
   *
   * run() swallows individual failures so one dead auction cannot revert the
   * batch, which means the transaction succeeding does NOT mean every buy
   * landed. Per-id outcomes come from the Bought events.
   */
  private async buyViaBatchBuyer(items: Array<{ nftId: string; q: BuyQuote }>, buyer: Address): Promise<void> {
    const grandTotal = items.reduce((sum, it) => sum + it.q.priceUsdc, 0);
    if (grandTotal <= 0) return;

    // Headroom over the quoted total: these are Dutch auctions, so the price can
    // move between the quote and the transaction landing. Unspent budget is
    // returned inside the same transaction, so budgeting high is close to free.
    //
    // The multiplier is capped by the wallet balance. Chunks run concurrently
    // and each pulls its own budget before any of them refunds, so peak usage
    // is the SUM of chunk budgets -- a flat 1.25x per chunk can exceed the
    // balance even when the unmultiplied total fits, and the pull would revert.
    const multiplier = Math.min(1.25, this.usdcBalance / grandTotal);
    const budgetOf = (chunk: typeof items) => {
      const sub = chunk.reduce((sum, it) => sum + it.q.priceUsdc, 0);
      return parseUnits((sub * multiplier).toFixed(this.net.usdcDecimals), this.net.usdcDecimals);
    };

    const chunks: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += BUY_CHUNK_SIZE) chunks.push(items.slice(i, i + BUY_CHUNK_SIZE));

    try {
      await this.ensureBatchBuyerAllowance(
        buyer,
        parseUnits((grandTotal * multiplier).toFixed(this.net.usdcDecimals), this.net.usdcDecimals),
      );
    } catch (e) {
      this.log.error(`BatchBuyer approval failed, leaving buys for next cycle: ${errMsg(e)}`);
      return;
    }

    // Per chunk, not reserved as a block: an unsubmitted chunk in the middle of
    // a reserved range leaves a nonce gap that every later chunk sits beyond,
    // and the chain rejects all of them permanently. Same failure the open path
    // hit on a 17-chunk run.
    let nonceRollback: number | undefined;

    this.log.action(
      `BatchBuyer: buying ${items.length} auction(s) in ${chunks.length} tx: #${items.map((i) => i.nftId).join(", #")}`,
    );

    // Chunks are SUBMITTED one at a time, then their receipts awaited together.
    // This RPC rejects a nonce it has not seen the predecessor for -- submitting
    // chunks concurrently had nonce N accepted while N+1 and N+2 came back
    // "Missing or invalid parameters". Sequential submission costs a round trip
    // per chunk; the transactions still land in the same block.
    const submitted: Array<{ chunk: typeof items; hash: `0x${string}` }> = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const useNonce = nonceRollback ?? this.takeNonces(1);
      nonceRollback = undefined;
      const budgetRaw = budgetOf(chunk);
      try {
        const hash = await this.sendWithNonceRetry(`BatchBuyer (nonce ${useNonce}, ${chunk.length} ids)`, () =>
          this.walletClient.writeContract({
            account: this.cfg.account,
            address: buyer,
            abi: batchBuyerAbi,
            functionName: "run",
            // openIds stays empty: Part A already opened these, and an auction
            // cannot be opened and bought in the same transaction anyway.
            args: [[], chunk.map((it) => BigInt(it.nftId)), toHex(this.cfg.recipientBtcAddress), budgetRaw],
            chain: this.cfg.chain,
            nonce: useNonce,
            gas: GAS_BASE + BigInt(chunk.length) * GAS_PER_BUY,
          }),
        );
        if (!hash) {
          // Never consumed on-chain -- hand it to the next chunk rather than
          // stepping past it.
          nonceRollback = useNonce;
          this.lanes[0].nonceCursor = useNonce;
          this.lastNonceSyncTs = 0;
          continue;
        }
        submitted.push({ chunk, hash });
        // Same nonce constraint as the open path: hold until this one mines,
        // otherwise the next chunk is rejected outright.
        if (ci < chunks.length - 1) {
          try {
            await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
          } catch (e) {
            this.log.debug(`Buy chunk receipt wait failed, continuing: ${errMsg(e)}`);
          }
        }
        this.log.info(
          `BatchBuyer tx ${hash.slice(0, 10)}\u2026 (nonce ${useNonce}, ${chunk.length} ids, budget ${formatUnits(budgetRaw, this.net.usdcDecimals)} USDC)`,
        );
      } catch (e) {
        // Don't abandon the rest: a later chunk can still land, and the ids in
        // this one are picked up again next poll.
        this.log.error(`BatchBuyer submission failed (nonce ${useNonce}, ${chunk.length} ids): ${errMsg(e)}`);
      }
    }

    // Receipts in parallel -- the submissions are already sequenced, and these
    // transactions typically share a block.
    await Promise.all(
      submitted.map(async ({ chunk, hash }) => {
        let receipt;
        try {
          receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        } catch (e) {
          this.log.error(`BatchBuyer receipt wait failed (tx ${hash.slice(0, 10)}\u2026): ${errMsg(e)}`);
          return;
        }
        if (receipt.status !== "success") {
          this.log.error(`BatchBuyer run reverted (tx ${hash.slice(0, 10)}\u2026); auctions left for next cycle`);
          return;
        }

        // run() swallows per-id failures, so a successful transaction does not
        // mean every buy landed. The events are the only per-id truth.
        const bought = new Set<string>();
        try {
          for (const lg of parseEventLogs({ abi: batchBuyerAbi, eventName: "Bought", logs: receipt.logs })) {
            const { nftId, ok } = lg.args as { nftId: bigint; ok: boolean };
            if (ok) bought.add(nftId.toString());
          }
        } catch (e) {
          this.log.error(`BatchBuyer event decode failed: ${errMsg(e)}`);
        }

        for (const it of chunk) {
          if (!bought.has(it.nftId)) {
            this.log.warn(`BatchBuyer: #${it.nftId} not bought (auction gone, or price moved past budget); retry next poll`);
            continue;
          }
          this.bought += 1;
          this.handled.add(it.nftId);
          this.log.success(
            `BOUGHT #${it.nftId} for ~${it.q.priceUsdc.toFixed(2)} USDC (tx ${hash.slice(0, 10)}\u2026). BTC payout to ${this.cfg.recipientBtcAddress} pending.`,
          );
          this.recordTiming(it.nftId, it.q, hash);
        }
      }),
    );
    await this.refreshStatus();
  }

  /**
   * BatchBuyer pulls USDC from this wallet, so it needs its own allowance --
   * separate from the one the AuctionHouse holds. Approved unlimited once, so
   * no later cycle pays for an approval round-trip before buying.
   */
  private async ensureBatchBuyerAllowance(buyer: Address, need: bigint): Promise<void> {
    const current = (await this.publicClient.readContract({
      address: this.net.usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.cfg.account.address, buyer],
    })) as bigint;
    if (current >= need) return;

    this.log.info(`Approving USDC to BatchBuyer ${buyer} (unlimited, one time)`);
    const hash = await this.walletClient.writeContract({
      account: this.cfg.account,
      address: this.net.usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [buyer, maxUint256],
      chain: this.cfg.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    this.log.success(`BatchBuyer approval confirmed (${hash.slice(0, 10)}…)`);
  }

  /**
   * Drop timing entries for auctions that opened but never sold.
   *
   * liqStart is only cleared when a buy succeeds, so an auction that expires,
   * gets bought by a competing keeper, or is left behind by a restart would sit
   * there for the life of the process. Left alone this grows without bound on a
   * long-running keeper, and a much later buy of the same nftId would log a
   * wildly inflated duration against a stale t0.
   */
  /**
   * Reseed the nonce cursor at the top of a cycle.
   *
   * `pending` accounts for transactions we broadcast but that have not mined --
   * which is exactly the state fire-and-forget opens leave behind. `latest` is
   * the floor in case a replica has not caught up. Taking the max of both keeps
   * the cursor from ever handing back a nonce already in flight.
   */
  private async syncNonce(): Promise<void> {
    // Every lane at once: they are independent accounts, so this is one round
    // trip's worth of latency regardless of how many lanes are configured.
    const results = await Promise.all(
      this.lanes.map(async (lane) => {
        try {
          const [latest, pending] = await Promise.all([
            this.publicClient.getTransactionCount({ address: lane.account.address, blockTag: "latest" }),
            this.publicClient.getTransactionCount({ address: lane.account.address, blockTag: "pending" }),
          ]);
          lane.nonceCursor = Math.max(latest, pending);
          return true;
        } catch (e) {
          this.log.debug(`Nonce sync failed for lane ${lane.index}, reusing ${lane.nonceCursor}: ${errMsg(e)}`);
          return false;
        }
      }),
    );
    this.nonceCursor = this.lanes[0].nonceCursor;
    if (results.every(Boolean)) this.lastNonceSyncTs = Date.now();
  }


  /**
   * Submit a transaction, retrying while the RPC claims the nonce is invalid.
   *
   * Waiting for the previous chunk's receipt is not sufficient: the replica that
   * serves eth_sendRawTransaction can lag the one that served the receipt, so
   * N+1 is still rejected ("Missing or invalid parameters") for a second or two
   * after N has demonstrably mined. Retrying is the only reliable way through --
   * the nonce is fixed, so a retry is idempotent, never a double-spend.
   */
  private async sendWithNonceRetry(
    label: string,
    send: () => Promise<`0x${string}`>,
    tries = 5,
  ): Promise<`0x${string}` | undefined> {
    let last = "";
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await send();
      } catch (e) {
        last = errMsg(e);
        if (!/Missing or invalid parameters|nonce|already known|replacement/i.test(last)) {
          this.log.error(`${label} failed: ${last}`);
          return undefined;
        }
        await sleep(1500 * (attempt + 1));
      }
    }
    this.log.error(`${label} failed after ${tries} attempts: ${last}`);
    // Whatever went wrong, the cursor is suspect now -- force a resync on the
    // next cycle instead of waiting out NONCE_SYNC_MS with a possibly stale one.
    this.lastNonceSyncTs = 0;
    return undefined;
  }

  /** Reserve `count` consecutive nonces and return the first. */
  private takeNonces(count: number, lane = this.lanes[0]): number {
    const start = lane.nonceCursor;
    lane.nonceCursor += count;
    if (lane.index === 0) this.nonceCursor = lane.nonceCursor;
    return start;
  }

  private expireStaleTimers(): void {
    const now = Date.now();
    const cutoff = now - TIMER_TTL_MS;
    for (const [nftId, start] of this.liqStart) {
      if (start.t0 < cutoff) {
        this.liqStart.delete(nftId);
        this.log.debug(`Timing entry for #${nftId} expired unbought after ${(TIMER_TTL_MS / 60000).toFixed(0)}m`);
      }
    }
    const openCutoff = now - OPEN_COOLDOWN_MS;
    for (const [nftId, at] of this.openSubmitted) {
      if (at < openCutoff) this.openSubmitted.delete(nftId);
    }
  }

  /**
   * Append a checkHealth -> bought timing row to `liquidation-timings.md`.
   * No-op if this buy wasn't preceded by a checkHealth() call we timed this
   * session (e.g. buying an auction opened before the engine started, or in
   * a prior run).
   */
  private recordTiming(nftId: string, q: Partial<BuyQuote>, buyTx?: string): void {
    const start = this.liqStart.get(nftId);
    if (start === undefined) return;
    this.liqStart.delete(nftId);
    const elapsedMs = Date.now() - start.t0;
    if (!existsSync(this.timingLogPath)) {
      writeFileSync(
        this.timingLogPath,
        "# Liquidation Timing Log\n\n" +
          "One row per position bought out of liquidation this session.\n\n" +
          "| nftId | LTV% @trigger | CR% @trigger | checkHealth->bought (s) | price (USDC) | collateral (BTC) | collateral value (USD) | net profit (USD) | checkHealth tx | buy tx | bought at |\n" +
          "|---|---|---|---|---|---|---|---|---|---|---|\n",
      );
    }
    const fmt = (n: number | undefined, d = 2) => (n === undefined ? "-" : n.toFixed(d));
    appendFileSync(
      this.timingLogPath,
      `| ${nftId} | ${fmt(start.ltvPct, 1)} | ${fmt(start.crPct, 1)} | ${(elapsedMs / 1000).toFixed(2)} | ` +
        `${fmt(q.priceUsdc)} | ${fmt(q.collateralBtc, 6)} | ${fmt(q.collateralValueUsd)} | ${fmt(q.netProfitUsd)} | ` +
        `${start.checkHealthTx ?? "-"} | ${buyTx ?? "-"} | ${new Date().toISOString()} |\n`,
    );
    this.log.info(`Timing: #${nftId} checkHealth -> bought in ${(elapsedMs / 1000).toFixed(2)}s (logged to ${this.timingLogPath})`);
  }

  /** Market max-borrow LTV% (the "Warning" boundary), cached per market. */
  private async readMaxLtvPct(marketId: bigint): Promise<number | undefined> {
    const key = marketId.toString();
    const cached = this.maxLtvCache.get(key);
    if (cached !== undefined) return cached;
    try {
      let pct: number;
      if (marketId === maxUint256) {
        // Legacy: getLegacyParams().minCR is a CR bps; convert to an LTV%.
        const legacy = (await this.publicClient.readContract({
          address: this.net.vaultManagerAddress,
          abi: vaultManagerAbi,
          functionName: "getLegacyParams",
        })) as readonly [bigint, bigint, bigint];
        const minCr = legacy[0];
        if (minCr === 0n) return undefined;
        pct = Number(100_000_000n / minCr) / 100;
      } else {
        const market = (await this.publicClient.readContract({
          address: this.cfg.liquidityPoolAddress,
          abi: liquidityPoolAbi,
          functionName: "markets",
          args: [marketId],
        })) as readonly unknown[];
        pct = Number(market[15] as bigint) / 100; // maxLtvBps -> %
      }
      this.maxLtvCache.set(key, pct);
      return pct;
    } catch (e) {
      this.log.debug(`maxLtv read for market ${key} failed: ${errMsg(e)}`);
      return undefined;
    }
  }

  /** Current debt of a position (incl. interest) in whole USDC. */
  private async readPositionDebt(nftId: string): Promise<number> {
    const raw = (await this.publicClient.readContract({
      address: this.net.vaultManagerAddress,
      abi: vaultDebtAbi,
      functionName: "getPositionDebtWithInterest",
      args: [BigInt(nftId)],
    })) as bigint;
    return Number(formatUnits(raw, this.net.usdcDecimals));
  }

  /**
   * Refresh the status snapshot.
   *
   * `full` false reads only the oracle price, which is the one value that can
   * move a position across the liquidation threshold between cycles. ETH, USDC
   * and allowance change only when this engine transacts, and every path that
   * does calls this with the default (full) afterwards.
   *
   * The reads are issued together rather than awaited one by one: they are
   * independent, and sequentially they cost ~1.3s per cycle at ~330ms per round
   * trip -- latency that sat directly in front of position discovery.
   */
  private async refreshStatus(full = true): Promise<void> {
    const addr = this.cfg.account.address;
    const price = this.client
      .getOracleBtcPriceUsd()
      .then((v) => {
        this.btcPrice = v;
      })
      .catch((e) => {
        this.log.debug(`getOracleBtcPriceUsd failed: ${errMsg(e)}`);
      });
    if (!full) {
      await price;
      return;
    }
    this.lastStatusTs = Date.now();
    // Each read keeps its own catch so one failure cannot blank the others --
    // the previous sequential form had that property and it is worth keeping.
    await Promise.all([
      price,
      this.publicClient
        .getBalance({ address: addr })
        .then((wei) => {
          this.ethBalance = `${Number(formatEther(wei)).toFixed(5)}`;
        })
        .catch((e) => {
          this.log.debug(`getBalance failed: ${errMsg(e)}`);
        }),
      // Per lane, because run() pulls its budget from the lane's own key: the
      // aggregate is what decideBuy gates on ("can we afford this at all"),
      // while lane.usdcBalance caps what any single transaction may pull. Left
      // unread these stay 0, the budget floors to 0, run() skips the pull and
      // every buy on that lane fails silently -- so this is not optional.
      Promise.all(
        this.lanes.map((lane) =>
          this.client
            .getUsdcBalance(lane.account.address)
            .then((v) => {
              lane.usdcBalance = v;
            })
            .catch((e) => {
              this.log.debug(`getUsdcBalance failed for lane ${lane.index}: ${errMsg(e)}`);
            }),
        ),
      ).then(() => {
        this.usdcBalance = this.lanes.reduce((a, l) => a + l.usdcBalance, 0);
      }),
      this.client
        .getAllowance(addr)
        .then((v) => {
          this.allowanceRaw = v;
        })
        .catch((e) => {
          this.log.debug(`getAllowance failed: ${errMsg(e)}`);
        }),
    ]);
  }

  private marketLabel(): string {
    if (this.cfg.marketId === undefined) return "all markets";
    const id = `#${this.cfg.marketId.toString()}`;
    return this.cfg.marketName ? `${this.cfg.marketName} (${id})` : id;
  }

  private renderStatus(): void {
    const now = Date.now();
    const secs = Math.max(0, Math.ceil((this.nextPollTs - now) / 1000));
    const status: StatusView = {
      network: this.cfg.network,
      chainId: this.cfg.chainId,
      market: this.marketLabel(),
      mode: this.cfg.dryRun ? "DRY RUN" : "LIVE",
      account: this.cfg.account.address,
      ethBalance: this.ethBalance,
      usdcBalance: this.usdcBalance.toFixed(2),
      allowance: `${Number(formatUnits(this.allowanceRaw, this.net.usdcDecimals)).toFixed(2)}`,
      btcPrice: this.btcPrice ? `$${this.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "-",
      recipient: this.cfg.recipientBtcAddress,
      cycle: this.cycle,
      lastPoll: this.lastPoll,
      nextPollIn: `${secs}s`,
      activePositions: this.activePositions,
      auctionsSeen: this.auctionsSeen,
      watched: this.watched,
      opened: this.opened,
      bought: this.bought,
    };
    this.dash.setStatus(status);
  }
}

function txRef(res: unknown): string {
  if (typeof res === "string") return `tx ${res.slice(0, 10)}…`;
  if (res && typeof res === "object" && "transactionHash" in res) {
    const h = (res as { transactionHash: string }).transactionHash;
    return `tx ${h.slice(0, 10)}…`;
  }
  return "sent";
}

/** Full transaction hash for the timing log, or undefined if not available. */
function txHash(res: unknown): string | undefined {
  if (typeof res === "string") return res;
  if (res && typeof res === "object" && "transactionHash" in res) {
    return (res as { transactionHash: string }).transactionHash;
  }
  return undefined;
}
