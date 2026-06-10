/**
 * MCP Controller — endpoint que recibe tool calls del MCP server distribuido en cada org-server.
 *
 * Flujo:
 *   1. MCP server local (en el org-server de Vera) recibe llamada via stdio de OpenClaw
 *   2. Hace HTTP POST a /mcp/dispatch con X-Org-Token + { tool, params, conversation_id? }
 *   3. ai-engine resuelve organizationId del token (anti-spoofing), construye secCtx, llama dispatchTool
 *   4. Devuelve resultado o error estructurado
 *
 * CRÍTICO:
 *   - El organizationId se DERIVA del X-Org-Token, NUNCA del body. Esto previene cross-tenant.
 *   - Solo /mcp/dispatch ejecuta. /mcp/list-tools y /mcp/health son read-only.
 *   - approvedIntents se reconstruye desde la conversación si conversation_id viene en el body.
 */
import { supabase } from "../lib/supabase.js";
import { dispatchTool } from "../services/tool.dispatcher.js";
import { getOrgAutonomy } from "../lib/autonomy.js";
import { TOOLS_BY_PHASE } from "../lib/tool-phases.js";
import { TOOL_SCHEMAS } from "../lib/tool-call.validator.js";
import { audit } from "../lib/audit-logger.js";

// Cache de auth por token — TTL corto, evita pegarle a la DB en cada call
const _authCache = new Map();
const AUTH_CACHE_TTL = 60_000;

async function _resolveOrgFromToken(token) {
  if (!token || token.length < 16) return null;

  const cached = _authCache.get(token);
  if (cached && Date.now() < cached.expiresAt) return cached.organizationId;

  const { data, error } = await supabase
    .from("openclaw_instances")
    .select("organization_id")
    .eq("org_token", token)
    .maybeSingle();

  if (error || !data?.organization_id) return null;

  _authCache.set(token, {
    organizationId: data.organization_id,
    expiresAt: Date.now() + AUTH_CACHE_TTL,
  });
  return data.organization_id;
}

function _parseTaskEventContent(content) {
  const c = String(content || "");
  if (!c.startsWith("TASK_EVENT ")) return null;
  try { return JSON.parse(c.slice("TASK_EVENT ".length)); } catch (_) { return null; }
}

async function _loadApprovedIntents(conversationId) {
  if (!conversationId) return new Set();
  const { data: rows } = await supabase
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("role", "system")
    .order("created_at", { ascending: false })
    .limit(100);

  const approved = new Set();
  for (const r of rows || []) {
    const ev = _parseTaskEventContent(r.content);
    if (!ev?.checked) continue;
    const m = String(ev.task_text || "").match(/^APPROVE_ACTION:([A-Z0-9_:-]+)$/);
    if (m?.[1]) approved.add(m[1]);
  }
  return approved;
}

// ── POST /mcp/dispatch ────────────────────────────────────────────────────────
export const mcpDispatch = async (req, res) => {
  const token = req.headers["x-org-token"];
  const organizationId = await _resolveOrgFromToken(token);
  if (!organizationId) {
    return res.status(401).json({ ok: false, error: "Invalid or missing X-Org-Token" });
  }

  const { tool, params, conversation_id } = req.body || {};
  if (!tool || typeof tool !== "string") {
    return res.status(400).json({ ok: false, error: "tool is required" });
  }
  if (params != null && typeof params !== "object") {
    return res.status(400).json({ ok: false, error: "params must be an object" });
  }

  let autonomy;
  try {
    autonomy = await getOrgAutonomy(organizationId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `autonomy lookup failed: ${e.message}` });
  }

  const allowedTools = TOOLS_BY_PHASE[autonomy.phase] ?? TOOLS_BY_PHASE.A;
  const approvedIntents = await _loadApprovedIntents(conversation_id);

  const secCtx = {
    organizationId,
    userId: null,                  // MCP no tiene userId humano — Vera ejecuta en nombre de la org
    conversationId: conversation_id || null,
    approvedIntents,
    allowedTools,
    consentMode: autonomy.consentMode,
    orgName: autonomy.orgName,
  };

  audit.toolRequested(
    { organizationId, userId: null, conversationId: conversation_id || null },
    `mcp:${tool}`,
    params || {}
  );

  try {
    const result = await dispatchTool(tool, params || {}, secCtx);
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message,
      statusCode: e.statusCode || 500,
      requiresConsent: Boolean(e.requiresConsent),
      consentKey: e.consentKey || null,
      phaseBlocked: Boolean(e.phaseBlocked),
      policyDenied: Boolean(e.policyDenied),
    });
  }
};

const _AUTO_RESOLVED = new Set(["brandContainerId", "brand_container_id", "organizationId"]);
const _TYPE_MAP = { uuid: "string", object: "object", boolean: "boolean", string: "string" };
// Convierte el spec de TOOL_SCHEMAS (param->tipo) a un JSON Schema que el MCP
// server expone a Vera. brandContainerId/organizationId se auto-resuelven del
// token, asi que NUNCA son required. Los selectores uuid (entityId, feed_id,
// flowId, runId, campaignId) y el payload "params" si son required.
function _buildInputSchema(toolName) {
  const spec = TOOL_SCHEMAS[toolName] || {};
  const properties = {};
  const required = [];
  for (const [param, t] of Object.entries(spec)) {
    properties[param] = { type: _TYPE_MAP[t] || "string", description: `${param} (${t})` };
    if (!_AUTO_RESOLVED.has(param) && (t === "uuid" || param === "params")) required.push(param);
  }
  const schema = { type: "object", properties, additionalProperties: true };
  if (required.length) schema.required = required;
  return schema;
}

// ── GET /mcp/list-tools ───────────────────────────────────────────────────────
// Devuelve la lista de tools habilitadas para la org según su nivel actual.
// El MCP server local llama esto al startup y cuando se invalida cache.
export const mcpListTools = async (req, res) => {
  const token = req.headers["x-org-token"];
  const organizationId = await _resolveOrgFromToken(token);
  if (!organizationId) {
    return res.status(401).json({ ok: false, error: "Invalid or missing X-Org-Token" });
  }

  let autonomy;
  try {
    autonomy = await getOrgAutonomy(organizationId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `autonomy lookup failed: ${e.message}` });
  }

  const phaseTools = [...new Set(TOOLS_BY_PHASE[autonomy.phase] ?? TOOLS_BY_PHASE.A)];
  const tool_schemas = {};
  for (const name of phaseTools) tool_schemas[name] = _buildInputSchema(name);
  return res.json({
    ok: true,
    level: autonomy.level,
    phase: autonomy.phase,
    org_name: autonomy.orgName,
    tools: phaseTools,
    tool_schemas,
    cache_ttl_seconds: 60,
  });
};

// ── GET /mcp/health ───────────────────────────────────────────────────────────
// Para que el MCP server local verifique conectividad al startup.
export const mcpHealth = async (req, res) => {
  const token = req.headers["x-org-token"];
  const organizationId = await _resolveOrgFromToken(token);
  if (!organizationId) {
    return res.status(401).json({ ok: false, error: "Invalid or missing X-Org-Token" });
  }
  return res.json({ ok: true, organization_id: organizationId, server_time: new Date().toISOString() });
};
