#!/usr/bin/env bash
# Deploy del Anthropic proxy en una VM openclaw existente.
# Idempotente: re-correr no rompe nada.
#
# Requiere variables (toma defaults de openclaw-bridge si están en su .env):
#   ORGANIZATION_ID — UUID de la org
#   SUPABASE_URL    — del ai-engine .env
#   SUPABASE_SERVICE_KEY — del ai-engine .env
#   ANTHROPIC_API_KEY — para que OpenClaw siga funcionando

set -euo pipefail

PROXY_DIR=/opt/anthropic-proxy
PROXY_PORT=${ANTHROPIC_PROXY_PORT:-8788}

if [ ! -f /opt/openclaw-bridge/.env ]; then
  echo "ERROR: /opt/openclaw-bridge/.env no existe — ¿es esta la VM correcta?" >&2
  exit 1
fi

# Heredar lo necesario del .env del bridge.
set -a
source /opt/openclaw-bridge/.env
set +a
ORGANIZATION_ID="${ORG_ID:?ORG_ID missing in bridge .env}"

read -r -p "SUPABASE_URL: " SUPABASE_URL
read -r -s -p "SUPABASE_SERVICE_KEY: " SUPABASE_SERVICE_KEY
echo

mkdir -p "$PROXY_DIR"
cd "$PROXY_DIR"

cat > package.json <<'JSON'
{
  "name": "anthropic-proxy",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0"
  }
}
JSON

cat > .env <<EOF
ORGANIZATION_ID=$ORGANIZATION_ID
ANTHROPIC_PROXY_PORT=$PROXY_PORT
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY
EOF
chmod 600 .env

# El server.js se sube vía scp ANTES de correr este script
if [ ! -f server.js ]; then
  echo "ERROR: $PROXY_DIR/server.js no existe — sube primero con: scp /tmp/proxy-impl/server.js root@<vm>:$PROXY_DIR/server.js" >&2
  exit 1
fi

npm install --omit=dev --no-fund --no-audit

# Systemd unit
cp /tmp/anthropic-proxy.service /etc/systemd/system/anthropic-proxy.service 2>/dev/null || cat > /etc/systemd/system/anthropic-proxy.service <<'UNIT'
[Unit]
Description=Anthropic API Proxy (per-org metering + cap)
After=network.target
Before=openclaw-bridge.service

[Service]
Type=simple
WorkingDirectory=/opt/anthropic-proxy
EnvironmentFile=/opt/anthropic-proxy/.env
ExecStart=/usr/bin/node /opt/anthropic-proxy/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=anthropic-proxy

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable anthropic-proxy.service
systemctl restart anthropic-proxy.service
sleep 2

# Health check
if ! curl -sf --max-time 5 "http://127.0.0.1:$PROXY_PORT/__proxy_health" >/dev/null; then
  echo "ERROR: proxy no responde en /__proxy_health"
  systemctl status anthropic-proxy --no-pager
  exit 1
fi
echo "[setup] proxy vivo en :$PROXY_PORT"

# Hacer que OpenClaw use el proxy: setear ANTHROPIC_BASE_URL
if grep -q "^ANTHROPIC_BASE_URL=" /opt/openclaw-bridge/.env; then
  sed -i "s|^ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=http://127.0.0.1:$PROXY_PORT|" /opt/openclaw-bridge/.env
else
  echo "ANTHROPIC_BASE_URL=http://127.0.0.1:$PROXY_PORT" >> /opt/openclaw-bridge/.env
fi

# Reiniciar bridge para que tome el nuevo baseURL
systemctl restart openclaw-bridge.service
sleep 2

# Reiniciar también openclaw-gateway (lee ANTHROPIC_BASE_URL al arrancar)
pkill -TERM -f openclaw-gateway || true
sleep 2
# El bridge re-arranca el gateway al recibir el siguiente request

echo
echo "✓ Done. Comprobar:"
echo "  - systemctl status anthropic-proxy"
echo "  - journalctl -u anthropic-proxy -n 50"
echo "  - mañana: SELECT * FROM v_org_claude_usage_today WHERE organization_id = '$ORGANIZATION_ID';"
