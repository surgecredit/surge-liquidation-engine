# Contributing

Bug reports, fixes and improvements are welcome. Security problems do not go in issues: see
[SECURITY.md](SECURITY.md).

## Before you open a PR

1. `npm ci`
2. `npm run typecheck` passes.
3. A dry run on Base Sepolia still starts and scans (command in [AGENTS.md](AGENTS.md)). It reads
   the chain and sends nothing.
4. If you touched `contracts/BatchBuyer.sol`, `npm run contracts:build` passes.

Test on signet only, with a throwaway wallet. Never put a private key, a funded address's key or an
RPC URL with an API key in a commit, an issue or a PR.

## What a PR should say

- What changed and why, in a few lines.
- Any change to when or how much the engine buys. Changes to `decideBuy()`, the BatchBuyer paths,
  nonce handling or config parsing get the closest review.
- Any new env var, added to `src/config.ts`, `.env.example` and the README table.

The rules in [AGENTS.md](AGENTS.md) apply to every change, whether a person or a coding agent wrote
it. `main` is protected: each PR needs one approving review.

## Licence

By contributing you agree your work is released under the [MIT licence](LICENSE).
