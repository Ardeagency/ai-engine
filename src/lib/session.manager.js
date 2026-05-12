/**
 * Session Manager — aislamiento de sesiones por org/conversación.
 *
 * Cada sesión de OpenClaw es independiente y tiene:
 *   - sessionId  = "<organizationId>:<conversationId>"
 *   - tokenBudgetUsed / tokenBudgetMax — presupuesto de tokens por sesión
 *   - toolCallCount / toolCallMax      — presupuesto de tool calls por sesión
 *   - approvedIntents                  — Set de intents aprobados en esta sesión
 *   - startedAt / lastActivityAt       — para TTL
 *
 * La fase activa (A/B/C) la gestiona autonomy.js basada en level_of_autonomy de la org.
 *
 * NUNCA se comparte una sesión entre dos organizaciones distintas.
 *
 * Límites:
 *   - SESSION_TTL_MS   — inactividad máxima antes de expirar (default: 30 min)
 *   - TOKEN_BUDGET     — tokens estimados máximos por sesión (default: 10,000)
 *   - TOOL_CALL_BUDGET — total de tool calls en toda la sesión (default: 50)
 */
import { audit } from "./audit-logger.js";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000; // 30 min
const TOKEN_BUDGET   = Number(process.env.SESSION_TOKEN_BUDGET) || 10_000;
const TOOL_BUDGET    = Number(process.env.SESSION_TOOL_BUDGET) || 50;

// Store en memoria (suficiente para un solo proceso; para multi-instancia usar Redis)
const _sessions = new Map();

// Limpieza periódica de sesiones expiradas (cada 5 minutos)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of _sessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      audit.sessionExpired(
        { organizationId: session.organizationId, conversationId: session.conversationId },
        id
      );
      _sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Session model ─────────────────────────────────────────────────────────────

function makeSessionId(organizationId, conversationId) {
  return `${organizationId}:${conversationId}`;
}

function createSession(organizationId, conversationId, approvedIntents) {
  const sessionId = makeSessionId(organizationId, conversationId);
  const now = Date.now();

  const session = {
    sessionId,
    organizationId,
    conversationId,
    tokenBudgetUsed: 0,
    tokenBudgetMax: TOKEN_BUDGET,
    toolCallCount: 0,
    toolCallMax: TOOL_BUDGET,
    approvedIntents: new Set(approvedIntents instanceof Set ? approvedIntents : []),
    startedAt: now,
    lastActivityAt: now,
  };

  _sessions.set(sessionId, session);
  audit.sessionCreated({ organizationId, conversationId }, sessionId, null);
  return session;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Obtiene o crea la sesión para una org+conversación.
 * Si la sesión expiró por TTL, crea una nueva.
 *
 * @param {string} organizationId
 * @param {string} conversationId
 * @param {Set} approvedIntents — intents aprobados en esta request (se mergen a la sesión)
 */
export function getOrCreateSession(organizationId, conversationId, approvedIntents) {
  const sessionId = makeSessionId(organizationId, conversationId);
  const existing = _sessions.get(sessionId);

  if (existing) {
    const now = Date.now();
    if (now - existing.lastActivityAt > SESSION_TTL_MS) {
      // Sesión expirada — crear nueva
      audit.sessionExpired({ organizationId, conversationId }, sessionId);
      _sessions.delete(sessionId);
      return createSession(organizationId, conversationId, approvedIntents);
    }
    // Sesión vigente — actualizar actividad y merear intents nuevos
    existing.lastActivityAt = now;
    if (approvedIntents instanceof Set) {
      for (const intent of approvedIntents) existing.approvedIntents.add(intent);
    }
    return existing;
  }

  return createSession(organizationId, conversationId, approvedIntents);
}

/**
 * Verifica que la sesión tiene presupuesto de tool calls disponible.
 * @throws si el presupuesto está agotado
 */
export function checkToolBudget(session, additionalCalls = 1) {
  const ctx = {
    organizationId: session.organizationId,
    conversationId: session.conversationId,
  };

  if (session.toolCallCount + additionalCalls > session.toolCallMax) {
    audit.budgetExceeded(
      ctx,
      "tool_calls",
      session.toolCallCount,
      session.toolCallMax
    );
    throw Object.assign(
      new Error(
        `Presupuesto de herramientas de la sesión agotado ` +
        `(${session.toolCallCount}/${session.toolCallMax}). ` +
        `Inicia una nueva conversación para continuar.`
      ),
      { statusCode: 429 }
    );
  }
}

/**
 * Registra el uso de tool calls en la sesión.
 */
export function recordToolCalls(session, count) {
  session.toolCallCount += count;
  session.lastActivityAt = Date.now();
}

/**
 * Verifica y registra uso de tokens estimados.
 * @param {number} estimatedTokens — estimación basada en longitud de mensajes
 */
export function checkAndRecordTokens(session, estimatedTokens) {
  const ctx = {
    organizationId: session.organizationId,
    conversationId: session.conversationId,
  };

  if (session.tokenBudgetUsed + estimatedTokens > session.tokenBudgetMax) {
    audit.budgetExceeded(
      ctx,
      "tokens",
      session.tokenBudgetUsed,
      session.tokenBudgetMax
    );
    throw Object.assign(
      new Error(
        `Presupuesto de tokens de la sesión agotado ` +
        `(~${session.tokenBudgetUsed}/${session.tokenBudgetMax}). ` +
        `Inicia una nueva conversación para continuar.`
      ),
      { statusCode: 429 }
    );
  }

  session.tokenBudgetUsed += estimatedTokens;
}

/**
 * Estima tokens de un mensaje (simple: 1 token ≈ 4 chars).
 */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/**
 * Termina/limpia una sesión explícitamente.
 */
export function clearSession(organizationId, conversationId) {
  const sessionId = makeSessionId(organizationId, conversationId);
  _sessions.delete(sessionId);
}

/**
 * Elimina TODAS las sesiones activas de una organización.
 * Llamar cuando el nivel de autonomía baja — los intents aprobados
 * bajo permisos más altos dejan de ser válidos.
 *
 * @param {string} organizationId
 * @returns {number} cantidad de sesiones eliminadas
 */
export function clearOrgSessions(organizationId) {
  let count = 0;
  for (const [sessionId, session] of _sessions.entries()) {
    if (session.organizationId === organizationId) {
      audit.sessionExpired({ organizationId, conversationId: session.conversationId }, sessionId);
      _sessions.delete(sessionId);
      count++;
    }
  }
  return count;
}

/** Retorna métricas de la sesión actual (para logging). */
export function getSessionSummary(session) {
  return {
    sessionId: session.sessionId,
    toolCallCount: session.toolCallCount,
    toolCallMax: session.toolCallMax,
    tokenBudgetUsed: session.tokenBudgetUsed,
    tokenBudgetMax: session.tokenBudgetMax,
    approvedIntents: [...session.approvedIntents],
    ageMs: Date.now() - session.startedAt,
  };
}
