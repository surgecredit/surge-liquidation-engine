#!/usr/bin/env bash
# Run the liquidation engine in the background, without systemd.
#
#   ./deploy/start.sh signet            # start (dry run unless --live)
#   ./deploy/start.sh signet --live     # start, transacting
#   ./deploy/start.sh signet stop
#   ./deploy/start.sh signet status
#   ./deploy/start.sh signet logs
#
# The PID guard is the point: two engines on the same PRIVATE_KEYS hand out the
# same nonces and both stall. This refuses to start a second one.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NET="${1:-signet}"; shift || true
case "$NET" in signet|mainnet) ;; *) echo "usage: $0 <signet|mainnet> [start|stop|status|logs] [--live]" >&2; exit 64 ;; esac

CMD="start"; LIVE=0
for a in "$@"; do
  case "$a" in
    start|stop|status|logs) CMD="$a" ;;
    --live) LIVE=1 ;;
    *) echo "unknown arg: $a" >&2; exit 64 ;;
  esac
done

PIDFILE="$ROOT/.engine-$NET.pid"
LOG="$ROOT/engine-$NET.log"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "$CMD" in
  status)
    if alive; then echo "running (pid $(cat "$PIDFILE"))"; tail -1 "$LOG" 2>/dev/null
    else echo "not running"; fi; exit 0 ;;
  logs)
    exec tail -f "$LOG" ;;
  stop)
    if alive; then
      pid="$(cat "$PIDFILE")"
      # index.ts traps SIGTERM: stops the engine, flushes the log, exits 0.
      kill -TERM "$pid"; echo "sent SIGTERM to $pid"
      for _ in $(seq 20); do alive || break; sleep 0.5; done
      alive && { echo "still up, forcing"; kill -9 "$pid"; } || echo "stopped"
      rm -f "$PIDFILE"
    else echo "not running"; rm -f "$PIDFILE"; fi; exit 0 ;;
esac

alive && { echo "already running (pid $(cat "$PIDFILE")) -- refusing to start a second engine." >&2
           echo "Two engines on the same keys collide nonces. Use '$0 $NET stop' first." >&2; exit 1; }

ENVFILE=".env.testnet"; [ "$NET" = mainnet ] && ENVFILE=".env.mainnet"
[ -f "$ENVFILE" ] || { echo "missing $ENVFILE" >&2; exit 66; }

# POSITION_IDS= is forced: a stale pinned list makes the engine blind to every
# auction outside it, which is what stranded 101 signet auctions. DRY_RUN
# defaults on -- inline env beats the file, since dotenv never overrides.
export NETWORK="$NET" NO_UI=1 WEB_UI=0 POSITION_IDS=
[ "$LIVE" -eq 1 ] || export DRY_RUN=true

nohup npx tsx src/index.ts >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "started $NET (pid $(cat "$PIDFILE"))  mode=$([ "$LIVE" -eq 1 ] && echo LIVE || echo 'DRY RUN')  log=$LOG"
echo "  $0 $NET logs    # follow"
echo "  $0 $NET stop    # stop"
