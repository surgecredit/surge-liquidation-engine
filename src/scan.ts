import {
  SurgeAuctionClient,
  createSurgeAuctionPublicClient,
  getAuctionNetworkConfig,
  type PositionHealth,
} from "@surgecredit/auction-sdk";
import { loadConfig } from "./config.js";

// One-shot, read-only: list active positions across ALL markets, ranked by how
// close they are to liquidation, so you can gauge how much USDC to hold ready.
// Ignores MARKET_ID on purpose (you asked for everything). No writes, no loop.

const MIN_HEALTH = Number(process.env.SCAN_MIN_HEALTH ?? 70); // show >= this health%
const LIMIT = Number(process.env.SCAN_LIMIT ?? 40);

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function marketLabel(p: PositionHealth): string {
  const legacy = (1n << 256n) - 1n;
  return p.marketId === legacy ? "legacy" : p.marketId.toString();
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const net = getAuctionNetworkConfig(cfg.network);
  const publicClient = createSurgeAuctionPublicClient(cfg.rpcUrl, cfg.chain);
  const client = new SurgeAuctionClient({
    publicClient,
    config: {
      chain: cfg.chain,
      chainId: cfg.chainId,
      // NB: cfg.auctionHouseAddress covers the AUCTION_HOUSE_ADDRESS override;
      // see the resolveAuctionHouseAddress note in engine.ts for why the SDK
      // default here can be stale (queries a dead AuctionHouse on signet).
      auctionHouseAddress: cfg.auctionHouseAddress ?? net.auctionHouseAddress,
      vaultManagerAddress: net.vaultManagerAddress,
      liquidityPoolAddress: cfg.liquidityPoolAddress,
      oracleAddress: net.oracleAddress,
      usdcAddress: net.usdcAddress,
      usdcDecimals: net.usdcDecimals,
    },
  });

  process.stdout.write(`Scanning ${cfg.network} (chain ${cfg.chainId}) across all markets… `);
  const positions = await client.listPositions({ maxScan: cfg.maxScanIds }); // onlyActive default, no market filter
  positions.sort((a, b) => b.healthPct - a.healthPct);
  process.stdout.write(`${positions.length} active positions.\n`);

  const liquidatable = positions.filter((p) => p.liquidatable);
  const near = positions.filter((p) => !p.liquidatable && p.healthPct >= MIN_HEALTH);

  console.log(
    `\n${liquidatable.length} liquidatable NOW · ${near.length} within reach (health >= ${MIN_HEALTH}%). ` +
      `Health 100% = at the liquidation threshold.\n`,
  );

  const rows = [...liquidatable, ...near].slice(0, LIMIT);
  if (rows.length === 0) {
    console.log("Nothing near liquidation right now.");
    return;
  }

  console.log(
    "  " +
      pad("#", 4) + pad("NFT", 8) + pad("MARKET", 9) + pad("CR%", 10) + pad("THR%", 10) + pad("HEALTH%", 10) + "STATUS",
  );
  console.log("  " + "-".repeat(60));
  rows.forEach((p, i) => {
    const status = p.liquidatable ? "LIQUIDATABLE" : "near";
    console.log(
      "  " +
        pad(String(i + 1), 4) +
        pad(`#${p.nftId}`, 8) +
        pad(marketLabel(p), 9) +
        pad(p.collateralRatioPct.toFixed(1), 10) +
        pad(p.thresholdPct.toFixed(1), 10) +
        pad(p.healthPct.toFixed(1), 10) +
        status,
    );
  });

  if (liquidatable.length > 0) {
    console.log(
      `\nHeads up: ${liquidatable.length} position(s) already liquidatable. Once auctioned, the buy price starts near the debt and steps down, so keep USDC ready above the largest debt you want to win.`,
    );
  }
}

void main().catch((e) => {
  console.error(`scan failed: ${(e as Error).message}`);
  process.exit(1);
});
