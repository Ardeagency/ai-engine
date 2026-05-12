#!/bin/bash
#
# migrate-existing-server-to-mcp.sh
#
# Instala el MCP server en un org-server YA provisionado y lo registra en OpenClaw.
# No requiere sleep+wake. Sin downtime perceptible (solo restart del subproceso MCP).
#
# Ejecutar desde la máquina que tiene SSH al org-server (la Mac del usuario).
#
# Uso:
#   ./migrate-existing-server-to-mcp.sh <SERVER_IP> <ORG_TOKEN> <ORG_ID> [AI_ENGINE_URL]
#
# Cómo obtener los args desde ai-engine:
#   ssh ai-engine 'cd /root/ai-engine && node --input-type=module -e "
#     import { supabase } from \"./src/lib/supabase.js\";
#     const { data } = await supabase.from(\"openclaw_instances\")
#       .select(\"server_ip,org_token,organization_id\")
#       .not(\"server_ip\", \"is\", null);
#     for (const r of data || []) {
#       console.log(\`${r.organization_id} ${r.server_ip} ${r.org_token}\`);
#     }
#   "'

set -e

SERVER_IP="$1"
ORG_TOKEN="$2"
ORG_ID="$3"
AI_ENGINE_URL="${4:-http://5.161.243.1:3000}"

if [ -z "$SERVER_IP" ] || [ -z "$ORG_TOKEN" ] || [ -z "$ORG_ID" ]; then
  echo "Uso: $0 <SERVER_IP> <ORG_TOKEN> <ORG_ID> [AI_ENGINE_URL]"
  echo ""
  echo "Para obtener los args: consulta openclaw_instances en Supabase."
  exit 1
fi

# Derivar agentId del orgId (mismo método que el provisioner)
AGENT_ID="org_$(echo "$ORG_ID" | tr -d - | cut -c1-24)"

echo "════════════════════════════════════════════════════════════"
echo "  Migrando $SERVER_IP a MCP"
echo "  org_id:    $ORG_ID"
echo "  agent_id:  $AGENT_ID"
echo "  ai-engine: $AI_ENGINE_URL"
echo "════════════════════════════════════════════════════════════"

# 1. Verificar que ai-engine responde (token válido contra el endpoint)
echo "[1/6] Verificando que ai-engine responde con tu token..."
HEALTH=$(curl -sS -m 10 -H "X-Org-Token: $ORG_TOKEN" "$AI_ENGINE_URL/mcp/health" || echo '{"ok":false}')
if ! echo "$HEALTH" | grep -q '"ok":true'; then
  echo "❌ ai-engine no acepta el token. Respuesta: $HEALTH"
  exit 2
fi
echo "    OK"

# 2. Obtener el código del MCP server desde ai-engine via scp
echo "[2/6] Descargando MCP server desde ai-engine..."
TMP_MCP=$(mktemp)
scp -q ai-engine:/root/ai-engine/src/mcp/ai-engine-tools.js "$TMP_MCP"
echo "    OK ($(wc -l < "$TMP_MCP") líneas)"

# 3. Subir al org-server
echo "[3/6] Subiendo a $SERVER_IP:/opt/ai-engine-mcp/server.js..."
ssh -o ConnectTimeout=10 root@"$SERVER_IP" 'mkdir -p /opt/ai-engine-mcp'
scp -q "$TMP_MCP" root@"$SERVER_IP":/opt/ai-engine-mcp/server.js
rm "$TMP_MCP"
echo "    OK"

# 4. Crear .env y package.json
echo "[4/6] Configurando .env + package.json + npm install..."
ssh root@"$SERVER_IP" "cat > /opt/ai-engine-mcp/.env <<ENVEOF
AI_ENGINE_URL=$AI_ENGINE_URL
ORG_TOKEN=$ORG_TOKEN
ORG_ID=$ORG_ID
ENVEOF
chmod 600 /opt/ai-engine-mcp/.env

cat > /opt/ai-engine-mcp/package.json <<PKGEOF
{
  \"name\": \"ai-engine-mcp\",
  \"version\": \"2.0.0\",
  \"type\": \"module\",
  \"dependencies\": { \"@modelcontextprotocol/sdk\": \"^1.29.0\" }
}
PKGEOF

cd /opt/ai-engine-mcp && npm install --omit=dev --no-fund --no-audit 2>&1 | tail -3"
echo "    OK"

# 5. Registrar en OpenClaw
echo "[5/6] Registrando MCP en OpenClaw del agente..."
ssh root@"$SERVER_IP" "
set -a; . /opt/ai-engine-mcp/.env; set +a
MCP_CFG='{\"command\":\"node\",\"args\":[\"/opt/ai-engine-mcp/server.js\"],\"env\":{\"AI_ENGINE_URL\":\"'\$AI_ENGINE_URL'\",\"ORG_TOKEN\":\"'\$ORG_TOKEN'\",\"ORG_ID\":\"'\$ORG_ID'\"}}'
openclaw mcp set ai-engine \"\$MCP_CFG\" --workspace /root/workspaces/$AGENT_ID
"
echo "    OK"

# 6. Verificar registro
echo "[6/6] Verificando registro..."
ssh root@"$SERVER_IP" "openclaw mcp list --workspace /root/workspaces/$AGENT_ID 2>/dev/null | grep -E 'ai-engine|MCP' | head -5"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✅ Migración completa"
echo "  La próxima vez que OpenClaw arranque (próximo turn de Vera),"
echo "  cargará el MCP y verá las tools dinámicas."
echo "════════════════════════════════════════════════════════════"
