#!/usr/bin/env bash
# One-shot server setup for the Surge liquidation engine.
#
#   sudo ./deploy/bootstrap.sh                        # signet
#   sudo ./deploy/bootstrap.sh --networks signet,mainnet
#
# Idempotent. Config comes from the .env.<network> file already in the
# checkout -- config.ts loads it itself, so there is no secret store and no
# EnvironmentFile.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/surge-liquidation-engine}"
NETWORKS="${NETWORKS:-signet}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE_USER="${SERVICE_USER:-surge}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      APP_DIR="$2";      shift 2 ;;
    --networks) NETWORKS="$2";     shift 2 ;;
    --user)     SERVICE_USER="$2"; shift 2 ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run me with sudo" >&2; exit 1; }
[ -d "$APP_DIR" ] || { echo "no checkout at $APP_DIR (use --dir)" >&2; exit 66; }

for n in ${NETWORKS//,/ }; do
  case "$n" in signet|mainnet) ;; *) echo "bad network '$n'" >&2; exit 64 ;; esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Node ${NODE_MAJOR} LTS"
# Debian/Ubuntu both ship an EOL Node; always take NodeSource.
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  apt-get update && apt-get install -y curl ca-certificates git
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

say "service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

say "dependencies (production only)"
cd "$APP_DIR"
# --omit=dev skips typescript and the type packages.
npm ci --omit=dev

say "git safe.directory"
# We chown the checkout to the service user below, which makes every later
# `sudo git pull` fail with "detected dubious ownership" -- git refuses to
# operate on a repo owned by someone other than the caller. Mark it trusted
# for root so the pull/bootstrap loop keeps working.
if [ -d "$APP_DIR/.git" ]; then
  git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
    || git config --global --add safe.directory "$APP_DIR"
  echo "  trusted $APP_DIR for root"
fi

say "ownership"
# The engine appends liquidation-timings.md into its working directory and
# tsx may cache under node_modules, so the service user owns the checkout.
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
# .git stays root-owned: root runs `git pull` here, so a service user that could
# write .git/config or hooks could run code as root.
[ -d "$APP_DIR/.git" ] && chown -R root:root "$APP_DIR/.git"

missing=0
for n in ${NETWORKS//,/ }; do
  f=".env.testnet"; [ "$n" = mainnet ] && f=".env.mainnet"
  if [ -f "$APP_DIR/$f" ]; then
    chown "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/$f"
    chmod 600 "$APP_DIR/$f"
    echo "  $f ok (owner $SERVICE_USER, mode 600)"
  else
    echo "  MISSING $f -- $n cannot start until it exists" >&2; missing=1
  fi
done

say "systemd unit + log rotation"
sed "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|; \
     s|^ExecStart=.*|ExecStart=${APP_DIR}/node_modules/.bin/tsx src/index.ts|; \
     s|^User=.*|User=${SERVICE_USER}|; s|^Group=.*|Group=${SERVICE_USER}|" \
  "$APP_DIR/deploy/surge-engine@.service" > /etc/systemd/system/surge-engine@.service
chmod 644 /etc/systemd/system/surge-engine@.service
sed "s|/var/www/surge-liquidation-engine|${APP_DIR}|g" "$APP_DIR/deploy/logrotate-surge" > /etc/logrotate.d/surge
chmod 644 /etc/logrotate.d/surge
systemctl daemon-reload

say "cap the journal"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' > /etc/systemd/journald.conf.d/cap.conf
systemctl restart systemd-journald

say "done"
[ "$missing" -eq 1 ] && echo "Create the missing env file(s) first, then:" || echo "Start it:"
for n in ${NETWORKS//,/ }; do
  echo "    sudo systemctl enable --now surge-engine@${n}"
  echo "    journalctl -u surge-engine@${n} -f"
done
echo
echo "The engine reads DRY_RUN from .env.<network>. Set DRY_RUN=true there for"
echo "a first soak, then flip to false and: sudo systemctl restart surge-engine@<net>"
