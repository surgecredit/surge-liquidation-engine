# Surge Liquidation Engine

A headless keeper for [Surge Credit](https://surge.credit) liquidation auctions, built
directly on **`@surgecredit/auction-sdk`**. It runs a single full-screen terminal dashboard
that continuously:

1. Reads the health of the positions you tell it to watch and, when one crosses the
   liquidation threshold, opens a Dutch auction on it (`checkHealth`).
2. Discovers every live auction via the SDK, quotes profitability against the on-chain BTC
   oracle, and buys the ones worth buying with USDC from a local wallet.
3. Records the seized BTC payout address on each buy so collateral is delivered to you.

Works on **signet** (Base Sepolia testnet) and **mainnet** (Base) with a config toggle.

> **Roles are permissionless.** Anyone may call `checkHealth` to open an auction and anyone
> may call `buy` to clear one. This engine does both from one wallet.

## What "liquidation" means here

Surge liquidations are a two-step Dutch auction, not an atomic seize:

- **Open:** `checkHealth(nftId)` on an unhealthy position opens an auction. The collateral for
  sale is fixed at open time.
- **Buy:** `buy(nftId, btcAddress)` pays the current USDC price, retires the debt, and records
  your **Bitcoin** address as the collateral recipient. **BTC delivery is off-chain and not
  atomic** — you pay USDC now and the protocol's signer network broadcasts the BTC to your
  address minutes to hours later. That is a trust assumption on the operator; size exposure to it.

So the payout address you provide is a **BTC address**, not an EVM address. Your EVM wallet
(the `PRIVATE_KEY`) only needs Base ETH for gas and USDC to spend.

## Setup

Requires Node 18+.

```bash
git clone https://github.com/surgecredit/surge-liquidation-engine.git
cd surge-liquidation-engine
npm ci                               # viem, blessed, and the vendored auction SDK

# Testnet (Base Sepolia)
cp .env.testnet.example .env.testnet # fill in PRIVATE_KEY + a tb1... payout
npm run testnet

# Mainnet (Base)
cp .env.mainnet.example .env.mainnet # fill in PRIVATE_KEY + a bc1... payout
npm run mainnet
```

`npm run testnet` forces `NETWORK=signet` and loads `.env.testnet`; `npm run mainnet` forces
`NETWORK=mainnet` and loads `.env.mainnet`. Each falls back to a shared `.env` for any value
not set in the network-specific file, so you can keep separate wallets and payout addresses per
network. `npm start` still works if you prefer a single `.env` with `NETWORK` set inside it.

### Browser dashboard

Add a live web dashboard (same status, positions/auctions table and feed as the terminal)
served over Server-Sent Events:

```bash
npm run testnet:web    # or  npm run mainnet:web
# then open http://localhost:3000
```

It runs **alongside** the terminal UI, needs no build step or framework, and updates live. Set
`WEB_PORT` to change the port, or `WEB_UI=1` in an env file to always enable it. Combine with
`NO_UI=1` to run headless (no terminal takeover) with just the browser view.

The dashboard has no authentication and binds to `127.0.0.1` by default. Set `WEB_HOST` only if
you put it behind something that does authenticate; it shows wallet balances and every action.

### The SDK dependency

The engine was built and tested against a specific build of `@surgecredit/auction-sdk`, vendored
as `vendor/surgecredit-auction-sdk-0.1.0.tgz` (MIT) and installed exactly as npm would install a
registry package. The SDK is also [on npm](https://www.npmjs.com/package/@surgecredit/auction-sdk),
but those builds differ from the vendored one, so switching to `"@surgecredit/auction-sdk": "^0.1.3"`
needs a dry-run soak first.

## Configuration

Everything lives in `.env` (see `.env.example` for the annotated list). The essentials:

| Var | Meaning |
| --- | --- |
| `NETWORK` | `signet` (testnet) or `mainnet` |
| `RPC_URL_SIGNET` / `RPC_URL_MAINNET` | RPC endpoints (public defaults provided) |
| `PRIVATE_KEY` | EVM wallet holding Base ETH (gas) + USDC (to buy) |
| `RECIPIENT_BTC_ADDRESS` | Bitcoin address that receives seized collateral (network-checked) |
| `DRY_RUN` | `true` (default) simulates everything; set `false` to send real txns |
| `POLL_INTERVAL_MS` | How often to poll (default 15000) |
| `WATCH_HEALTH_PCT` | Positions at/above this health % are highlighted (default 88) |
| `POSITION_IDS` | Empty = auto-discover all positions on-chain; or a comma-separated id list to check only those |
| `MAX_SCAN_IDS` | Cap on ids read per poll when auto-discovering (default 5000) |
| `LIQUIDITY_POOL_ADDRESS` | Override the pool used for threshold reads (defaults are baked in; see note) |
| `TARGET_MARGIN_BPS` | Required net profit as bps of collateral value (default 0) |
| `REQUIRE_PROFITABLE` | Only buy auctions the quote marks profitable (default true) |
| `MAX_SPEND_USDC` | Hard per-buy USDC cap (0 = none). Setting it, or `REQUIRE_PROFITABLE`, turns off same-tx open+buy |
| `UNLIMITED_APPROVAL` | Approve unlimited USDC once instead of per-buy (default false) |

### Health %

Health is shown as how close a position is to liquidation: **100% = at the liquidation
threshold** (liquidatable boundary), lower is safer. `WATCH_HEALTH_PCT=88` means "flag anything
that has used up ≥88% of its buffer." The SDK's `isLiquidatable` is the authoritative gate for
actually opening an auction — the percentage is for monitoring.

### Position discovery — contract-only, no indexer

The SDK has no `listPositions`, but discovery does **not** need an indexer. The engine
enumerates positions purely from contracts (`src/engine.ts`):

1. `VaultManager.POSITION_NFT()` resolves the PositionNFT address on-chain.
2. `PositionNFT.totalSupply()` gives the highest id (ids are sequential from 1).
3. One `multicall` of `getCollateralRatio(1..n)` keeps the ids that carry debt.
4. `multicall` `positionMarket` + `markets` / `getLegacyParams` resolves each threshold.

That's ~4 batched calls per poll regardless of position count, immune to VaultManager
migrations (the NFT is a single shared contract), and 100% contract reads. Set `POSITION_IDS`
to check only specific ids instead; raise/lower `MAX_SCAN_IDS` to bound the enumeration.

### Heads-up: signet LiquidityPool address

The auction SDK's packaged **signet** `LiquidityPool` (`0x540B…`) reverts on `markets()`, which
silently breaks the SDK's own `isLiquidatable` / `checkHealth` on testnet for market-based
positions. The engine works around it by constructing the SDK client with an explicit `config`
that injects the known-good pool (`0xed96…`);
override with `LIQUIDITY_POOL_ADDRESS` if needed. Mainnet's packaged address is correct.

## The decision flow, each poll

```
refresh ETH / USDC / allowance / oracle BTC price
discover positions (contract-only multicall)  ->  health per position
for each discovered position:
    if health% >= WATCH_HEALTH_PCT   -> WATCH (log)
    if liquidatable (confirmed by SDK isLiquidatable) -> checkHealth() to open the auction, then try to buy it
for each position already in auction (VaultManager.inLiquidation, read during the scan):
    quoteBuy()  ->  render price / collateral value / net profit
    buy if:  profitable (unless REQUIRE_PROFITABLE=false)
         AND price <= USDC balance
         AND price <= MAX_SPEND_USDC (if set)
    -> approve exact USDC to AuctionHouse, then buy(nftId, RECIPIENT_BTC_ADDRESS)
```

## Safety

- **Starts in `DRY_RUN=true`.** It logs every action it *would* take without sending a single
  transaction. Verify the feed looks right, then set `DRY_RUN=false`.
- Use a **dedicated wallet** funded only with working capital and gas.
- Approvals default to the **exact** price per buy (spender = AuctionHouse). Dutch prices only
  step down, so an exact approval stays sufficient through the buy.
- The optional `BatchBuyer` path is different: it needs a standing unlimited USDC allowance from
  the engine wallet, whatever `UNLIMITED_APPROVAL` says. Only its owner (the deployer) can call
  `run`, and it returns unspent USDC in the same transaction.
- A wrong-network `RECIPIENT_BTC_ADDRESS` is rejected at startup — seized BTC sent to it would
  be unspendable.
- Buying is a **race**: a clean pre-flight can still lose to a faster bidder (`AUCTION_ALREADY_WON`);
  the engine treats that as a normal skip, never a loss.

## Helper scripts

`src/deploy-batch-buyer.ts`, `src/_approve-batchbuyer.ts` and `src/_smoke-batchbuyer.ts` send real
transactions and ignore `DRY_RUN`.

## Controls

- `q` or `Ctrl-C` — quit.
- Mouse / arrow keys — scroll the feed.
- Not a TTY (piped, CI) or `NO_UI=1` — falls back to plain line logging.

## Security

Report vulnerabilities privately to developer@surge.build. See [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE](LICENSE). Provided as is: running a keeper spends real funds, and BTC delivery
after a buy depends on the protocol's signer network.
