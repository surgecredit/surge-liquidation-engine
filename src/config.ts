import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

// Load a network-specific env file first (set by the `testnet`/`mainnet` npm
// scripts), then `.env` as a shared fallback. dotenv never overrides an
// already-set var, so the more specific file and any inline NETWORK win.
//
// The shared `.env` is a real hazard on mainnet: `npm run testnet` begins with
// `cp .env.testnet .env`, so on any machine that has run signet, `.env` holds
// signet keys. A `.env.mainnet` that omits PRIVATE_KEYS then silently inherits
// them, because config prefers the plural form over PRIVATE_KEY. That path
// deploys a mainnet BatchBuyer owned by a signet key -- and `owner` is
// immutable, so the contract is dead on arrival and the mistake is only
// visible after it has cost gas. Refuse instead.
const CROSS_NETWORK_SENSITIVE = [
  "PRIVATE_KEY",
  "PRIVATE_KEYS",
  "BATCH_BUYER_ADDRESS",
  "BATCH_BUYER_ADDRESSES",
  "RECIPIENT_BTC_ADDRESS",
] as const;

{
  const net = (process.env.NETWORK || "").toLowerCase();
  const specific = net === "mainnet" ? ".env.mainnet" : net === "signet" ? ".env.testnet" : undefined;

  // Anything already in the environment was set deliberately (inline, systemd,
  // a shell export) and outranks every file, so it is never a "leak".
  const preset = new Set(Object.keys(process.env));

  const fromSpecific = specific ? (dotenv.config({ path: specific }).parsed ?? {}) : {};
  const fromShared = dotenv.config({ path: ".env" }).parsed ?? {};

  if (net === "mainnet") {
    // Declaring a key in .env.mainnet counts as intentional even when blank --
    // an explicit `PRIVATE_KEYS=` is how you say "single-lane, use the
    // singular form" and still shut the shared file out.
    const leaked = CROSS_NETWORK_SENSITIVE.filter(
      (k) =>
        !preset.has(k) &&
        !(k in fromSpecific) &&
        k in fromShared &&
        (process.env[k] ?? "").trim() !== "",
    );
    if (leaked.length) {
      throw new Error(
        `Refusing to run mainnet with ${leaked.join(", ")} inherited from the shared .env.\n` +
          `.env is a copy of your signet config (npm run testnet does \`cp .env.testnet .env\`), ` +
          `so these are almost certainly testnet values.\n` +
          `Declare each one in .env.mainnet -- an explicit empty value is fine and blocks the fallback.`,
      );
    }
  }
}

import { base, baseSepolia } from "viem/chains";
import { isBtcAddressForChain, getAuctionNetworkConfig, type Network } from "@surgecredit/auction-sdk";
import type { Account, Address, Chain } from "viem";

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v.trim();
}

function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : dflt;
}

function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return dflt;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  throw new Error(`${name} must be true or false, got "${v}"`);
}

function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

export interface Config {
  network: Network;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  account: Account;
  liquidityPoolAddress: Address;
  auctionHouseAddress?: Address;
  /** Deployed BatchBuyer. When set, a multi-auction cycle buys in one tx. */
  batchBuyerAddress?: Address;
  recipientBtcAddress: string;
  dryRun: boolean;
  /**
   * Signing lanes. One key plus its own BatchBuyer per lane.
   *
   * BatchBuyer.owner is immutable and set to msg.sender at construction, so a
   * lane cannot borrow another lane's contract -- run() reverts NotOwner(). Each
   * additional key therefore needs its own deployment, funded and approved.
   *
   * Lanes exist to remove nonce serialization between chunks: one key must wait
   * for nonce N to mine before N+1 is accepted (measured 4.35s per extra chunk),
   * while independent keys submit in parallel and land in the same block.
   */
  lanes: Array<{ account: Account; batchBuyerAddress?: Address }>;
  pollIntervalMs: number;
  scanTimeoutMs: number;
  watchHealthPct: number;
  lookbackBlocks: bigint;
  positionIds: string[];
  maxScanIds: number;
  marketId?: bigint;
  marketName?: string;
  estBtcDeliveryFeeUsd: number;
  targetMarginBps: number;
  requireProfitable: boolean;
  maxSpendUsdc: number;
  unlimitedApproval: boolean;
  logFile?: string;
  noUi: boolean;
  webUi: boolean;
  webPort: number;
  webHost: string;
}

function parseMarketId(raw?: string): bigint | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`MARKET_ID must be an integer, got "${v}"`);
  }
}

export function loadConfig(): Config {
  const network = opt("NETWORK", "signet").toLowerCase();
  if (network !== "signet" && network !== "mainnet") {
    throw new Error(`NETWORK must be "signet" or "mainnet", got "${network}"`);
  }

  const chain = network === "mainnet" ? base : baseSepolia;
  const rpcUrl =
    network === "mainnet"
      ? opt("RPC_URL_MAINNET", "https://mainnet.base.org")
      : opt("RPC_URL_SIGNET", "https://sepolia.base.org");

  // PRIVATE_KEYS (comma-separated) drives multi-lane; PRIVATE_KEY remains the
  // single-lane form and is used as lane 0 when the plural form is absent, so an
  // existing .env keeps working untouched.
  const rawKeys = (process.env.PRIVATE_KEYS?.trim() || req("PRIVATE_KEY"))
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (k.startsWith("0x") ? k : `0x${k}`));
  for (const k of rawKeys) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
      throw new Error(`PRIVATE_KEY(S) entries must be 32-byte hex (0x + 64 hex chars); got a value of length ${k.length}`);
    }
  }
  if (new Set(rawKeys.map((k) => k.toLowerCase())).size !== rawKeys.length) {
    throw new Error("PRIVATE_KEYS contains duplicates; lanes must be distinct keys or their nonces collide");
  }
  const accounts = rawKeys.map((k) => privateKeyToAccount(k as `0x${string}`));
  const account = accounts[0];

  const net = getAuctionNetworkConfig(network as Network);
  // NB: coerce "" to undefined. An empty LIQUIDITY_POOL_ADDRESS= line must fall
  // back to the network default, but `"" ?? net` would keep the empty string.
  const poolOverride = process.env.LIQUIDITY_POOL_ADDRESS?.trim() || undefined;
  if (poolOverride && !/^0x[0-9a-fA-F]{40}$/.test(poolOverride)) {
    throw new Error(`LIQUIDITY_POOL_ADDRESS must be a 20-byte address, got "${poolOverride}"`);
  }
  const liquidityPoolAddress = (poolOverride as Address) ?? net.liquidityPoolAddress;

  // NB: the SDK's built-in auctionHouseAddress for signet is stale — it points
  // at a dead AuctionHouse that the (correct) vaultManagerAddress does not
  // trust. checkHealth() opens auctions on the house the VaultManager trusts,
  // but getAuction()/listAuctions()/buy() were querying the dead one, so the
  // engine never saw the resulting auction and kept re-calling checkHealth on
  // positions that were already in liquidation. Override until the SDK ships
  // a fix.
  const houseOverride = process.env.AUCTION_HOUSE_ADDRESS?.trim() || undefined;
  if (houseOverride && !/^0x[0-9a-fA-F]{40}$/.test(houseOverride)) {
    throw new Error(`AUCTION_HOUSE_ADDRESS must be a 20-byte address, got "${houseOverride}"`);
  }
  const auctionHouseAddress = (houseOverride as Address) ?? undefined;

  // Optional: a deployed BatchBuyer (see src/deploy-batch-buyer.ts). With it
  // set, buys for a multi-auction cycle go out as a single transaction instead
  // of one per auction. Unset, the engine keeps its per-transaction path.
  const batchBuyer = process.env.BATCH_BUYER_ADDRESS?.trim() || undefined;
  if (batchBuyer && !/^0x[0-9a-fA-F]{40}$/.test(batchBuyer)) {
    throw new Error(`BATCH_BUYER_ADDRESS must be a 20-byte address, got "${batchBuyer}"`);
  }
  const batchBuyerAddress = (batchBuyer as Address) ?? undefined;

  // One BatchBuyer per lane, in the same order as the keys. Falls back to the
  // singular BATCH_BUYER_ADDRESS for lane 0 so single-lane setups are unchanged.
  const rawBuyers = (process.env.BATCH_BUYER_ADDRESSES?.trim() || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  for (const a of rawBuyers) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      throw new Error(`BATCH_BUYER_ADDRESSES entries must be 20-byte addresses; got "${a}"`);
    }
  }
  const buyers: Array<Address | undefined> = rawBuyers.length ? (rawBuyers as Address[]) : [batchBuyerAddress];
  if (accounts.length > 1 && buyers.length !== accounts.length) {
    // Refuse rather than silently running fewer lanes: a lane without its own
    // BatchBuyer cannot transact at all (run() is onlyOwner against an immutable
    // owner), and discovering that mid-liquidation is the expensive way to learn it.
    throw new Error(
      `Lane mismatch: ${accounts.length} key(s) in PRIVATE_KEYS but ${buyers.length} address(es) in ` +
        `BATCH_BUYER_ADDRESSES. Each key needs its own BatchBuyer -- owner is immutable, so a lane ` +
        `cannot use another lane's contract.`,
    );
  }
  const lanes = accounts.map((a, i) => ({ account: a, batchBuyerAddress: buyers[i] }));

  const recipientBtcAddress = req("RECIPIENT_BTC_ADDRESS");
  if (!isBtcAddressForChain(recipientBtcAddress, chain.id)) {
    throw new Error(
      `RECIPIENT_BTC_ADDRESS "${recipientBtcAddress}" is not a valid ${
        network === "mainnet" ? "mainnet" : "testnet"
      } Bitcoin address for ${network}. Seized BTC sent to a wrong-network address is unspendable.`,
    );
  }

  const positionIds = opt("POSITION_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of positionIds) {
    try {
      BigInt(id);
    } catch {
      throw new Error(`POSITION_IDS contains a non-integer id: "${id}"`);
    }
  }

  return {
    network: network as Network,
    chain,
    chainId: chain.id,
    rpcUrl,
    account,
    liquidityPoolAddress,
    // NB: previously computed but never returned, so AUCTION_HOUSE_ADDRESS was
    // silently ignored and the engine always fell back to the SDK constant.
    auctionHouseAddress,
    batchBuyerAddress: batchBuyerAddress ?? buyers[0],
    lanes,
    recipientBtcAddress,
    dryRun: bool("DRY_RUN", true),
    pollIntervalMs: Math.max(500, num("POLL_INTERVAL_MS", 15000)),
    scanTimeoutMs: Math.max(5000, num("SCAN_TIMEOUT_MS", 45000)),
    watchHealthPct: num("WATCH_HEALTH_PCT", 88),
    lookbackBlocks: BigInt(Math.trunc(num("LOOKBACK_BLOCKS", 50000))),
    positionIds,
    maxScanIds: Math.max(1, Math.trunc(num("MAX_SCAN_IDS", 5000))),
    marketId: parseMarketId(process.env.MARKET_ID),
    marketName: process.env.MARKET_NAME?.trim() || undefined,
    estBtcDeliveryFeeUsd: num("EST_BTC_DELIVERY_FEE_USD", 1),
    targetMarginBps: num("TARGET_MARGIN_BPS", 0),
    requireProfitable: bool("REQUIRE_PROFITABLE", true),
    maxSpendUsdc: num("MAX_SPEND_USDC", 0),
    unlimitedApproval: bool("UNLIMITED_APPROVAL", false),
    logFile: process.env.LOG_FILE?.trim() || undefined,
    noUi: bool("NO_UI", false),
    webUi: bool("WEB_UI", false),
    webPort: Math.trunc(num("WEB_PORT", 3000)),
    webHost: process.env.WEB_HOST?.trim() || "127.0.0.1",
  };
}
