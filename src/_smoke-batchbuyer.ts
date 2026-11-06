/**
 * One-off: validate a deployed BatchBuyer without needing a live liquidation.
 *
 *   NETWORK=signet npx tsx src/_smoke-batchbuyer.ts 0x<batchBuyer>
 *
 * 1. approve unlimited USDC -> BatchBuyer (skipped if already granted)
 * 2. run([], [], btc, 1 USDC)      -> pull + refund path, onlyOwner
 * 3. run([], [999999], btc, 1 USDC) -> try/catch swallows a failing buy
 */
import { createWalletClient, http, formatUnits, parseUnits, maxUint256, toHex, parseEventLogs, type Address } from "viem";
import { createSurgeAuctionPublicClient, getAuctionNetworkConfig, erc20Abi } from "@surgecredit/auction-sdk";
import { loadConfig } from "./config.js";

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
  { type: "event", name: "Opened", inputs: [{ name: "nftId", type: "uint256", indexed: true }, { name: "ok", type: "bool", indexed: false }] },
  { type: "event", name: "Bought", inputs: [{ name: "nftId", type: "uint256", indexed: true }, { name: "ok", type: "bool", indexed: false }] },
] as const;

async function main() {
  const buyer = (process.argv[2] ?? process.env.BATCH_BUYER_ADDRESS) as Address;
  if (!buyer) throw new Error("pass the BatchBuyer address as argv[2] or set BATCH_BUYER_ADDRESS");

  const cfg = loadConfig();
  if (cfg.network !== "signet") throw new Error("smoke test is signet-only: it approves unlimited USDC and sends real txs");
  const net = getAuctionNetworkConfig(cfg.network);
  const pc = createSurgeAuctionPublicClient(cfg.rpcUrl, cfg.chain);
  const wallet = createWalletClient({ account: cfg.account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const me = cfg.account.address;
  const btc = toHex(cfg.recipientBtcAddress);
  const usdcOf = async (a: Address) =>
    formatUnits(
      (await pc.readContract({ address: net.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint,
      net.usdcDecimals,
    );

  console.log(`BatchBuyer = ${buyer}`);
  console.log(`wallet     = ${me}\n`);

  // ── 1. allowance ──
  const allowance = (await pc.readContract({
    address: net.usdcAddress, abi: erc20Abi, functionName: "allowance", args: [me, buyer],
  })) as bigint;
  if (allowance === 0n) {
    console.log("approving unlimited USDC -> BatchBuyer ...");
    const h = await wallet.writeContract({
      address: net.usdcAddress, abi: erc20Abi, functionName: "approve",
      args: [buyer, maxUint256], chain: cfg.chain, account: cfg.account,
    });
    const r = await pc.waitForTransactionReceipt({ hash: h });
    console.log(`  approve tx ${h} -> ${r.status}`);
  } else {
    console.log(`allowance already set (${allowance})`);
  }

  const budget = parseUnits("1", net.usdcDecimals);

  // ── 2. empty run: pull + refund ──
  console.log(`\n[test 1] run([], [], btc, 1 USDC) -- pull and refund`);
  const before = await usdcOf(me);
  let h = await wallet.writeContract({
    address: buyer, abi: batchBuyerAbi, functionName: "run",
    args: [[], [], btc, budget], chain: cfg.chain, account: cfg.account,
  });
  let r = await pc.waitForTransactionReceipt({ hash: h });
  console.log(`  tx ${h}`);
  console.log(`  status=${r.status} gas=${r.gasUsed}`);
  console.log(`  wallet USDC ${before} -> ${await usdcOf(me)}   (BatchBuyer holds ${await usdcOf(buyer)})`);

  // ── 3. failing buy is swallowed ──
  console.log(`\n[test 2] run([], [999999], btc, 1 USDC) -- try/catch on a bad id`);
  h = await wallet.writeContract({
    address: buyer, abi: batchBuyerAbi, functionName: "run",
    args: [[], [999999n], btc, budget], chain: cfg.chain, account: cfg.account,
  });
  r = await pc.waitForTransactionReceipt({ hash: h });
  console.log(`  tx ${h}`);
  console.log(`  status=${r.status} gas=${r.gasUsed}`);
  for (const lg of parseEventLogs({ abi: batchBuyerAbi, eventName: "Bought", logs: r.logs })) {
    const { nftId, ok } = lg.args as { nftId: bigint; ok: boolean };
    console.log(`  event Bought(nftId=${nftId}, ok=${ok})`);
  }
  console.log(`  wallet USDC now ${await usdcOf(me)}   (BatchBuyer holds ${await usdcOf(buyer)})`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
