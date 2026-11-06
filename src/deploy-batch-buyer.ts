/**
 * Deploy BatchBuyer and print the address to put in BATCH_BUYER_ADDRESS.
 *
 *   forge build && NETWORK=signet npx tsx src/deploy-batch-buyer.ts
 *
 * Reads the same .env the engine does, so it deploys from the engine's wallet
 * to the engine's network. The AuctionHouse is resolved from the VaultManager
 * on-chain rather than the SDK constant, which is known to go stale on signet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, http, type Abi, type Address } from "viem";
import { createSurgeAuctionPublicClient, getAuctionNetworkConfig } from "@surgecredit/auction-sdk";
import { loadConfig } from "./config.js";

const vaultManagerHouseAbi = [
  { type: "function", name: "auctionHouse", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

async function main() {
  const cfg = loadConfig();
  const net = getAuctionNetworkConfig(cfg.network);
  const pc = createSurgeAuctionPublicClient(cfg.rpcUrl, cfg.chain);
  const wallet = createWalletClient({ account: cfg.account, chain: cfg.chain, transport: http(cfg.rpcUrl) });

  const artifactPath = join(process.cwd(), "out", "BatchBuyer.sol", "BatchBuyer.json");
  let artifact: { abi: Abi; bytecode: { object: `0x${string}` } };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error(`Could not read ${artifactPath}. Run \`forge build\` first.`);
  }

  // Prefer the house the VaultManager actually trusts over the SDK constant.
  let house: Address = net.auctionHouseAddress;
  try {
    const onChain = await pc.readContract({
      address: net.vaultManagerAddress,
      abi: vaultManagerHouseAbi,
      functionName: "auctionHouse",
    });
    if (onChain && onChain !== house) {
      console.log(`AuctionHouse: SDK says ${house}, VaultManager trusts ${onChain} -- using the latter.`);
      house = onChain;
    }
  } catch (e) {
    console.log(`auctionHouse() lookup failed, using SDK constant: ${(e as Error).message.split("\n")[0]}`);
  }

  console.log(`network       = ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`deployer      = ${cfg.account.address}`);
  console.log(`auctionHouse  = ${house}`);
  console.log(`vaultManager  = ${net.vaultManagerAddress}`);
  console.log(`usdc          = ${net.usdcAddress}`);

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [house, net.vaultManagerAddress, net.usdcAddress],
    chain: cfg.chain,
    account: cfg.account,
  });
  console.log(`\ndeploy tx     = ${hash}`);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment failed (status ${receipt.status})`);
  }

  console.log(`BatchBuyer    = ${receipt.contractAddress}`);
  console.log(`gas used      = ${receipt.gasUsed}`);
  console.log(`\nAdd to .env:\n  BATCH_BUYER_ADDRESS=${receipt.contractAddress}`);
  console.log(
    `\nThen approve it to pull USDC from this wallet (it returns whatever it\n` +
      `does not spend, so the allowance is the only standing grant):\n` +
      `  cast send ${net.usdcAddress} "approve(address,uint256)" ${receipt.contractAddress} \\\n` +
      `    115792089237316195423570985008687907853269984665640564039457584007913129639935 \\\n` +
      `    --rpc-url <RPC_URL> --interactive`,
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
