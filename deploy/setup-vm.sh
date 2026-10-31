#!/usr/bin/env bash
# Runs ON the VM (as root). Usage: sudo bash setup-vm.sh <domain>
# Idempotent: safe to run again after every deploy.
set -euo pipefail
DOMAIN="${1:?usage: setup-vm.sh <domain>}"
APP=/opt/fitmirror

export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

id fitmirror >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin fitmirror
mkdir -p "$APP"

# code arrives as /tmp/fitmirror.tar.gz, .env as /tmp/fitmirror.env
tar -xzf /tmp/fitmirror.tar.gz -C "$APP"
if [ -f /tmp/fitmirror.env ]; then
  install -m 600 /tmp/fitmirror.env "$APP/.env"
fi
[ -f "$APP/.env" ] || { echo "Missing $APP/.env (DECART_API_KEYS=...)"; exit 1; }
chown -R fitmirror:fitmirror "$APP"
chmod 600 "$APP/.env"

(cd "$APP" && sudo -u fitmirror npm install --omit=dev --no-audit --no-fund)

PORT="$(grep -E '^PORT=' "$APP/.env" | tail -1 | cut -d= -f2 | tr -d '\r' || true)"
PORT="${PORT:-3001}"
sed -i "s/^Environment=PORT=.*/Environment=PORT=${PORT}/" "$APP/deploy/fitmirror.service"
cp "$APP/deploy/fitmirror.service" /etc/systemd/system/fitmirror.service

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	reverse_proxy localhost:${PORT}
}
CADDY

systemctl daemon-reload
systemctl enable --now fitmirror
systemctl restart fitmirror
systemctl reload caddy || systemctl restart caddy
echo "OK: https://${DOMAIN}/api/health"
