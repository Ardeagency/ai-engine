/**
 * Agent Manager — gestión del ciclo de vida de agentes OpenClaw.
 *
 * Estados de un agente:
 *   stopped   → provisionado pero no activo
 *   starting  → proceso de arranque en curso
 *   ready     → activo y disponible para tareas
 *   busy      → ejecutando una tarea
 *   idle      → activo pero sin tarea (cuenta para idle timeout)
 *   degraded  → respondiendo pero con errores
 *   failed    → falló demasiadas veces → quarantine
 *
 * Políticas:
 *   - Idle timeout: si un agente lleva AGENT_IDLE_TIMEOUT_MS sin tarea, se detiene
 *   - Circuit breaker: si falla CIRCUIT_BREAKER_THRESHOLD veces seguidas → quarantine
 *   - Max concurrencia: el Resource Governor decide si se puede levantar uno nuevo
 *   - Aislamiento: una org nunca puede tocar el agente de otra
 */
import { supabase } from "../lib/supabase.js";
import { provisionAgent } from "./agent.provisioner.js";
import { audit } from "../lib/audit-logger.js";

const AGENT_IDLE_TIMEOUT_MS      = Number(process.env.AGENT_IDLE_TIMEOUT_MS) || 15 * 60 * 1000; // 15 min
const CIRCUIT_BREAKER_THRESHOLD  = Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5;
const HEALTH_PING_INTERVAL_MS    = 30_000; // 30s

// ── In-memory fleet state ─────────────────────────────────────────────────────
// Clave: organizationId → FleetEntry
const _fleet = new Map();

// FleetEntry = {
//   organizationId, agentId, status, startedAt, lastTaskAt,
//   currentTask, consecutiveFailures, pingTimer, idleTimer
// }

// ── Idle watchdog ─────────────────────────────────────────────────────────────

function startIdleTimer(organizationId) {
  const entry = _fleet.get(organizationId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);

  entry.idleTimer = setTimeout(async () => {
    const current = _fleet.get(organizationId);
    if (!current || current.status === "busy") return;

    console.log(`[agent.manager] Idle timeout para org ${organizationId} → deteniendo agente`);
    await stopAgent(organizationId, "idle_timeout");
  }, AGENT_IDLE_TIMEOUT_MS);
}

// ── DB sync helpers ───────────────────────────────────────────────────────────
// La arquitectura v3 usa openclaw_instances como fuente de verdad para el estado
// del agente. ai_agents / ai_agent_runtime fueron tablas legacy del control plane
// que usan UUIDs distintos al agentId en memoria → se synca contra openclaw_instances.

async function syncRuntimeToDB(organizationId, patch) {
  // Mapear campos de runtime a columnas disponibles en openclaw_instances
  const mappedPatch = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined)    mappedPatch.status = patch.status;
  if (patch.started_at !== undefined) mappedPatch.started_at = patch.started_at;

  await supabase
    .from("openclaw_instances")
    .update(mappedPatch)
    .eq("organization_id", organizationId);
}

async function syncAgentStatusToDB(organizationId, status) {
  // Mapear estados de agente a valores de openclaw_instances.status
  const instanceStatus =
    status === "active" ? "healthy"
    : status === "idle"   ? "healthy"
    : status === "failed" ? "failed"
    : status === "stopped" ? "stopped"
    : "healthy";

  await supabase
    .from("openclaw_instances")
    .update({ status: instanceStatus, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Obtiene o levanta el agente para una organización.
 * Provisiona automáticamente si no existe.
 * Retorna el entry de la flota (con agentId, status, etc.)
 *
 * @param {string} organizationId
 * @returns {object} fleetEntry
 */
export async function getOrSpawnAgent(organizationId) {
  let entry = _fleet.get(organizationId);

  // Si ya está listo/busy en memoria, retornarlo
  if (entry && (entry.status === "ready" || entry.status === "busy")) {
    return entry;
  }

  // Circuit breaker: si está en quarantine, rechazar
  if (entry?.status === "failed") {
    throw Object.assign(
      new Error(`El agente para esta organización está en cuarentena por fallos repetidos. Contacta soporte.`),
      { statusCode: 503, agentFailed: true }
    );
  }

  // Provisionar si no existe en DB
  const agent = await provisionAgent(organizationId);

  // Crear o restaurar entry en flota
  const now = Date.now();
  const newEntry = {
    organizationId,
    agentId: agent.id,
    workspacePath: agent.workspace_path,
    status: "starting",
    startedAt: now,
    lastTaskAt: now,
    currentTask: null,
    consecutiveFailures: entry?.consecutiveFailures || 0,
    pingTimer: null,
    idleTimer: null,
  };

  _fleet.set(organizationId, newEntry);

  // "Arrancar" el agente — en stub: simplemente marcar ready
  // Cuando OpenClaw runtime real esté conectado: spawn proceso aquí
  newEntry.status = "ready";

  await syncRuntimeToDB(organizationId, {
    status: "ready",
    started_at: new Date().toISOString(),
    last_ping_at: new Date().toISOString(),
  });
  await syncAgentStatusToDB(organizationId, "active");

  audit.sessionCreated({ organizationId }, `fleet:${organizationId}`, agent.tool_phase || "A");

  // Iniciar idle timer
  startIdleTimer(organizationId);

  console.log(`[agent.manager] Agente levantado para org ${organizationId}`);
  return newEntry;
}

/**
 * Marca el agente como "busy" al comenzar una tarea.
 */
export function markAgentBusy(organizationId, taskDescription) {
  const entry = _fleet.get(organizationId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  entry.status = "busy";
  entry.currentTask = taskDescription;
  entry.lastTaskAt = Date.now();

  syncRuntimeToDB(organizationId, {
    status: "busy",
    current_task: taskDescription,
    last_ping_at: new Date().toISOString(),
  }).catch(() => {});
}

/**
 * Marca el agente como "idle" al terminar una tarea.
 */
export function markAgentIdle(organizationId) {
  const entry = _fleet.get(organizationId);
  if (!entry) return;

  entry.status = "idle";
  entry.currentTask = null;
  entry.lastTaskAt = Date.now();
  entry.consecutiveFailures = 0; // reset en éxito

  syncRuntimeToDB(organizationId, {
    status: "idle",
    current_task: null,
    last_ping_at: new Date().toISOString(),
    consecutive_failures: 0,
  }).catch(() => {});

  startIdleTimer(organizationId);
}

/**
 * Registra un fallo en el agente. Si supera el threshold → quarantine.
 */
export function recordAgentFailure(organizationId, errorMessage) {
  const entry = _fleet.get(organizationId);
  if (!entry) return;

  entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
  entry.status = entry.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD ? "failed" : "degraded";

  syncRuntimeToDB(organizationId, {
    status: entry.status,
    current_task: null,
    consecutive_failures: entry.consecutiveFailures,
    last_ping_at: new Date().toISOString(),
  }).catch(() => {});

  if (entry.status === "failed") {
    syncAgentStatusToDB(organizationId, "failed").catch(() => {});
    console.error(`[agent.manager] Agente en CUARENTENA para org ${organizationId} (${entry.consecutiveFailures} fallos)`);
  }
}

/**
 * Detiene el agente. Persiste el estado y limpia la entrada en flota.
 */
export async function stopAgent(organizationId, reason = "manual") {
  const entry = _fleet.get(organizationId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  clearInterval(entry.pingTimer);

  entry.status = "stopped";

  await syncRuntimeToDB(organizationId, {
    status: "stopped",
    current_task: null,
    last_ping_at: new Date().toISOString(),
  });
  await syncAgentStatusToDB(organizationId, "idle");

  _fleet.delete(organizationId);
  console.log(`[agent.manager] Agente detenido para org ${organizationId} (razón: ${reason})`);
}

/**
 * Retorna el estado actual del agente para una org.
 * Consulta primero la memoria en-flota, luego la DB.
 */
export async function getAgentStatus(organizationId) {
  const entry = _fleet.get(organizationId);
  if (entry) {
    return {
      source: "memory",
      organizationId,
      agentId: entry.agentId,
      status: entry.status,
      currentTask: entry.currentTask,
      lastTaskAt: entry.lastTaskAt ? new Date(entry.lastTaskAt).toISOString() : null,
      consecutiveFailures: entry.consecutiveFailures,
      idleFor: entry.status === "idle" ? Date.now() - entry.lastTaskAt : null,
    };
  }

  // Fallback a openclaw_instances (fuente de verdad v3 — ai_agents/ai_agent_runtime
  // fueron drop en migración 2026-04-28).
  const { data: instance } = await supabase
    .from("openclaw_instances")
    .select("agent_id, status, workspace_path, last_healthy_at, last_request_at, last_activity_at, sleeping")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!instance) {
    return { source: "db", organizationId, status: "not_provisioned" };
  }

  return {
    source: "db",
    organizationId,
    agentId:       instance.agent_id,
    status:        instance.sleeping ? "sleeping" : instance.status,
    lastHealthyAt: instance.last_healthy_at,
    lastActivityAt: instance.last_activity_at,
    lastRequestAt:  instance.last_request_at,
    workspacePath:  instance.workspace_path,
  };
}

/**
 * Retorna un snapshot de toda la flota activa.
 */
export function getFleetSnapshot() {
  const snapshot = [];
  for (const [orgId, entry] of _fleet.entries()) {
    snapshot.push({
      organizationId: orgId,
      agentId: entry.agentId,
      status: entry.status,
      currentTask: entry.currentTask,
      lastTaskAt: entry.lastTaskAt ? new Date(entry.lastTaskAt).toISOString() : null,
    });
  }
  return snapshot;
}

/** Cantidad de agentes activos en memoria. */
export function getActiveAgentCount() {
  return [..._fleet.values()].filter((e) => ["ready","busy","idle","degraded"].includes(e.status)).length;
}
