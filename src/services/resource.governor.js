/**
 * Resource Governor — decide qué puede ejecutarse según el estado del servidor.
 *
 * Principio: AI-ENGINE pone la disciplina.
 *
 * Aplica:
 *   1. Límites de concurrencia global (agentes activos, jobs corriendo)
 *   2. Límites por organización (circuit breaker por org)
 *   3. Decisiones basadas en estado de salud del servidor
 *   4. Prioridades: critical > high > medium > low
 *
 * Límites para servidor Hetzner 8vCPU / 32GB:
 *   green:  max 8 agentes pesados, 20 jobs medianos
 *   yellow: max 6 agentes, 15 jobs
 *   orange: max 4 agentes, 8 jobs, solo high/critical
 *   red:    max 2 agentes, 3 jobs, solo critical
 */
import { getCurrentHealth, canAcceptNewWork } from "./server.health.service.js";
import { getActiveAgentCount } from "./agent.manager.js";
import { supabase } from "../lib/supabase.js";
import { audit } from "../lib/audit-logger.js";

// ── Límites de concurrencia por estado ───────────────────────────────────────

const CONCURRENCY_LIMITS = {
  green:  { agents: 8,  jobs: 20, heavyJobsPerOrg: 1 },
  yellow: { agents: 6,  jobs: 15, heavyJobsPerOrg: 1 },
  orange: { agents: 4,  jobs: 8,  heavyJobsPerOrg: 1 },
  red:    { agents: 2,  jobs: 3,  heavyJobsPerOrg: 0 },
};

// Tipos de job por peso
const HEAVY_JOB_TYPES    = ["mission", "analysis", "report"];
const MEDIUM_JOB_TYPES   = ["sensor", "trigger"];
const LIGHT_JOB_TYPES    = ["chat"];

// Cooldown por org después de un rate-limit (ms)
const ORG_COOLDOWN_MS = 60_000;
const _orgCooldowns = new Map(); // orgId → timestamp when cooldown expires

// ── Helpers ───────────────────────────────────────────────────────────────────

function getJobWeight(jobType) {
  if (HEAVY_JOB_TYPES.includes(jobType))  return "heavy";
  if (MEDIUM_JOB_TYPES.includes(jobType)) return "medium";
  return "light";
}

function priorityToNumber(priority) {
  const map = { critical: 1, high: 2, medium: 5, low: 8 };
  return map[priority] ?? 5;
}

async function getRunningJobsCount(organizationId = null) {
  let query = supabase
    .from("agent_queue_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");

  if (organizationId) query = query.eq("organization_id", organizationId);

  const { count } = await query;
  return count ?? 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verifica si se puede levantar un nuevo agente.
 * @param {string} organizationId
 * @param {"critical"|"high"|"medium"|"low"} priority
 * @returns {{ allowed: boolean, reason?: string }}
 */
export async function canLaunchAgent(organizationId, priority = "medium") {
  const auditCtx = { organizationId };

  if (!canAcceptNewWork(priority)) {
    const health = getCurrentHealth();
    audit.budgetExceeded(auditCtx, "server_health", health.cpu, 100);
    return {
      allowed: false,
      reason: `Servidor en estado ${health.state.toUpperCase()}. No se pueden levantar agentes con prioridad "${priority}".`,
    };
  }

  const health = getCurrentHealth();
  const limits = CONCURRENCY_LIMITS[health.state] ?? CONCURRENCY_LIMITS.red;
  const activeAgents = getActiveAgentCount();

  if (activeAgents >= limits.agents) {
    return {
      allowed: false,
      reason: `Límite de agentes concurrentes alcanzado (${activeAgents}/${limits.agents}) en estado ${health.state}.`,
    };
  }

  return { allowed: true };
}

/**
 * Verifica si una organización puede encolar un nuevo job.
 * @param {string} organizationId
 * @param {string} jobType
 * @param {"critical"|"high"|"medium"|"low"} priority
 * @returns {{ allowed: boolean, reason?: string }}
 */
export async function canEnqueueJob(organizationId, jobType, priority = "medium") {
  const auditCtx = { organizationId };

  // 1. Cooldown de la org
  const cooldownExpiry = _orgCooldowns.get(organizationId);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainingSec = Math.ceil((cooldownExpiry - Date.now()) / 1000);
    return {
      allowed: false,
      reason: `Organización en cooldown por exceso de tareas. Espera ${remainingSec}s.`,
    };
  }

  // 2. Estado del servidor
  if (!canAcceptNewWork(priority)) {
    const health = getCurrentHealth();
    return {
      allowed: false,
      reason: `Servidor en estado ${health.state.toUpperCase()}. Tarea "${jobType}" pospuesta.`,
    };
  }

  // 3. Jobs globales en ejecución
  const health = getCurrentHealth();
  const limits = CONCURRENCY_LIMITS[health.state] ?? CONCURRENCY_LIMITS.red;
  const runningGlobal = await getRunningJobsCount();

  if (runningGlobal >= limits.jobs) {
    return {
      allowed: false,
      reason: `Límite de jobs concurrentes alcanzado (${runningGlobal}/${limits.jobs}).`,
    };
  }

  // 4. Jobs pesados por org
  const weight = getJobWeight(jobType);
  if (weight === "heavy") {
    const runningForOrg = await getRunningJobsCount(organizationId);
    if (runningForOrg >= limits.heavyJobsPerOrg) {
      return {
        allowed: false,
        reason: `Esta organización ya tiene ${runningForOrg} tarea(s) pesada(s) en ejecución. Máximo: ${limits.heavyJobsPerOrg}.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Aplica cooldown a una org que está abusando de recursos.
 * Llámalo si una org genera demasiados jobs en poco tiempo.
 */
export function throttleOrg(organizationId, reason = "rate_limit") {
  const expiry = Date.now() + ORG_COOLDOWN_MS;
  _orgCooldowns.set(organizationId, expiry);
  console.warn(`[governor] Org ${organizationId} en cooldown (${reason}) hasta ${new Date(expiry).toISOString()}`);
}

/**
 * Retorna la política de concurrencia activa según el estado del servidor.
 */
export function getCurrentPolicy() {
  const health = getCurrentHealth();
  const limits = CONCURRENCY_LIMITS[health.state] ?? CONCURRENCY_LIMITS.red;

  return {
    health_state: health.state,
    max_agents: limits.agents,
    max_jobs: limits.jobs,
    max_heavy_jobs_per_org: limits.heavyJobsPerOrg,
    cpu_percent: health.cpu,
    ram_percent: health.ram,
    active_agents: getActiveAgentCount(),
  };
}

/**
 * Prioridad numérica para ordering en la cola (menor = más urgente).
 */
export function getJobPriority(jobType, userPriority = "medium") {
  const base = priorityToNumber(userPriority);
  // Chat siempre gana sobre tareas batch
  const typeBonus = jobType === "chat" ? -1 : 0;
  return Math.max(1, base + typeBonus);
}
