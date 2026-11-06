# AGENTS.md

Guide for AI coding agents (and people) working in this repo. Read it before changing code.

## What this is

A keeper for Surge Credit liquidation auctions on Base. Each poll it reads position health,
calls `VaultManager.checkHealth` on unhealthy positions to open a Dutch auction, quotes the
auction and buys it with USDC, directly or through `contracts/BatchBuyer.sol`. A buy records a
Bitcoin address that receives the seized BTC later, off-chain.

It spends real money on mainnet. Treat every change to a buy path as safety-critical.

## Layout

| Path | What it holds |
|------|---------------|
| `src/index.ts` | entry point: loads config, starts the terminal and web UI, runs the engine |
| `src/config.ts` | every env var, parsed and validated; refuses bad or cross-network values |
| `src/engine.ts` | the poll loop: discovery, opening auctions, quoting, buy decisions, nonces |
| `src/webui.ts`, `src/ui.ts` | browser (SSE) and terminal dashboards, read-only |
| `src/scan.ts` | one-off health scan, read-only |
| `src/deploy-batch-buyer.ts`, `src/_approve-batchbuyer.ts`, `src/_smoke-batchbuyer.ts` | BatchBuyer helpers; they send real transactions and ignore `DRY_RUN` |
| `contracts/BatchBuyer.sol` | owner-only contract that opens and buys several auctions in one transaction |
| `deploy/` | systemd unit, `bootstrap.sh`, `start.sh`, logrotate, `SETUP.md` |
| `vendor/` | the pinned `@surgecredit/auction-sdk` build the engine is tested against |

## Commands

```bash
npm ci                 # install exactly what the lockfile says
npm run typecheck      # tsc --noEmit; must pass before any commit
npm run contracts:build  # forge build, only if you touch BatchBuyer.sol
```

Dry run against Base Sepolia with a throwaway key. It reads the chain and sends nothing:

```bash
NETWORK=signet DRY_RUN=true NO_UI=1 WEB_UI=0 \
PRIVATE_KEY=0x$(openssl rand -hex 32) \
RECIPIENT_BTC_ADDRESS=tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx \
npx tsx src/index.ts
```

Expect `DRY RUN: no transactions will be sent` and `Poll 1: scanned N position(s)`.

## Rules

- Never commit `.env`, `.env.testnet`, `.env.mainnet` or any private key. Only the `*.example`
  files are tracked, and they stay free of real values.
- Never send a transaction to test a change. Use the dry run above. Do not run the helper
  scripts, `npm run testnet` or `npm run mainnet` unless the user asks.
- `DRY_RUN` defaults to `true`. Every new send path must check `this.cfg.dryRun` first.
- Every buy must go through `decideBuy()` in `src/engine.ts`, which enforces `REQUIRE_PROFITABLE`,
  `MAX_SPEND_USDC` and the wallet balance, and refuses a zero price. The same-transaction
  open-and-buy path cannot quote first, so `sameTxOpenBuy` turns it off whenever either limit is set.
  Keep it that way.
- On a failed read, fail closed: skip the buy or the open for this cycle. Never treat an error as
  "no auction" or "price 0".
- Boolean env vars accept only true/false style values; anything else stops startup. Keep new
  flags on the `bool()` helper in `src/config.ts`.
- New env vars go in `src/config.ts`, `.env.example` and the README table together.
- The web dashboard has no auth and binds to `127.0.0.1`. Do not change the default.
- Do not swap `vendor/` for the npm SDK without a dry-run soak; the builds differ.

## Protocol facts that matter

- Base makes a block every 0.2 s. Any lookback counted in blocks must allow for that.
- Positions are ERC-721s with sequential ids from 1; discovery reads `PositionNFT.totalSupply`.
- `inLiquidation(nftId)` on the VaultManager is the source of truth for "is this in auction".
- The AuctionHouse address is read on-chain from `VaultManager.auctionHouse()` at startup.
- BTC delivery after a buy is done off-chain by the protocol's signer network and is not atomic.

## Security

Report vulnerabilities at https://www.surge.credit/security, never in a public issue (see `SECURITY.md`).
