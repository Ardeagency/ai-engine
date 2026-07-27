/**
 * Audit Logger — log estructurado persistente de todas las operaciones de IA.
 *
 * Registra (en consola + opcionalmente en Supabase):
 *   - tool_requested   — OpenClaw pidió ejecutar una tool
 *   - tool_executed    — tool ejecutada exitosamente
 *   - tool_denied      — tool bloqueada (policy, consent, phase, schema)
 *   - tool_timeout     — tool superó el timeout
 *   - consent_gate     — se pidió confirmación humana
 *   - policy_denied    — plan/rol no permite la acción
 *   - session_created  — nueva sesión de OpenClaw iniciada
 *   - session_expired  — sesión expirada/limpiada
 *   - budget_exceeded  — presupuesto de tools o tokens agotado
 *   - schema_invalid   — output de OpenClaw rechazado por schema
 *   - request_start    — inicio de request al AI service
 *   - request_end      — fin de request con resumen
 *
 * Formato de cada entrada:
 * {
 *   "at": "ISO timestamp",
 *   "event": "tool_executed",
 *   "org": "uuid",
 *   "user": "uuid",
 *   "conv": "uuid",
 *   "tool": "getProducts",
 *   "ms": 45,
 *   "detail": { ... }
 * }
 *
 * Para persistir en DB: agregar tabla ai_audit_logs en Supabase (ver SQL al final).
 */
import { supabase } from "./supabase.js";

const PERSIST_TO_DB = process.env.AUDIT_LOG_DB === "true";

// ── Core ───────────────────────────────────────────────────────────────────

function buildEntry(event, ctx, detail = {}) {
  return {
    at: new Date().toISOString(),
    event,
    org: ctx?.organizationId ?? ctx?.org ?? "-",
    user: ctx?.userId ?? ctx?.user ?? "-",
    conv: ctx?.conversationId ?? ctx?.conv ?? "-",
    ...detail,
  };
}

function emit(entry) {
  // Siempre a stdout como JSON estructurado (recogible por cualquier log aggregator)
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);
}

async function persistToDb(entry) {
  if (!PERSIST_TO_DB) return;
  try {
    await supabase.from("ai_audit_logs").insert({
      event_type: entry.event,
      organization_id: entry.org !== "-" ? entry.org : null,
      user_id: entry.user !== "-" ? entry.user : null,
      conversation_id: entry.conv !== "-" ? entry.conv : null,
      tool_name: entry.tool ?? null,
      duration_ms: entry.ms ?? null,
      detail: entry,
      created_at: entry.at,
    });
  } catch (e) {
    // No propagamos errores de auditoría para no romper el flujo principal
    console.warn("[AUDIT] Error persistiendo en DB:", e.message);
  }
}

function log(event, ctx, detail = {}) {
  const entry = buildEntry(event, ctx, detail);
  emit(entry);
  persistToDb(entry); // fire-and-forget
}

// ── Contador de tools por organización ───────────────────────────────────────
// vera_session_audit.tool_calls salía VACÍO en todas las sesiones de dashboard,
// aunque el log mostrara ~16 tools por sesión: Vera las llama por MCP desde el
// org-server y esas ejecuciones no pasaban por el contador local de la sesión.
// Sin esto no había forma de distinguir una lectura investigada de una escrita
// de memoria. El contador vive en proceso (barato, sin I/O) y las sesiones de
// dashboard toman una foto antes y después; corren en serie por organización,
// así que el delta le corresponde a la sesión que lo mide.
const _toolTally = new Map(); // organizationId → Map<toolName, veces>

function _tally(organizationId, toolName) {
  if (!organizationId || organizationId === "-" || !toolName) return;
  let porOrg = _toolTally.get(organizationId);
  if (!porOrg) { porOrg = new Map(); _toolTally.set(organizationId, porOrg); }
  porOrg.set(toolName, (porOrg.get(toolName) || 0) + 1);
}

/** Foto del acumulado de una organización. Pásasela luego a toolTallyDelta. */
export function toolTallySnapshot(organizationId) {
  return new Map(_toolTally.get(organizationId) || []);
}

/** Qué tools se ejecutaron desde la foto: [{ name, count }] ordenado por uso. */
export function toolTallyDelta(organizationId, snapshot) {
  const ahora = _toolTally.get(organizationId) || new Map();
  const out = [];
  for (const [name, count] of ahora) {
    const antes = snapshot?.get(name) || 0;
    if (count > antes) out.push({ name, count: count - antes });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ── Public API ────────────────────────────────────────────────────────────────

export const audit = {
  requestStart(ctx, detail = {}) {
    log("request_start", ctx, detail);
  },

  requestEnd(ctx, { toolCount, creditsDeducted, durationMs }) {
    log("request_end", ctx, { tools: toolCount, credits: creditsDeducted, ms: durationMs });
  },

  toolRequested(ctx, toolName, params = {}) {
    log("tool_requested", ctx, { tool: toolName, params_keys: Object.keys(params) });
  },

  toolExecuted(ctx, toolName, durationMs) {
    _tally(ctx?.organizationId || ctx?.org, toolName);
    log("tool_executed", ctx, { tool: toolName, ms: durationMs });
  },

  toolDenied(ctx, toolName, reason, code) {
    log("tool_denied", ctx, { tool: toolName, reason, code });
  },

  toolTimeout(ctx, toolName, timeoutMs) {
    log("tool_timeout", ctx, { tool: toolName, timeout_ms: timeoutMs });
  },

  consentGate(ctx, consentKey) {
    log("consent_gate", ctx, { consent_key: consentKey });
  },

  policyDenied(ctx, action, reason) {
    log("policy_denied", ctx, { action, reason });
  },

  sessionCreated(ctx, sessionId, phase) {
    log("session_created", ctx, { session_id: sessionId, phase });
  },

  sessionExpired(ctx, sessionId) {
    log("session_expired", ctx, { session_id: sessionId });
  },

  budgetExceeded(ctx, type, current, max) {
    log("budget_exceeded", ctx, { budget_type: type, current, max });
  },

  schemaInvalid(ctx, direction, errors) {
    log("schema_invalid", ctx, { direction, errors: errors.slice(0, 3) });
  },

  phaseBlocked(ctx, toolName, currentPhase, requiredPhase) {
    log("phase_blocked", ctx, { tool: toolName, current_phase: currentPhase, required_phase: requiredPhase });
  },
};

/*
  ──────────────────────────────────────────────────────────────────────────────
  SQL SUGERIDO para activar persistencia en DB:
  (correr en Supabase SQL editor si quieres AUDIT_LOG_DB=true)

  CREATE TABLE IF NOT EXISTS public.ai_audit_logs (
    id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    event_type      text NOT NULL,
    organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
    user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    conversation_id uuid,
    tool_name       text,
    duration_ms     integer,
    detail          jsonb DEFAULT '{}'::jsonb,
    created_at      timestamptz DEFAULT now()
  );

  CREATE INDEX ai_audit_logs_org_idx  ON public.ai_audit_logs(organization_id);
  CREATE INDEX ai_audit_logs_evt_idx  ON public.ai_audit_logs(event_type);
  CREATE INDEX ai_audit_logs_time_idx ON public.ai_audit_logs(created_at DESC);

  ALTER TABLE public.ai_audit_logs ENABLE ROW LEVEL SECURITY;
  -- Solo service_role puede leer/escribir (ai-engine usa service key)
  CREATE POLICY "service only" ON public.ai_audit_logs
    USING (false) WITH CHECK (false);
  ──────────────────────────────────────────────────────────────────────────────
*/
