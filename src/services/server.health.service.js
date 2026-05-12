/**
 * Server Health Service — monitoreo continuo del servidor de control y org-servers remotos.
 *
 * Ciclo local (HEALTH_CHECK_INTERVAL_MS, default 15s):
 *   - CPU %   (media de los load averages del OS)
 *   - RAM %   (os.totalmem / os.freemem)
 *   - Disco % (via df del filesystem raíz)
 *   - Agentes activos
 *   - Jobs en cola
 *
 * Ciclo remoto (REMOTE_HEALTH_CHECK_INTERVAL_MS, default 60s):
 *   - HTTP GET /health a cada org-server en el registry de tipo 'remote'
 *   - Si no responde en 10s → markOrgDegraded + update DB
 *   - Si responde después de estar degraded → markOrgHealthy + update DB
 *
 * Estado de salud del control plane:
 *   green  → operación normal
 *   yellow → carga moderada, reducir concurrencia
 *   orange → carga alta, congelar tareas no críticas
 *   red    → carga crítica, solo chat prioritario
 *
 * Se accede al estado actual con getCurrentHealth() — sin DB, desde memoria.
 * Guarda snapshot en system_metrics cada PERSIST_INTERVAL_CYCLES ciclos.
 */
import os from "os";
import { execSync } from "child_process";
import { supabase } from "../lib/supabase.js";
import { getActiveAgentCount } from "./agent.manager.js";
import { getAllOrgs, markOrgDegraded, markOrgHealthy } from "./openclaw.registry.js";
import { logProvisioningEvent } from "../lib/provisioning-events.js";

const HEALTH_CHECK_INTERVAL_MS        = Number(process.env.HEALTH_CHECK_INTERVAL_MS)        || 15_000;  // 15s
const REMOTE_HEALTH_CHECK_INTERVAL_MS = Number(process.env.REMOTE_HEALTH_CHECK_INTERVAL_MS) || 60_000;  // 60s
const PERSIST_EVERY_N_CYCLES          = Number(process.env.HEALTH_PERSIST_CYCLES)           || 4;       // ~60s
const REMOTE_PING_TIMEOUT_MS          = 10_000; // 10s por org-server

// ── Thresholds ────────────────────────────────────────────────────────────────
const THRESHOLDS = {
  yellow: { cpu: 65, ram: 70 },
  orange: { cpu: 75, ram: 80 },
  red:    { cpu: 88, ram: 90 },
};

// ── In-memory state ───────────────────────────────────────────────────────────
let _currentHealth = {
  state:        "green",
  cpu:          0,
  ram:          0,
  disk:         0,
  ramUsedMb:    0,
  ramTotalMb:   0,
  activeAgents: 0,
  queuedJobs:   0,
  updatedAt:    null,
};

let _cycleCount          = 0;
let _healthCheckTimer    = null;
let _remoteHealthTimer   = null;

// ── CPU measurement ───────────────────────────────────────────────────────────

function getCpuPercent() {
  try {
    const loadAvg1m = os.loadavg()[0];
    const cpuCount  = os.cpus().length;
    const percent   = (loadAvg1m / cpuCount) * 100;
    return Math.min(Math.round(percent), 100);
  } catch (_) {
    return 0;
  }
}

// ── RAM measurement ───────────────────────────────────────────────────────────

function getRamInfo() {
  const total   = os.totalmem();
  const free    = os.freemem();
  const used    = total - free;
  const percent = Math.round((used / total) * 100);
  return {
    percent,
    usedMb:  Math.round(used  / 1024 / 1024),
    totalMb: Math.round(total / 1024 / 1024),
  };
}

// ── Disk measurement ──────────────────────────────────────────────────────────

function getDiskPercent() {
  try {
    const output = execSync("df -h / | tail -1 | awk '{print $5}'", { timeout: 2000 })
      .toString().trim().replace("%", "");
    return parseInt(output, 10) || 0;
  } catch (_) { return 0; }
}

function getDiskUsedGb() {
  try {
    const output = execSync("df -BG / | tail -1 | awk '{print $3}'", { timeout: 2000 })
      .toString().trim().replace("G", "");
    return parseInt(output, 10) || 0;
  } catch (_) { return 0; }
}

// ── Health state calculation ──────────────────────────────────────────────────

function calculateHealthState(cpu, ram) {
  if (cpu >= THRESHOLDS.red.cpu    || ram >= THRESHOLDS.red.ram)    return "red";
  if (cpu >= THRESHOLDS.orange.cpu || ram >= THRESHOLDS.orange.ram) return "orange";
  if (cpu >= THRESHOLDS.yellow.cpu || ram >= THRESHOLDS.yellow.ram) return "yellow";
  return "green";
}

// ── Queue count ───────────────────────────────────────────────────────────────

async function getQueuedJobsCount() {
  try {
    const { count } = await supabase
      .from("agent_queue_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    return count ?? 0;
  } catch (_) { return 0; }
}

async function getRunningJobsCount() {
  try {
    const { count } = await supabase
      .from("agent_queue_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running");
    return count ?? 0;
  } catch (_) { return 0; }
}

// ── Persist to DB ─────────────────────────────────────────────────────────────

async function persistMetrics(snap) {
  try {
    await supabase.from("system_metrics").insert({
      cpu_percent:   snap.cpu,
      ram_percent:   snap.ram,
      ram_used_mb:   snap.ramUsedMb,
      ram_total_mb:  snap.ramTotalMb,
      disk_percent:  snap.disk,
      active_agents: snap.activeAgents,
      queued_jobs:   snap.queuedJobs,
      running_jobs:  snap.runningJobs || 0,
      health_state:  snap.state,
      snapshot:      snap,
    });
  } catch (e) {
    console.warn("[health] Error guardando métricas en DB:", e.message);
  }
}

// ── Main local check cycle ────────────────────────────────────────────────────

async function runHealthCheck() {
  const cpu         = getCpuPercent();
  const ram         = getRamInfo();
  const disk        = getDiskPercent();
  const queuedJobs  = await getQueuedJobsCount();
  const runningJobs = await getRunningJobsCount();
  const activeAgents = getActiveAgentCount();

  const state     = calculateHealthState(cpu, ram.percent);
  const prevState = _currentHealth.state;

  _currentHealth = {
    state,
    cpu,
    ram:        ram.percent,
    disk,
    ramUsedMb:  ram.usedMb,
    ramTotalMb: ram.totalMb,
    diskUsedGb: getDiskUsedGb(),
    activeAgents,
    queuedJobs,
    runningJobs,
    updatedAt:  new Date().toISOString(),
  };

  if (state !== prevState) {
    const emoji = { green: "🟢", yellow: "🟡", orange: "🟠", red: "🔴" }[state] || "⚪";
    console.log(`[health] ${emoji} Estado → ${state.toUpperCase()} (CPU: ${cpu}% RAM: ${ram.percent}% Disco: ${disk}%)`);
  }

  _cycleCount++;
  if (_cycleCount % PERSIST_EVERY_N_CYCLES === 0) {
    await persistMetrics(_currentHealth);
  }
}

// ── Remote org-server health checks ──────────────────────────────────────────

/**
 * Verifica la salud de todos los org-servers remotos en el registry.
 * Llama a GET /health en cada uno. Si no responde en REMOTE_PING_TIMEOUT_MS:
 *  1. Marca como degraded en el registry
 *  2. Actualiza openclaw_instances en Supabase
 *
 * Si un org degradado vuelve a responder:
 *  1. Marca como healthy en el registry
 *  2. Actualiza openclaw_instances en Supabase
 */
async function runRemoteHealthChecks() {
  const allOrgs = getAllOrgs();
  const remoteOrgs = allOrgs.filter((o) => o.type === "remote");

  if (!remoteOrgs.length) return;

  const checks = remoteOrgs.map(async (orgEntry) => {
    const { organizationId, ip, port, status: currentStatus } = orgEntry;
    const url = `http://${ip}:${port}/health`;

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REMOTE_PING_TIMEOUT_MS),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Respondió OK
      if (currentStatus === "degraded") {
        markOrgHealthy(organizationId);
        await supabase
          .from("openclaw_instances")
          .update({ status: "healthy", updated_at: new Date().toISOString() })
          .eq("organization_id", organizationId);
        await logProvisioningEvent({
          organizationId,
          eventType: "health_check_passed",
          phase:     "complete",
          message:   `Org-server recuperado (${ip}:${port})`,
          metadata:  { ip, port, recovered_from: "degraded" },
        });
        console.log(`[health] org-server "${organizationId}" recuperado (${ip}:${port})`);
      }
    } catch (e) {
      // Sin respuesta — solo loguear y marcar si cambia el estado
      if (currentStatus !== "degraded" && currentStatus !== "sleeping") {
        markOrgDegraded(organizationId);
        await supabase
          .from("openclaw_instances")
          .update({ status: "degraded", updated_at: new Date().toISOString() })
          .eq("organization_id", organizationId);
        await logProvisioningEvent({
          organizationId,
          eventType: "health_check_failed",
          phase:     "complete",
          message:   `Org-server no responde: ${e.message}`,
          metadata:  { ip, port, error: e.message?.slice(0, 200) },
        });
        await logProvisioningEvent({
          organizationId,
          eventType: "server_degraded",
          phase:     "complete",
          message:   `Estado cambió a degraded`,
          metadata:  { ip, port },
        });
        console.warn(
          `[health] org-server "${organizationId}" no responde (${ip}:${port}): ${e.message}`
        );
      }
    }
  });

  await Promise.allSettled(checks);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Retorna el estado de salud actual del control plane (en memoria, sin DB). */
export function getCurrentHealth() {
  return { ..._currentHealth };
}

/** Retorna true si el estado es green o yellow. */
export function isHealthyEnough() {
  return ["green", "yellow"].includes(_currentHealth.state);
}

/** Retorna true si el control plane puede aceptar nueva carga. */
export function canAcceptNewWork(priority = "medium") {
  const { state } = _currentHealth;
  if (state === "green")  return true;
  if (state === "yellow") return true;
  if (state === "orange") return ["critical", "high"].includes(priority);
  if (state === "red")    return priority === "critical";
  return false;
}

/** Inicia el loop de health checks. Llamar una vez al arrancar. */
export function startHealthService() {
  if (_healthCheckTimer) return; // ya iniciado

  // Primera lectura inmediata del control plane
  runHealthCheck().catch(console.error);

  _healthCheckTimer = setInterval(() => {
    runHealthCheck().catch(console.error);
  }, HEALTH_CHECK_INTERVAL_MS);

  if (_healthCheckTimer.unref) _healthCheckTimer.unref();

  // Health checks a org-servers remotos — arrancan 30s después del boot
  // para dar tiempo a que initRegistry() cargue las instancias
  setTimeout(() => {
    runRemoteHealthChecks().catch(console.error);

    _remoteHealthTimer = setInterval(() => {
      runRemoteHealthChecks().catch(console.error);
    }, REMOTE_HEALTH_CHECK_INTERVAL_MS);

    if (_remoteHealthTimer.unref) _remoteHealthTimer.unref();
    console.log(`[health] Remote health checks activados (ciclo: ${REMOTE_HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
  }, 30_000);

  console.log(`[health] Health service iniciado (local: ${HEALTH_CHECK_INTERVAL_MS}ms, remote: ${REMOTE_HEALTH_CHECK_INTERVAL_MS}ms)`);
}

/** Detiene el health service. */
export function stopHealthService() {
  if (_healthCheckTimer) {
    clearInterval(_healthCheckTimer);
    _healthCheckTimer = null;
  }
  if (_remoteHealthTimer) {
    clearInterval(_remoteHealthTimer);
    _remoteHealthTimer = null;
  }
}

/** Retorna el historial reciente de métricas desde la DB (últimas N entradas). */
export async function getMetricsHistory(limit = 20) {
  const { data, error } = await supabase
    .from("system_metrics")
    .select("cpu_percent, ram_percent, disk_percent, active_agents, queued_jobs, health_state, captured_at")
    .order("captured_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/**
 * Fuerza un health check remoto inmediato (útil para endpoints admin).
 * @returns {Promise<Array>} Lista de orgs verificadas con su estado
 */
export async function checkRemoteOrgsNow() {
  await runRemoteHealthChecks();
  return getAllOrgs()
    .filter((o) => o.type === "remote")
    .map(({ organizationId, ip, port, status }) => ({ organizationId, ip, port, status }));
}
