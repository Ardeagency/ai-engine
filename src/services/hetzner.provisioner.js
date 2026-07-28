/**
 * Hetzner Provisioner — crea y destruye servidores dedicados por organización.
 *
 * Naming: vera-{últimos 12 dígitos del orgId}-{org-name-sanitizado}
 *   Ejemplo: vera-000000000001-arde-agency
 *
 * Arquitectura: cada org recibe un servidor Hetzner independiente con:
 *  - OpenClaw instalado y configurado con workspace + skills + crons
 *  - openclaw-bridge: HTTP server en puerto 3001 que envuelve el CLI de OpenClaw
 *  - Systemd service con restart automático
 *  - Token único de autenticación (rotado en cada wake)
 *  - Modelo: Anthropic Claude (Sonnet por defecto, Opus para planes pro)
 *
 * Flujo de provisioning:
 *  1. AI Engine llama createOrgServer(org) → Hetzner crea el servidor con cloud-init
 *  2. cloud-init instala Node.js, OpenClaw, descarga defaults de AI Engine, configura workspace
 *  3. Al terminar, el org-server hace POST /internal/server-ready en AI Engine
 *  4. AI Engine guarda IP + token en openclaw_instances y registra en el registry
 *
 * Sistema sleep/wake:
 *  - sleepOrgServer(): crea snapshot → destruye servidor (costo → 0)
 *  - wakeOrgServer(): recrea servidor desde snapshot (~90s)
 */
import crypto from "crypto";
import { supabase } from "../lib/supabase.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Los documentos de doctrina que las VMs nuevas reciben al nacer viven aqui.
const DEFAULTS_DIR_PROV = fileURLToPath(new URL("../../defaults/", import.meta.url));

const HETZNER_API         = "https://api.hetzner.cloud/v1";
const ORG_BRIDGE_PORT     = 3001;
const PROVISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// Tipos de servidor Hetzner por plan
// Puerto del proxy Anthropic local. Vive aqui —y no como literal suelto— porque
// el cloud-init lo escribia y el script de despertar NO: cualquier VM que se
// durmiera una vez perdia ANTHROPIC_BASE_URL, openclaw pasaba a hablar directo
// con api.anthropic.com y el proxy quedaba de adorno. Resultado: CERO filas de
// medicion en credit_usage para TODAS las orgs, y los topes de gasto inertes.
const ANTHROPIC_PROXY_PORT_DEFAULT = 8788;

// Zona horaria de respaldo cuando la organizacion no declara la suya. Vera vive
// en la hora de su marca —cuando despierta y cuando corre sus trabajos—, no en
// la del servidor. Los crons llevaban America/New_York a fuego, que no es la
// hora de nadie de esta casa.
const ZONA_HORARIA_POR_DEFECTO = "America/Bogota";

const SERVER_TYPES = {
  starter: "cx23",   // 2 vCPU / 4 GB — ~5€/mes (Intel/AMD shared, EU locations)
  growth:  "cx33",   // 4 vCPU / 8 GB — ~8€/mes
  pro:     "cx43",   // 8 vCPU / 16 GB — ~14€/mes
};

/**
 * Tamano de la VM segun lo que paga la organizacion.
 *
 * POR QUE NO ES UN MAPA DE NOMBRES: lo era, con las claves `starter/growth/pro`,
 * y los planes que de verdad existen se llaman trial, creator, starter, team,
 * pro, agency y business. Ninguno menos `starter` y `pro` casaba, asi que todos
 * caian al respaldo — y el respaldo es el servidor mas pequeno. Sumado a que el
 * plan se leia de una columna inexistente (ver `_planDeLaOrg`), TODA VM nacia
 * cx23 con 4 GB: WAKEUP, que paga Team, se quedaba sin memoria en cada turno
 * pesado y hubo que subirla a mano a cx33 el 2026-07-14. Por precio no hay
 * nombres que mantener sincronizados: un plan nuevo se coloca solo.
 */
function tipoDeServidorPorPrecio(precioUsdMes) {
  const p = Number(precioUsdMes) || 0;
  if (p >= 299) return SERVER_TYPES.pro;      // 8 vCPU / 16 GB
  if (p >= 100) return SERVER_TYPES.growth;   // 4 vCPU / 8 GB
  return SERVER_TYPES.starter;                // 2 vCPU / 4 GB
}

/**
 * El plan vigente de una organizacion, con su precio.
 *
 * Se leia de `organizations.plan`, que NO EXISTE: PostgREST devolvia
 * "column organizations.plan does not exist", la fila entera venia null y el
 * codigo caia al respaldo sin enterarse. El plan vive en `subscriptions`
 * (plan_id + status) y su precio en `plans`.
 */
export async function _planDeLaOrg(organizationId) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan_id, status")
    .eq("organization_id", organizationId)
    .in("status", ["active", "trialing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sub?.plan_id) return { planId: "starter", precio: 0 };
  const { data: plan } = await supabase
    .from("plans")
    .select("id, price_usd_month")
    .eq("id", sub.plan_id)
    .maybeSingle();
  return { planId: sub.plan_id, precio: plan?.price_usd_month ?? 0 };
}

// Modelos de Anthropic por plan
const MODELS_BY_PLAN = {
  starter: "anthropic/claude-sonnet-4-6",
  growth:  "anthropic/claude-sonnet-4-6",
  pro:     "anthropic/claude-opus-4-8",
  agency:  "anthropic/claude-sonnet-4-6",
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

function _getToken() {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN no configurado en el servidor");
  return token;
}

function _headers() {
  return {
    "Authorization": `Bearer ${_getToken()}`,
    "Content-Type": "application/json",
  };
}

// ── HTTP wrapper ──────────────────────────────────────────────────────────────

async function _hetznerRequest(method, path, body = null) {
  const url  = `${HETZNER_API}${path}`;
  const opts = { method, headers: _headers() };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`Hetzner API ${res.status}: ${msg}`);
  }
  return data;
}

// ── Security ──────────────────────────────────────────────────────────────────

export function generateOrgToken() {
  return `oc_${crypto.randomBytes(32).toString("hex")}`;
}

// ── Naming ────────────────────────────────────────────────────────────────────

/**
 * Genera el nombre del servidor Hetzner para una organización.
 * Formato: vera-{últimos 12 dígitos del UUID sin guiones}-{org-name-slug}
 * Ejemplo: vera-000000000001-arde-agency
 *
 * Hetzner permite max 63 chars, solo [a-z0-9-], no puede empezar/terminar con guión.
 */
export function buildServerName(organizationId, orgName) {
  const last12 = organizationId.replace(/-/g, "").slice(-12);
  const slug = String(orgName || "org")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]+/g, "-")                       // non-alphanum → dash
    .replace(/^-+|-+$/g, "")                            // trim dashes
    .slice(0, 40) || "org";                             // max 40 chars for name part
  return `vera-${last12}-${slug}`;
}

/**
 * Deriva el agentId estándar desde el organizationId.
 */
export function deriveAgentId(organizationId) {
  return `org_${organizationId.replace(/-/g, "").slice(0, 24)}`;
}

// ── Cloud-init template ───────────────────────────────────────────────────────

/**
 * Codigo del puente HTTP que corre en cada org-server. Es IDENTICO para todas
 * las organizaciones (lo que cambia va por env), asi que se sirve tambien por
 * HTTP para poder refrescarlo sin recrear el servidor — el mismo patron que ya
 * se usa con el MCP server.
 */
export function buildBridgeCode() {
  return `import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const PORT      = ${ORG_BRIDGE_PORT};
const ORG_TOKEN = process.env.ORG_TOKEN;
const ORG_ID    = process.env.ORG_ID;
const TIMEOUT   = Number(process.env.OPENCLAW_TIMEOUT_MS) || 900000;

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, org_id: ORG_ID, uptime: process.uptime() });
  }

  if (req.method === 'POST' && req.url === '/agent/run') {
    const token = req.headers['x-org-token'];
    if (!token || token !== ORG_TOKEN) return send(401, { error: 'Unauthorized' });

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const { agentId, message, sessionId } = JSON.parse(raw);
        const args = [
          'agent', '--local',
          '--agent',      agentId,
          '--message',    message,
          '--session-id', sessionId,
          '--json',
        ];
        const result = await execFileAsync('openclaw', args, {
          env: { ...process.env },
          timeout: TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });
        const output = (result.stdout || '') + (result.stderr || '');
        return send(200, { ok: true, output });
      } catch (e) {
        return send(500, { error: e.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/workspace/file') {
    const token = req.headers['x-org-token'];
    if (!token || token !== ORG_TOKEN) return send(401, { error: 'Unauthorized' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const ALLOWED = ['USER.md', 'AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'HEARTBEAT.md'];
        const file = String(body.path || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!ALLOWED.includes(file)) return send(400, { error: 'file not allowed' });
        const aid = String(body.agentId || '').replace(/[^a-z0-9_]/g, '');
        if (!aid) return send(400, { error: 'agentId required' });
        await writeFile('/root/workspaces/' + aid + '/' + file, String(body.content == null ? '' : body.content), 'utf8');
        return send(200, { ok: true, written: file });
      } catch (e) {
        return send(500, { error: e.message });
      }
    });
    return;
  }

  // ── Refresco de skills en caliente ────────────────────────────────────────
  // Sin esto, las skills solo llegan al aprovisionar: cualquier doctrina escrita
  // despues se queda en el control plane y la Vera de esta org nunca la ve.
  // Recrear el servidor por cada cambio de skill es carisimo con 10 Veras, asi
  // que el control plane empuja el tarball aqui y esto lo instala en caliente.
  // El tarball viaja en el cuerpo: no se guarda ningun secreto en este servidor.
  if (req.method === 'POST' && req.url === '/skills/refresh') {
    const token = req.headers['x-org-token'];
    if (!token || token !== ORG_TOKEN) return send(401, { error: 'Unauthorized' });
    // El agentId lo manda el control plane, saneado igual que en /workspace/file.
    const AGENT_ID = String(req.headers['x-agent-id'] || '').replace(/[^a-z0-9_]/g, '');
    if (!AGENT_ID) return send(400, { error: 'x-agent-id requerido' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      // Directorio propio por peticion. Con una ruta fija, dos refrescos
      // solapados se pisaban: el segundo encontraba el rm -rf del primero y
      // moria con "tar: Cannot open: No such file or directory".
      let tmp = null;
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return send(400, { error: 'tarball vacio' });
        const { stdout: mk } = await execFileAsync('mktemp', ['-d', '/tmp/skills-refresh.XXXXXX']);
        tmp = mk.trim();
        await writeFile(tmp + '/d.tar.gz', buf);
        await execFileAsync('tar', ['-xzf', tmp + '/d.tar.gz', '-C', tmp]);
        const destino = '/root/workspaces/' + AGENT_ID + '/skills';
        await execFileAsync('mkdir', ['-p', destino]);

        // ESPEJO, no acumulacion. cp -r agrega y sobreescribe pero nunca borra:
        // toda doctrina retirada del control plane seguia viva aqui para siempre,
        // compitiendo con la que la reemplazo. Lo que no viene en el tarball, se va.
        const listar = async (d) => {
          try {
            const { stdout } = await execFileAsync('bash', ['-lc', 'ls -1 ' + d + ' 2>/dev/null']);
            return stdout.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
          } catch { return []; }
        };
        const entrantes = new Set(await listar(tmp + '/skills'));
        const retiradas = [];
        for (const vieja of await listar(destino)) {
          if (entrantes.has(vieja)) continue;
          if (!/^[A-Za-z0-9._-]+$/.test(vieja)) continue;   // nada raro al rm -rf
          await execFileAsync('rm', ['-rf', destino + '/' + vieja]);
          retiradas.push(vieja);
        }

        await execFileAsync('bash', ['-lc', 'cp -r ' + tmp + '/skills/* ' + destino + '/']);
        const instaladas = await listar(destino);
        return send(200, { ok: true, skills: instaladas, total: instaladas.length, retiradas: retiradas });
      } catch (e) {
        return send(500, { error: String(e.message).slice(0, 300) });
      } finally {
        if (tmp) { try { await execFileAsync('rm', ['-rf', tmp]); } catch {} }
      }
    });
    return;
  }

  send(404, { error: 'Not found' });
});

// Node 18+ trae server.requestTimeout = 300000 por defecto: mata CUALQUIER
// peticion HTTP a los 5 minutos, sin importar lo que diga OPENCLAW_TIMEOUT_MS.
// Esa —y no el timeout de execFile— era la que estrangulaba las sesiones de
// dashboard: la investigacion cabia en 5 min, escribir las tarjetas no.
// Medido el 2026-07-27 en WAKEUP: corte a los 301s exactos, puente vivo.
server.requestTimeout   = TIMEOUT + 60000;
server.headersTimeout   = 60000;
server.keepAliveTimeout = 65000;

server.listen(PORT, () => console.log(\`[openclaw-bridge] org=\${ORG_ID} port=\${PORT} reqTimeout=\${server.requestTimeout}ms\`));
`;
}

function _generateCloudInitScript({
  orgId, orgName, orgToken, agentId, serverName,
  anthropicApiKey, openaiApiKey, openclawGatewayToken,
  callbackUrl, webhookSecret, model,
  supabaseUrl, supabaseServiceKey, anthropicProxyPort = ANTHROPIC_PROXY_PORT_DEFAULT,
  userMdContent = null, zonaHoraria = ZONA_HORARIA_POR_DEFECTO,
}) {
  const safeName = String(orgName || orgId)
    .replace(/[<>"'`\\]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120) || orgId;

  // Bridge code — se inyecta via write_files (base64) para evitar romper el parser YAML
  const bridgeCode = buildBridgeCode();
  const bridgeB64 = Buffer.from(bridgeCode).toString("base64");

  // OpenClaw consume ANTHROPIC_API_KEY pero todas las llamadas a la API pasan
  // por el proxy local (puerto ${anthropicProxyPort}) que mide tokens reales
  // y aplica cap diario/mensual via Supabase. Ver /opt/anthropic-proxy/.
  const envFile = `ORG_ID=${orgId}
ORG_TOKEN=${orgToken}
ANTHROPIC_API_KEY=${anthropicApiKey}
ANTHROPIC_BASE_URL=http://127.0.0.1:${anthropicProxyPort}
OPENCLAW_GATEWAY_TOKEN=${openclawGatewayToken}
OPENCLAW_TIMEOUT_MS=900000
`;
  const envB64 = Buffer.from(envFile).toString("base64");

  // ── Anthropic proxy & MCP server ────────────────────────────────────────────
  // Los binarios (server.js de cada uno) NO se embeben en user_data porque
  // Hetzner Cloud tiene un límite duro de 32 KB. Se descargan vía curl desde
  // el control plane (endpoints /internal/anthropic-proxy.js y /internal/mcp-server.js).
  // Aquí solo generamos los .env y systemd units pequeños que sí van inline.
  const proxyEnv = `ORGANIZATION_ID=${orgId}
ANTHROPIC_PROXY_PORT=${anthropicProxyPort}
SUPABASE_URL=${supabaseUrl || ""}
SUPABASE_SERVICE_KEY=${supabaseServiceKey || ""}
`;
  const anthropicProxyEnvB64 = Buffer.from(proxyEnv).toString("base64");

  const proxyUnit = `[Unit]
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
`;
  const anthropicProxyUnitB64 = Buffer.from(proxyUnit).toString("base64");

  const mcpEnv = `AI_ENGINE_URL=${callbackUrl}
ORG_TOKEN=${orgToken}
ORG_ID=${orgId}
`;
  const mcpEnvB64 = Buffer.from(mcpEnv).toString("base64");

  const ocConfig = JSON.stringify({
    tools: { web: { search: { enabled: true, provider: "duckduckgo", maxResults: 10 } } },
    plugins: {
      slots: { memory: "memory-core" },
      entries: { duckduckgo: { enabled: true }, "memory-core": { enabled: true } },
    },
    agents: {
      defaults: {
        // La ventana va en la hora de LA MARCA, no en la del gateway. Sin
        // `timezone` OpenClaw la interpreta en UTC: WAKEUP —marca colombiana—
        // despertaba de 03:00 a 17:00 hora local, dormida justo en la franja en
        // que su gente esta despierta, y llevaba asi desde que se aprovisiono.
        // La columna `organizations.timezone` ya lo decia; nadie la leia.
        heartbeat: {
          every: "30m", target: "none", lightContext: true, isolatedSession: true,
          activeHours: { start: "08:00", end: "22:00", timezone: zonaHoraria },
        },
      },
    },
    // maxTokens 16000 — sube el cap default de OpenClaw (4096) para Anthropic
    // y permite respuestas largas (artifacts HTML/JS, reportes extensos).
    // Solo se aplica a orgs provisionadas DESPUÉS de este cambio; orgs
    // existentes (incluida IGNIS) mantienen el cap viejo hasta reprovision.
  }, null, 2);
  const ocConfigB64 = Buffer.from(ocConfig).toString("base64");

  const hooksJson = JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "echo '[VERA] Write detected'" }] },
        { matcher: "Write|Edit|apply_patch", hooks: [{ type: "command", command: "echo '[VERA] Contenido escrito'" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "echo '[VERA] Sesion completada'" }] }],
    },
  }, null, 2);
  const hooksB64 = Buffer.from(hooksJson).toString("base64");

  const userMd = userMdContent || `# USER\n\nOrganizacion: **${safeName}**\n\nEres Vera, la IA de contenido y analisis de marca de ${safeName}.\nTrabaja exclusivamente dentro del contexto de esta organizacion.\n`;
  const userMdB64 = Buffer.from(userMd).toString("base64");

  // Systemd service file
  const systemdUnit = `[Unit]
Description=OpenClaw HTTP Bridge (${serverName})
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-bridge
EnvironmentFile=/opt/openclaw-bridge/.env
ExecStart=/usr/bin/node /opt/openclaw-bridge/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-bridge

[Install]
WantedBy=multi-user.target
`;
  // El guion del latido. Sin el, el heartbeat despierta cada 30 min y se vuelve a
  // dormir: el mecanismo de autonomia del motor girando en vacio.
  const heartbeatB64 = Buffer.from(
    readFileSync(DEFAULTS_DIR_PROV + "HEARTBEAT.md", "utf8")
  ).toString("base64");

  const systemdB64 = Buffer.from(systemdUnit).toString("base64");

  // El gateway es el plano de control de Vera: por ahi pasan sus tools `cron` y
  // `gateway`. Antes se lanzaba con `openclaw gateway start || true` y nadie lo
  // vigilaba — si moria, ella perdia la capacidad de programarse cualquier cosa
  // y no se enteraba nadie. Con Restart=always vuelve solo.
  const gatewayUnit = `[Unit]
Description=OpenClaw Gateway (plano de control de ${serverName})
After=network.target
Before=openclaw-bridge.service

[Service]
Type=simple
WorkingDirectory=/root
ExecStart=/usr/bin/env openclaw gateway
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-gateway

[Install]
WantedBy=multi-user.target
`;
  const gatewayUnitB64 = Buffer.from(gatewayUnit).toString("base64");

  // Setup script — todo el provisioning pesado va aquí para no romper YAML
  const setupScript = `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
export ANTHROPIC_API_KEY="${anthropicApiKey}"
export OPENAI_API_KEY="${openaiApiKey}"
export OPENCLAW_GATEWAY_TOKEN="${openclawGatewayToken}"

echo "[setup] Firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow ${ORG_BRIDGE_PORT}/tcp
ufw --force enable

echo "[setup] Node.js LTS..."
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

echo "[setup] OpenClaw + ClawHub..."
npm install -g openclaw@2026.6.1 clawhub

# ── Descargar anthropic-proxy/server.js desde el control plane ───────────────
# (Movido fuera de user_data por límite 32 KB de Hetzner Cloud)
echo "[setup] Descargando anthropic-proxy desde AI Engine..."
mkdir -p /opt/anthropic-proxy
if curl -sf --max-time 30 -H "x-webhook-secret: ${webhookSecret}" \\
     "${callbackUrl}/internal/anthropic-proxy.js" -o /opt/anthropic-proxy/server.js; then
  echo "[setup] anthropic-proxy.js descargado OK"
  cat > /opt/anthropic-proxy/package.json <<'PROXY_PKG_EOF'
{
  "name": "anthropic-proxy",
  "version": "1.0.0",
  "type": "module",
  "dependencies": { "@supabase/supabase-js": "^2.45.0" }
}
PROXY_PKG_EOF
  cd /opt/anthropic-proxy && npm install --omit=dev --no-fund --no-audit && cd /
  systemctl daemon-reload
  systemctl enable anthropic-proxy
  systemctl start anthropic-proxy
  sleep 3
  if curl -sf --max-time 5 "http://127.0.0.1:${anthropicProxyPort}/__proxy_health" >/dev/null; then
    echo "[setup] anthropic-proxy OK"
  else
    echo "[setup] WARN: anthropic-proxy no respondió a health"
  fi
else
  echo "[setup] WARN: no se pudo descargar anthropic-proxy.js — VM sin metering"
fi

# ── Descargar mcp-server.js desde el control plane ───────────────────────────
# (Movido fuera de user_data por límite 32 KB de Hetzner Cloud)
echo "[setup] Descargando mcp-server desde AI Engine..."
mkdir -p /opt/ai-engine-mcp
if ! curl -sf --max-time 30 -H "x-webhook-secret: ${webhookSecret}" \\
     "${callbackUrl}/internal/mcp-server.js" -o /opt/ai-engine-mcp/server.js; then
  echo "[setup] WARN: no se pudo descargar mcp-server.js — markers [[TOOL:...]] como fallback"
  rm -f /opt/ai-engine-mcp/server.js
fi

echo "[setup] Workspace..."
chmod 700 /root/workspaces/${agentId}

echo "[setup] Descargando defaults de AI Engine..."
mkdir -p /tmp/vera-defaults
curl -sf --max-time 120 -o /tmp/vera-defaults.tar.gz \\
  -H "x-webhook-secret: ${webhookSecret}" \\
  "${callbackUrl}/internal/defaults.tar.gz" || true
if [ -f /tmp/vera-defaults.tar.gz ]; then
  tar -xzf /tmp/vera-defaults.tar.gz -C /tmp/vera-defaults
  echo "[setup] Defaults descargados OK"

  # Copiar prompts
  for f in /tmp/vera-defaults/*.md; do
    [ -f "$f" ] && cp "$f" /root/workspaces/${agentId}/
  done

  # Personalizar AGENTS.md con el nombre real de la org (placeholder {{ORG_NAME}})
  if [ -f /root/workspaces/${agentId}/AGENTS.md ]; then
    ORG_NAME_ESCAPED=$(printf '%s' "${safeName}" | sed -e 's/[\\&|]/\\\\&/g')
    sed -i "s|{{ORG_NAME}}|\${ORG_NAME_ESCAPED}|g" /root/workspaces/${agentId}/AGENTS.md
    echo "[setup] AGENTS.md personalizado para ${safeName}"
  fi

  # Copiar skills
  mkdir -p /root/workspaces/${agentId}/skills
  if [ -d /tmp/vera-defaults/skills ]; then
    cp -r /tmp/vera-defaults/skills/* /root/workspaces/${agentId}/skills/ 2>/dev/null || true
  fi

  # Copiar memory banks
  mkdir -p /root/workspaces/${agentId}/memory
  if [ -d /tmp/vera-defaults/memory-banks ]; then
    cp /tmp/vera-defaults/memory-banks/* /root/workspaces/${agentId}/memory/ 2>/dev/null || true
  fi
fi

echo "[setup] ClawHub skills..."
for skill in proactive-agent-lite xiucheng-self-improving-agent summarize-pro ontology multi-search-engine agent-browser-clawdbot automation-workflows humanizer; do
  clawhub install "$skill" --workspace /root/workspaces/${agentId} 2>/dev/null && echo "[clawhub] $skill OK" || echo "[clawhub] $skill SKIP"
done

echo "[setup] Reparar config + provider anthropic (API key via proxy, multitenant)..."
openclaw doctor --fix >/dev/null 2>&1 || true
echo "$ANTHROPIC_API_KEY" | openclaw models auth paste-api-key --provider anthropic >/dev/null 2>&1 || true
echo "$OPENAI_API_KEY" | openclaw models auth paste-api-key --provider openai >/dev/null 2>&1 || true
openclaw models set ${model} >/dev/null 2>&1 || true

# Cadena de respaldo del modelo. Sin esto el log dice "next=none" y una
# saturacion pasajera de Anthropic tumba la sesion entera: el 2026-07-27 dos
# sesiones de dashboard murieron con "The AI service is temporarily overloaded"
# despues de que Vera ya habia hecho toda su investigacion.
# Primero otro modelo del mismo proveedor (sirve si solo un pool esta saturado)
# y despues uno de OTRO proveedor, que es el unico respaldo real ante una caida
# general de Anthropic. La llave de OpenAI ya quedo cargada arriba.
openclaw models fallbacks clear >/dev/null 2>&1 || true
openclaw models fallbacks add anthropic/claude-opus-4-8 >/dev/null 2>&1 || true
openclaw models fallbacks add openai/gpt-4.1 >/dev/null 2>&1 || true

echo "[setup] Registrar agente..."
openclaw agents add ${agentId} \\
  --workspace /root/workspaces/${agentId} \\
  --model ${model} \\
  --non-interactive || true

echo "[setup] Hooks..."
openclaw hooks enable session-memory || true
openclaw hooks enable boot-md || true

if [ -f /opt/ai-engine-mcp/server.js ]; then
  echo "[setup] MCP client deps..."
  cat > /opt/ai-engine-mcp/package.json <<'MCP_PKG_EOF'
{
  "name": "ai-engine-mcp",
  "version": "2.0.0",
  "type": "module",
  "dependencies": { "@modelcontextprotocol/sdk": "^1.29.0" }
}
MCP_PKG_EOF
  cd /opt/ai-engine-mcp && npm install --omit=dev --no-fund --no-audit && cd /
  echo "[setup] Registrando MCP en OpenClaw..."
  # Source del .env para inyectar AI_ENGINE_URL y ORG_TOKEN al MCP child process
  set -a; . /opt/ai-engine-mcp/.env; set +a
  MCP_CFG=$(cat <<MCP_CFG_EOF
{"command":"node","args":["/opt/ai-engine-mcp/server.js"],"env":{"AI_ENGINE_URL":"\${AI_ENGINE_URL}","ORG_TOKEN":"\${ORG_TOKEN}","ORG_ID":"\${ORG_ID}"}}
MCP_CFG_EOF
)
  openclaw mcp set ai-engine "$MCP_CFG" 2>&1 && echo "[setup] MCP ai-engine registrado OK" || echo "[setup] WARN: MCP register fallo — markers seguirán funcionando como fallback"
fi

echo "[setup] Gateway + Crons..."
openclaw config set gateway.mode local || true
# Supervisado: si muere, systemd lo devuelve. Antes era un disparo a ciegas.
systemctl daemon-reload
systemctl enable openclaw-gateway || true
systemctl restart openclaw-gateway || true
# Y se ESPERA a que escuche de verdad. Con un sleep 5 a ciegas, los tres cron
# add de abajo (que van con 2>/dev/null || true) fallaban en silencio y la VM
# quedaba "aprovisionada con exito" sin un solo cron.
GW_OK=0
for _i in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q ':18789'; then GW_OK=1; break; fi
  sleep 2
done
if [ "$GW_OK" = "1" ]; then
  echo "[setup] gateway escuchando en 18789"
else
  echo "[setup] ERROR: el gateway NO levanto en 60s — los crons de abajo van a fallar"
  systemctl status openclaw-gateway --no-pager 2>&1 | tail -20
fi
openclaw cron add --agent ${agentId} --cron '0 8 * * *' --tz ${zonaHoraria} --name daily-brief --message 'Daily briefing' --light-context --session isolated --timeout-seconds 120 2>/dev/null || true
openclaw cron add --agent ${agentId} --cron '0 */6 * * *' --tz ${zonaHoraria} --name engagement-monitor --message 'Engagement check' --light-context --session isolated --timeout-seconds 90 2>/dev/null || true
openclaw cron add --agent ${agentId} --cron '0 10 * * 1' --tz ${zonaHoraria} --name weekly-scan --message 'Competitor scan' --light-context --session isolated --timeout-seconds 180 2>/dev/null || true

echo "[setup] Systemd service..."
systemctl daemon-reload
systemctl enable openclaw-bridge
systemctl start openclaw-bridge
sleep 5

echo "[setup] Callback a AI Engine..."
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 http://checkip.amazonaws.com || hostname -I | awk '{print $1}')
curl -sf --max-time 15 -X POST "${callbackUrl}/internal/server-ready" \\
  -H "Content-Type: application/json" \\
  -H "x-webhook-secret: ${webhookSecret}" \\
  -d "{\\"org_id\\":\\"${orgId}\\",\\"server_ip\\":\\"$PUBLIC_IP\\",\\"server_port\\":${ORG_BRIDGE_PORT},\\"org_token\\":\\"${orgToken}\\",\\"agent_id\\":\\"${agentId}\\"}" \\
  || echo "[setup] WARN: callback fallo — reintentando en 60s"
sleep 60
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
curl -sf --max-time 15 -X POST "${callbackUrl}/internal/server-ready" \\
  -H "Content-Type: application/json" \\
  -H "x-webhook-secret: ${webhookSecret}" \\
  -d "{\\"org_id\\":\\"${orgId}\\",\\"server_ip\\":\\"$PUBLIC_IP\\",\\"server_port\\":${ORG_BRIDGE_PORT},\\"org_token\\":\\"${orgToken}\\",\\"agent_id\\":\\"${agentId}\\"}" || true

rm -rf /tmp/vera-defaults /tmp/vera-defaults.tar.gz
echo "[setup] DONE"
`;
  const setupB64 = Buffer.from(setupScript).toString("base64");

  // Cloud-init YAML — minimal, no complex content inline
  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - curl
  - git
  - ufw
  - fail2ban

write_files:
  - path: /opt/openclaw-bridge/server.js
    encoding: b64
    content: ${bridgeB64}
  - path: /opt/openclaw-bridge/package.json
    content: '{"name":"openclaw-bridge","type":"module","version":"1.0.0"}'
  - path: /opt/openclaw-bridge/.env
    permissions: "0600"
    encoding: b64
    content: ${envB64}
  - path: /root/.openclaw/openclaw.json
    encoding: b64
    content: ${ocConfigB64}
  - path: /root/workspaces/${agentId}/USER.md
    encoding: b64
    content: ${userMdB64}
  - path: /root/workspaces/${agentId}/HEARTBEAT.md
    encoding: b64
    content: ${heartbeatB64}
  - path: /root/workspaces/${agentId}/.openclaw/settings.json
    encoding: b64
    content: ${hooksB64}
  - path: /etc/systemd/system/openclaw-bridge.service
    encoding: b64
    content: ${systemdB64}
  - path: /etc/systemd/system/openclaw-gateway.service
    encoding: b64
    content: ${gatewayUnitB64}
  - path: /opt/anthropic-proxy/.env
    permissions: "0600"
    encoding: b64
    content: ${anthropicProxyEnvB64}
  - path: /etc/systemd/system/anthropic-proxy.service
    encoding: b64
    content: ${anthropicProxyUnitB64}
  - path: /opt/ai-engine-mcp/.env
    permissions: "0600"
    encoding: b64
    content: ${mcpEnvB64}
  - path: /root/setup.sh
    permissions: "0700"
    encoding: b64
    content: ${setupB64}

runcmd:
  - bash /root/setup.sh >> /var/log/vera-setup.log 2>&1
`;
}

function _generateWakeScript({ orgId, orgToken, anthropicApiKey, openclawGatewayToken, callbackUrl, webhookSecret }) {
  const agentId = deriveAgentId(orgId);
  // El despertar restaura un DISCO de snapshot: el server.js del puente que hay
  // ahi es el del dia en que se aprovisiono. Reescribir solo el .env dejaba
  // cualquier arreglo de buildBridgeCode() sin poder llegar NUNCA a un servidor
  // existente — asi se perdieron dos ciclos completos el 2026-07-27 intentando
  // levantar un timeout. Va en base64 para no pelear con comillas ni backticks.
  const bridgeB64Wake = Buffer.from(buildBridgeCode(), "utf8").toString("base64");
  return `#!/bin/bash
echo '${bridgeB64Wake}' | base64 -d > /opt/openclaw-bridge/server.js
cat > /opt/openclaw-bridge/.env << 'ENV_EOF'
ORG_ID=${orgId}
ORG_TOKEN=${orgToken}
ANTHROPIC_API_KEY=${anthropicApiKey}
ANTHROPIC_BASE_URL=http://127.0.0.1:${ANTHROPIC_PROXY_PORT_DEFAULT}
OPENCLAW_GATEWAY_TOKEN=${openclawGatewayToken}
OPENCLAW_TIMEOUT_MS=900000
ENV_EOF
chmod 600 /opt/openclaw-bridge/.env
systemctl restart openclaw-bridge
sleep 3

# ── anthropic-proxy refresh on wake ────────────────────────────────────────
# El despertar restaura un DISCO: el proxy que hay ahi es el del dia en que se
# aprovisiono. Sin esto, un arreglo en anthropic-proxy/server.js solo llegaba a
# servidores creados desde cero — y el proxy es el segundo servidor HTTP del
# camino, con el mismo requestTimeout de Node que estrangulaba las sesiones.
if curl -sf --max-time 30 -H "x-webhook-secret: ${webhookSecret}" \\
     "${callbackUrl}/internal/anthropic-proxy.js" -o /tmp/anthropic-proxy.js; then
  if node --check /tmp/anthropic-proxy.js 2>/dev/null; then
    mv /tmp/anthropic-proxy.js /opt/anthropic-proxy/server.js
    systemctl restart anthropic-proxy
    echo "[wake] anthropic-proxy actualizado"
  else
    echo "[wake] anthropic-proxy descargado NO compila — se conserva el anterior"
  fi
else
  echo "[wake] no se pudo descargar anthropic-proxy — se conserva el anterior"
fi
sleep 2

# ── MCP server install/refresh on wake ─────────────────────────────────────
# Idempotente: descarga la versión actual del MCP server del control plane
# y lo registra en OpenClaw. Si falla, los markers [[TOOL:...]] siguen como fallback.
mkdir -p /opt/ai-engine-mcp
if curl -sf --max-time 30 -H "x-webhook-secret: ${webhookSecret}" \\
     "${callbackUrl}/internal/mcp-server.js" -o /opt/ai-engine-mcp/server.js; then
  cat > /opt/ai-engine-mcp/.env <<MCPENV_EOF
AI_ENGINE_URL=${callbackUrl}
ORG_TOKEN=${orgToken}
ORG_ID=${orgId}
MCPENV_EOF
  chmod 600 /opt/ai-engine-mcp/.env

  if [ ! -d /opt/ai-engine-mcp/node_modules ]; then
    cat > /opt/ai-engine-mcp/package.json <<MCPPKG_EOF
{"name":"ai-engine-mcp","version":"2.0.0","type":"module","dependencies":{"@modelcontextprotocol/sdk":"^1.29.0"}}
MCPPKG_EOF
    cd /opt/ai-engine-mcp && npm install --omit=dev --no-fund --no-audit 2>&1 | tail -5 || echo "[wake] npm install MCP fallo"
  fi

  set -a; . /opt/ai-engine-mcp/.env; set +a
  MCP_CFG='{"command":"node","args":["/opt/ai-engine-mcp/server.js"],"env":{"AI_ENGINE_URL":"'"$AI_ENGINE_URL"'","ORG_TOKEN":"'"$ORG_TOKEN"'","ORG_ID":"'"$ORG_ID"'"}}'
  openclaw mcp set ai-engine "$MCP_CFG" 2>&1 && echo "[wake] MCP registrado OK" || echo "[wake] WARN: MCP register fallo — markers como fallback"
else
  echo "[wake] WARN: no se pudo descargar mcp-server.js de ${callbackUrl}"
fi

# ── Refresco de skills al despertar ────────────────────────────────────────
# Se re-descargan del control plane para que una Vera que despierta lo haga con
# la doctrina al dia. El reemplazo del PUENTE en caliente se retiro el
# 2026-07-27: dejaba el bridge sin arrancar en el org-server y no hay forma de
# depurarlo sin acceso a esa maquina. Las skills son ficheros, no codigo que
# corra: refrescarlas no puede tumbar el servicio.
mkdir -p /tmp/vera-defaults
if curl -sf --max-time 120 -H "x-webhook-secret: ${webhookSecret}" \\
     "${callbackUrl}/internal/defaults.tar.gz" -o /tmp/vera-defaults.tar.gz; then
  tar -xzf /tmp/vera-defaults.tar.gz -C /tmp/vera-defaults 2>/dev/null || true
  if [ -d /tmp/vera-defaults/skills ]; then
    mkdir -p /root/workspaces/${agentId}/skills
    cp -r /tmp/vera-defaults/skills/* /root/workspaces/${agentId}/skills/ 2>/dev/null || true
    echo "[wake] skills actualizadas: $(ls -1 /root/workspaces/${agentId}/skills | wc -l)"
  fi
fi

PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 http://checkip.amazonaws.com || hostname -I | awk '{print $1}')
curl -sf --max-time 15 -X POST ${callbackUrl}/internal/server-ready \\
  -H "Content-Type: application/json" \\
  -H "x-webhook-secret: ${webhookSecret}" \\
  -d "{\\"org_id\\":\\"${orgId}\\",\\"server_ip\\":\\"$PUBLIC_IP\\",\\"server_port\\":${ORG_BRIDGE_PORT},\\"org_token\\":\\"${orgToken}\\",\\"agent_id\\":\\"${agentId}\\"}"
`;
}

// ── CRUD de servidores ────────────────────────────────────────────────────────

export async function createOrgServer(org) {
  const { id: orgId, name: orgName } = org;
  // La hora de la marca, que ya vive en `organizations.timezone`.
  const zonaHoraria = org.timezone || ZONA_HORARIA_POR_DEFECTO;
  // El plan y su precio salen de la suscripcion, no de una columna inventada.
  const { planId: plan, precio } = await _planDeLaOrg(orgId);
  const orgToken    = generateOrgToken();
  const agentId     = deriveAgentId(orgId);
  const serverName  = buildServerName(orgId, orgName);
  const serverType  = tipoDeServidorPorPrecio(precio);
  const model       = MODELS_BY_PLAN[plan] || MODELS_BY_PLAN.starter;
  console.log(`hetzner: org ${String(orgId).slice(0, 8)} plan=${plan} ($${precio}/mes) → ${serverType}, tz=${zonaHoraria}`);
  const location    = process.env.HETZNER_LOCATION || "nbg1";
  const snapshotId  = process.env.HETZNER_SNAPSHOT_ID || null;
  // AI_ENGINE_PUBLIC_URL = URL externa (Cloudflare Tunnel) que los org-servers
  // usan para hacer callback. AI_ENGINE_URL local (5.161.x.x:3000) NO funciona
  // desde fuera porque UFW solo expone puerto 22 — el tráfico HTTP entra via tunnel.
  const callbackUrl    = process.env.AI_ENGINE_PUBLIC_URL || process.env.AI_ENGINE_URL || "http://5.161.243.1:3000";
  const webhookSecret  = process.env.INTERNAL_WEBHOOK_SECRET || "";
  const anthropicKey   = process.env.ANTHROPIC_API_KEY || "";
  const openaiKey      = process.env.OPENAI_API_KEY || "";
  const openclawToken  = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const supabaseUrl    = process.env.SUPABASE_URL || "";
  const supabaseKey    = process.env.SUPABASE_SERVICE_KEY || "";

  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY no configurado en .env — no se puede provisionar");
  }

  // USER.md = el manifiesto de identidad de la marca (brand-dna-generator),
  // horneado en provision. En runtime lo actualiza syncOrgUserMd tras regenerar
  // el DNA. Si aun no hay manifiesto, cae al stub minimo dentro del generador.
  let userMdContent = null;
  try {
    const { data: dna } = await supabase
      .from("brand_dna_generations")
      .select("dna_text")
      .eq("organization_id", orgId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dna && dna.dna_text) {
      userMdContent = "# A QUIEN SIRVO\n\n> La marca que cuido, en su propia voz. Es la identidad que asumo cuando hablo por ella; no un dato para citar.\n\n" + String(dna.dna_text).trim() + "\n";
    }
  } catch (_) {}

  const userData = _generateCloudInitScript({
    orgId, orgName, orgToken, agentId, serverName,
    userMdContent, zonaHoraria,
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
    openclawGatewayToken: openclawToken,
    callbackUrl, webhookSecret, model,
    supabaseUrl, supabaseServiceKey: supabaseKey,
  });

  const payload = {
    name:        serverName,
    server_type: serverType,
    location,
    image:       snapshotId || "ubuntu-24.04",
    user_data:   userData,
    ssh_keys:    [107329413],   // Mac key (FEAT-014 deploy 2026-05-12)
    labels: {
      type:     "org-server",
      org_id:   orgId,
      agent_id: agentId,
    },
  };

  console.log(`[hetzner] Creando servidor "${serverName}" para org "${orgId}" (type: ${serverType}, model: ${model}, loc: ${location})...`);
  const data = await _hetznerRequest("POST", "/servers", payload);
  const hetznerServerId = data.server?.id;

  if (!hetznerServerId) {
    throw new Error("Hetzner API no retorno server.id en la respuesta de creacion");
  }

  console.log(`[hetzner] Servidor #${hetznerServerId} "${serverName}" creado — cloud-init en curso...`);
  return { hetznerServerId, orgToken, agentId, serverName };
}

export async function deleteOrgServer(hetznerServerId) {
  if (!hetznerServerId) throw new Error("hetznerServerId requerido");
  console.log(`[hetzner] Eliminando servidor #${hetznerServerId}...`);
  await _hetznerRequest("DELETE", `/servers/${hetznerServerId}`);
  console.log(`[hetzner] Servidor #${hetznerServerId} eliminado`);
}

export async function getServerStatus(hetznerServerId) {
  const data = await _hetznerRequest("GET", `/servers/${hetznerServerId}`);
  return {
    id:      data.server?.id,
    status:  data.server?.status,
    ip:      data.server?.public_net?.ipv4?.ip || null,
    created: data.server?.created,
    name:    data.server?.name,
    labels:  data.server?.labels || {},
  };
}

export async function listOrgServers() {
  const data = await _hetznerRequest("GET", "/servers?label_selector=type%3Dorg-server");
  return (data.servers || []).map((s) => ({
    id:       s.id,
    name:     s.name,
    status:   s.status,
    ip:       s.public_net?.ipv4?.ip || null,
    orgId:    s.labels?.org_id || null,
    agentId:  s.labels?.agent_id || null,
    created:  s.created,
    serverType: s.server_type?.name || null,
  }));
}

// ── Snapshot / Sleep / Wake ───────────────────────────────────────────────────

export async function createServerSnapshot(hetznerServerId, description = "") {
  console.log(`[hetzner] Creando snapshot del servidor #${hetznerServerId}...`);
  const data = await _hetznerRequest("POST", `/servers/${hetznerServerId}/actions/create_image`, {
    type:        "snapshot",
    description: description || `org-snapshot-${hetznerServerId}-${Date.now()}`,
    labels: { type: "org-snapshot" },
  });
  const snapshotId = data.image?.id ?? null;
  console.log(`[hetzner] Snapshot #${snapshotId} creado para servidor #${hetznerServerId}`);
  return snapshotId;
}

export async function sleepOrgServer(hetznerServerId, orgId) {
  console.log(`[hetzner] Sleep org "${orgId}" — servidor #${hetznerServerId}...`);
  const snapshotId = await createServerSnapshot(hetznerServerId, `org-${orgId}-sleep`);
  if (!snapshotId) throw new Error("Snapshot fallo — abortando sleep");
  await _waitForActionComplete(hetznerServerId, "create_image");
  await deleteOrgServer(hetznerServerId);
  console.log(`[hetzner] Org "${orgId}" en sleep — snapshot #${snapshotId}`);
  return { snapshotId };
}

export async function wakeOrgServer(org, snapshotId) {
  const { id: orgId, name: orgName } = org;
  // Mismo criterio que al crear: si el plan cambio mientras dormia, despierta en
  // el tamano que le toca. Antes despertaba SIEMPRE en el mas pequeno, asi que un
  // resize hecho a mano se perdia en el primer ciclo de dormir/despertar.
  const { planId: plan, precio } = await _planDeLaOrg(orgId);
  const orgToken    = generateOrgToken();
  const agentId     = deriveAgentId(orgId);
  const serverName  = buildServerName(orgId, orgName);
  const serverType  = tipoDeServidorPorPrecio(precio);
  console.log(`hetzner: despertando ${String(orgId).slice(0, 8)} plan=${plan} ($${precio}/mes) → ${serverType}`);
  const location    = process.env.HETZNER_LOCATION || "nbg1";
  const callbackUrl = process.env.AI_ENGINE_PUBLIC_URL || process.env.AI_ENGINE_URL || "http://5.161.243.1:3000";
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const openclawTok  = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const secret       = process.env.INTERNAL_WEBHOOK_SECRET || "";

  const userData = _generateWakeScript({
    orgId, orgToken,
    anthropicApiKey: anthropicKey,
    openclawGatewayToken: openclawTok,
    callbackUrl, webhookSecret: secret,
  });

  const payload = {
    name:        serverName,
    server_type: serverType,
    location,
    image:       snapshotId,
    user_data:   userData,
    ssh_keys:    [107329413],   // Mac key (FEAT-014 deploy 2026-05-12)
    labels: { type: "org-server", org_id: orgId, agent_id: agentId },
  };

  console.log(`[hetzner] Despertando org "${orgId}" desde snapshot #${snapshotId}...`);
  const data = await _hetznerRequest("POST", "/servers", payload);
  const hetznerServerId = data.server?.id;
  if (!hetznerServerId) throw new Error("Hetzner no retorno server.id al recrear desde snapshot");
  console.log(`[hetzner] Servidor #${hetznerServerId} "${serverName}" recreado — wake en ~90s`);
  return { hetznerServerId, orgToken };
}

// ── Polling ───────────────────────────────────────────────────────────────────

export async function waitForServerRunning(hetznerServerId, timeoutMs = PROVISION_TIMEOUT_MS) {
  const start    = Date.now();
  const interval = 10_000;
  while (Date.now() - start < timeoutMs) {
    const { status, ip } = await getServerStatus(hetznerServerId);
    if (status === "running") {
      console.log(`[hetzner] Servidor #${hetznerServerId} → running (${Math.round((Date.now() - start) / 1000)}s)`);
      return { running: true, ip };
    }
    console.log(`[hetzner] Servidor #${hetznerServerId} → ${status} (${Math.round((Date.now() - start) / 1000)}s)...`);
    await new Promise((r) => setTimeout(r, interval));
  }
  console.warn(`[hetzner] Timeout esperando servidor #${hetznerServerId}`);
  return { running: false, ip: null };
}

async function _waitForActionComplete(hetznerServerId, actionType, timeoutMs = 5 * 60 * 1000) {
  const start    = Date.now();
  const interval = 5_000;
  while (Date.now() - start < timeoutMs) {
    const data    = await _hetznerRequest("GET", `/servers/${hetznerServerId}/actions`);
    const actions = data.actions || [];
    const target  = actions.find((a) => a.command === actionType && a.status !== "success" && a.status !== "error");
    if (!target) return;
    if (target.status === "error") throw new Error(`Accion Hetzner "${actionType}" fallo: ${target.error?.message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function verifyHetznerConnection() {
  try {
    const data = await _hetznerRequest("GET", "/servers?per_page=1");
    return { ok: true, serverCount: data.meta?.pagination?.total_entries ?? 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
