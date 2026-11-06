/**
 * Approve the deployed BatchBuyer to pull USDC from the engine wallet.
 *
 * Required: engine.ts drops any lane whose BatchBuyer has a zero allowance at
 * startup ("has no USDC allowance ...; excluded"), so without this the mainnet
 * run has no usable lane at all. run() refunds whatever it does not spend, so
 * the allowance is the only standing grant.
 */
import { createPublicClient, createWalletClient, http, formatUnits, maxUint256 } from "viem";
import { base } from "viem/chains";
import { getAuctionNetworkConfig, erc20Abi } from "@surgecredit/auction-sdk";
import { loadConfig } from "./config.js";

async function main() {
  const cfg = loadConfig();
  if (cfg.network !== "mainnet") throw new Error(`expected mainnet, got ${cfg.network}`);
  const net = getAuctionNetworkConfig("mainnet");
  const bb = cfg.batchBuyerAddress;
  if (!bb) throw new Error("BATCH_BUYER_ADDRESS is not set in .env.mainnet");

  const pc = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account: cfg.account, chain: base, transport: http(cfg.rpcUrl) });

  const before = (await pc.readContract({
    address: net.usdcAddress, abi: erc20Abi, functionName: "allowance",
    args: [cfg.account.address, bb],
  })) as bigint;
  console.log(`owner       ${cfg.account.address}`);
  console.log(`spender     ${bb}`);
  console.log(`allowance   ${formatUnits(before, net.usdcDecimals)} USDC (before)`);
  if (before > 0n) { console.log("already non-zero; nothing to do."); return; }

  const hash = await wallet.writeContract({
    address: net.usdcAddress, abi: erc20Abi, functionName: "approve",
    args: [bb, maxUint256], chain: base, account: cfg.account,
  });
  console.log(`approve tx  ${hash}`);
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(`status      ${r.status}  gas ${r.gasUsed}`);

  const after = (await pc.readContract({
    address: net.usdcAddress, abi: erc20Abi, functionName: "allowance",
    args: [cfg.account.address, bb],
  })) as bigint;
  console.log(`allowance   ${after === maxUint256 ? "unlimited" : formatUnits(after, net.usdcDecimals)} (after)`);
}
void main().catch((e) => { console.error(String(e).split("\n")[0]); process.exit(1); });
