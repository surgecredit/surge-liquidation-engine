# Running the liquidation engine on a server

Config lives in `.env.testnet` / `.env.mainnet` in the checkout. They hold private
keys: `chmod 600` them and keep them owned by the service user. `config.ts`
loads it itself via dotenv, so there is no secret store and no
`EnvironmentFile` — what you already have on disk is the config.

Two ways to run it. Pick one.

---

## Option A — systemd (survives crashes and reboots)

The checkout defaults to `/var/www/surge-liquidation-engine`; `bootstrap.sh --dir` rewrites the
unit and logrotate paths to match.

```bash
cd /var/www/surge-liquidation-engine
sudo git pull origin main
sudo ./deploy/bootstrap.sh --networks signet
sudo systemctl enable --now surge-engine@signet
journalctl -u surge-engine@signet -f
```

`bootstrap.sh` installs Node 22 from NodeSource (Debian and Ubuntu both ship an
EOL Node), creates the `surge` service user, runs `npm ci --omit=dev`, chowns
the checkout, installs the unit and log rotation, and caps the journal at 2G.
Idempotent — re-run it after any `git pull`.

Mainnet is the same template once `.env.mainnet` exists:

```bash
sudo systemctl enable --now surge-engine@mainnet
```

## Option B — start.sh (no systemd)

```bash
./deploy/start.sh signet          # dry run
./deploy/start.sh signet logs
./deploy/start.sh signet stop
./deploy/start.sh signet --live
```

Same PID-guard guarantee, no root needed. You give up restart-on-crash and
start-on-reboot.

---

## The one rule

**Only ever run one engine per set of keys.** Two processes sharing
`PRIVATE_KEYS` hand out the same nonces and both stall. systemd gives you this per unit
name; `start.sh` gives it via a PID file. Don't mix the two, and don't run one
locally while the server is live on the same keys.

## Things that will bite you

**`POSITION_IDS`** — a stale pinned list makes the engine blind to every
auction outside it. That is what left 101 signet auctions sitting unbought at
the Dutch floor. Both the unit and `start.sh` force it empty (scan everything);
if you run `tsx` by hand, pass `POSITION_IDS=` yourself.

**`DRY_RUN`** — read from `.env.<network>`. Set it `true` for a first soak,
then flip and restart. Inline env beats the file, since dotenv never overrides
an already-set variable, so `DRY_RUN=true npx tsx src/index.ts` always wins.

**Don't use `npm run testnet`** — it begins with `cp .env.testnet .env`, which
clobbers. Call `tsx src/index.ts` directly, as the unit and `start.sh` do.

**RPC rate limits** — `POLL_INTERVAL_MS=500` with `SCAN_CONCURRENCY=25` is a
lab-burst setting. Run continuously that is ~172,800 scan cycles/day at 25-way
fanout, and public endpoints answer with `Request exceeds defined limit`. A throttled RPC
shows up as slower detection, which is the thing this setup exists to
minimize. Raise `POLL_INTERVAL_MS` until your provider is comfortable.

## The buy ledger

`liquidation-timings.md` is appended in the working directory and is the
durable per-buy record. `recordTiming` only fires for buys preceded by a
`checkHealth` in the same session, so auctions the engine adopts (opened
before it started) do **not** appear — the `[OK] BOUGHT` lines in the log are
the only record of those. Back it up; it does not regenerate.
