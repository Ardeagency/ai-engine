/**
 * Job Worker Service — consume agent_queue_jobs y ejecuta análisis via org-server remoto.
 *
 * PROBLEMA QUE RESUELVE:
 *   signal-webhook.controller crea registros en agent_queue_jobs con status="queued",
 *   pero sin este worker nadie los procesa. Los jobs se acumulan eternamente.
 *
 * Envía el prompt de análisis al org-server Hetzner de la organización via HTTP.
 */
import { createClient } from "@supabase/supabase-js";
import { getOrgEntry } from "./openclaw.registry.js";
import { notifyUser } from "./notification.service.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

const WORKER_ID        = `worker_${process.pid}_${Date.now()}`;
const POLL_INTERVAL_MS = 10_000;
const LOCK_TTL_MIN     = 5;
const JOB_TIMEOUT_MS   = 180_000;
const MAX_CONCURRENT   = 3;

// Multi-platform populator registry (shopify, amazon, mercadolibre, woocommerce, ...)
// Cada platform vive en /services/populators/<platform>.populator.js
import { getPopulatorForMission, getAllHandledMissions } from "./populators/index.js";

let _activeJobs  = 0;
let _pollerTimer = null;

async function tryLockJob(jobId) {
  const { data, error } = await supabase
    .from("agent_queue_jobs")
    .update({
      status:     "assigned",
      locked_by:  WORKER_ID,
      locked_at:  new Date().toISOString(),
      started_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "queued")
    .is("locked_by", null)
    .select()
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

async function releaseStaleJobs() {
  const cutoff = new Date(Date.now() - LOCK_TTL_MIN * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("agent_queue_jobs")
    .update({ status: "queued", locked_by: null, locked_at: null })
    .eq("status", "assigned")
    .lt("locked_at", cutoff)
    .neq("locked_by", WORKER_ID)
    .select("id");

  if (data?.length) {
    console.log(`job-worker: liberados ${data.length} jobs con lock vencido`);
  }
}

function buildAnalysisPrompt(job, orgMemoryDir) {
  // content_text fue renombrado desde content_preview — soportar ambos para compatibilidad
  const { signal_type, entity_name, content_text, content_preview, threat_level, signal_id } = job.payload || {};
  const rawContent = content_text || content_preview || "{}";
  const shortId    = (signal_id || "x").replace(/-/g, "").slice(0, 8);
  const signalFile = orgMemoryDir
    ? `${orgMemoryDir}/signal-${shortId}.md`
    : `memory/signal-${shortId}.md`;
  const alertsFile = orgMemoryDir ? `${orgMemoryDir}/alerts-active.md` : `memory/alerts-active.md`;

  if (signal_type === "url_change") {
    const preview = (() => {
      try {
        const parsed = JSON.parse(rawContent);
        return parsed.excerpt?.slice(0, 800) || parsed.label || "(sin extracto)";
      } catch { return String(rawContent).slice(0, 800); }
    })();

    return [
      "TAREA: Cambio detectado en URL de competidor. Sin texto introductorio.",
      `Competidor: ${entity_name || "desconocido"}`,
      `Nivel de amenaza: ${threat_level || "medium"}`,
      `Extracto del cambio:\n${preview}`,
      "",
      "Usa el skill competitor-post-analyzer para el análisis.",
      `Escribe resultado en: ${signalFile}`,
      "Responde: SIGNAL_ANALYZED",
    ].join("\n");
  }

  const postData = (() => {
    try { return JSON.parse(rawContent); }
    catch { return {}; }
  })();

  return [
    "TAREA: Nuevo post de competidor detectado. Sin texto introductorio.",
    `Competidor: ${entity_name || "desconocido"}`,
    `Red: ${postData.network || "desconocida"} | URL: ${postData.url || "n/a"}`,
    `Contenido: ${postData.content || postData.caption || postData.excerpt || "(sin texto)"}`,
    `Engagement: ${postData.like_count || 0} likes, ${postData.comment_count || 0} comentarios`,
    `Nivel de amenaza: ${threat_level || "medium"}`,
    "",
    "Usa el skill competitor-post-analyzer:",
    "1. Analizar tipo, detección de promoción, nivel de amenaza real",
    "2. Recomendar acción (NADA / MONITOREAR / RESPONDER)",
    `3. Escribir en: ${signalFile}`,
    `Si es HIGH o CRITICAL, también actualizar: ${alertsFile}`,
    "Responde: SIGNAL_ANALYZED",
  ].join("\n");
}

async function runJobWithOpenClaw(job) {
  const orgEntry = getOrgEntry(job.organization_id);
  if (!orgEntry || orgEntry.type !== "remote") {
    throw new Error(`Org "${job.organization_id}" sin org-server remoto registrado — job omitido`);
  }

  const sessionId = `job-${job.id.replace(/-/g, "").slice(0, 16)}`;
  const prompt    = buildAnalysisPrompt(job, null);

  const url = `http://${orgEntry.ip}:${orgEntry.port}/agent/run`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Org-Token":  orgEntry.token,
    },
    body:    JSON.stringify({ agentId: orgEntry.agentId, message: prompt, sessionId }),
    signal:  AbortSignal.timeout(JOB_TIMEOUT_MS + 5_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`org-server respondió ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(`org-server error: ${data.error || "respuesta inesperada"}`);
  return data.output || "";
}

async function markJobCompleted(job, resultText) {
  // resultText puede ser:
  //   - string (analysis): output texto de OpenClaw → guardamos length + success
  //   - objeto (mission shopify): detalle estructurado → preservamos campos + success
  const normalizedResult = (typeof resultText === "string")
    ? { output_length: resultText.length, success: true }
    : { ...(resultText || {}), success: resultText?.ok ?? resultText?.success ?? true };

  await supabase
    .from("agent_queue_jobs")
    .update({
      status:       "completed",
      completed_at: new Date().toISOString(),
      result:       normalizedResult,
      locked_by:    null,
    })
    .eq("id", job.id);

  const missionId = job.payload?.mission_id;
  if (missionId) {
    await supabase
      .from("body_missions")
      .update({
        status:           "completed",
        result_reference: { job_id: job.id, completed_at: new Date().toISOString() },
        updated_at:       new Date().toISOString(),
      })
      .eq("id", missionId);

    await supabase
      .from("mission_runs")
      .update({ status: "completed", completed_at: new Date().toISOString(), result: { success: true } })
      .eq("job_id", job.id);
  }

  try {
    await _notifyOwnerOfJobCompletion(job);
  } catch (e) {
    console.error("[job-worker] notify error (non-blocking):", e.message);
  }
}

async function _notifyOwnerOfJobCompletion(job) {
  const { data: org } = await supabase
    .from("organizations")
    .select("owner_user_id")
    .eq("id", job.organization_id)
    .maybeSingle();
  if (!org?.owner_user_id) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", org.owner_user_id)
    .maybeSingle();

  const threatLevel = job.payload?.threat_level;
  const isHighThreat = ["high", "critical"].includes(threatLevel);

  const templates = {
    analysis: {
      title:   "VERA completó un análisis",
      message: `Se completó un análisis estratégico sobre ${job.payload?.entity_name || "un competidor"}. Revísalo en tu panel.`,
      type:    "info",
      link_to: "https://app.aismartcontent.io/intelligence",
    },
    mission: {
      title:   "VERA ejecutó una misión",
      message: "Una misión fue completada exitosamente.",
      type:    "success",
      link_to: "https://app.aismartcontent.io/missions",
    },
    sensor: {
      title:   "Sensor completado",
      message: "Un sensor de monitoreo finalizó su ciclo.",
      type:    "info",
      link_to: null,
    },
  };

  const base = templates[job.job_type] || {
    title:   "VERA completó una tarea",
    message: "Una tarea en background fue completada.",
    type:    "info",
    link_to: null,
  };

  const notif = isHighThreat
    ? {
        ...base,
        title:   `⚠️ Alerta estratégica detectada`,
        message: `VERA detectó una señal de amenaza nivel ${threatLevel} sobre ${job.payload?.entity_name || "un competidor"}. Revisión inmediata recomendada.`,
        type:    "warning",
      }
    : base;

  await notifyUser({
    user_id:    org.owner_user_id,
    user_email: profile?.email,
    ...notif,
    send_email: isHighThreat,
  });
}

async function markJobFailed(job, errorMessage) {
  const newAttempts = (job.attempts || 0) + 1;
  const isFinal     = newAttempts >= (job.max_attempts || 3);
  const retryDelay  = Math.pow(2, newAttempts) * 30_000;

  await supabase
    .from("agent_queue_jobs")
    .update({
      status:        isFinal ? "failed" : "queued",
      attempts:      newAttempts,
      error_message: errorMessage.slice(0, 500),
      locked_by:     null,
      locked_at:     null,
      run_after:     isFinal
        ? new Date().toISOString()
        : new Date(Date.now() + retryDelay).toISOString(),
    })
    .eq("id", job.id);

  if (isFinal) {
    const missionId = job.payload?.mission_id;
    if (missionId) {
      await supabase.from("body_missions")
        .update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", missionId);
      await supabase.from("mission_runs")
        .update({ status: "failed", completed_at: new Date().toISOString(), error_message: errorMessage.slice(0, 500) })
        .eq("job_id", job.id);
    }
    console.error(`job-worker: job ${job.id} FALLIDO definitivamente tras ${newAttempts} intentos — ${errorMessage.slice(0, 120)}`);
  } else {
    console.warn(`job-worker: job ${job.id} intento ${newAttempts}/${job.max_attempts || 3} — reintento en ${retryDelay / 1000}s`);
  }
}

async function processJob(job) {
  console.log(`job-worker: ejecutando job ${job.id} | type=${job.job_type} | priority=${job.priority}`);
  _activeJobs++;
  try {
    // ── analysis (existente) ──────────────────────────────────────────────
    if (job.job_type === "analysis") {
      const result = await runJobWithOpenClaw(job);
      await markJobCompleted(job, result);
      console.log(`job-worker: job ${job.id} OK`);
      return;
    }

    // ── mission: multi-platform populator (Fase 2B) ──────────────────────
    if (job.job_type === "mission") {
      const missionType = job?.payload?.mission_type;
      if (missionType && getPopulatorForMission(missionType)) {
        // Dynamic import del registry: defensivo. Si un populator tiene bug,
        // el worker sigue arrancando; solo este job falla.
        const { processIntegrationJob } = await import("./populators/index.js");
        const result = await processIntegrationJob(job);
        await markJobCompleted(job, result);
        console.log(`job-worker: job ${job.id} OK (${missionType})`);
        return;
      }
      await markJobCompleted(job, `mission_type "${missionType}" no manejado`);
      return;
    }

    // ── otros job_types: no manejado por ahora ────────────────────────────
    await markJobCompleted(job, `job_type "${job.job_type}" no manejado`);
  } catch (e) {
    await markJobFailed(job, e.message || "Error desconocido");
  } finally {
    _activeJobs--;
  }
}

async function pollJobs() {
  await releaseStaleJobs().catch(() => {});

  const freeSlots = MAX_CONCURRENT - _activeJobs;
  if (freeSlots <= 0) return;

  const { data: jobs } = await supabase
    .from("agent_queue_jobs")
    .select("*")
    .eq("status", "queued")
    .is("locked_by", null)
    .lte("run_after", new Date().toISOString())
    .order("priority", { ascending: false })
    .order("run_after",  { ascending: true })
    .limit(freeSlots);

  if (!jobs?.length) return;

  for (const job of jobs) {
    const locked = await tryLockJob(job.id);
    if (!locked) continue;
    processJob(locked).catch((e) =>
      console.error(`job-worker: error inesperado en job ${locked.id} —`, e.message)
    );
  }
}

export function startJobWorker() {
  if (_pollerTimer) return;

  const poll = async () => {
    try { await pollJobs(); }
    catch (e) { console.warn("job-worker: poll error —", e.message); }
    _pollerTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
  console.log(`job-worker: iniciado (id=${WORKER_ID}, poll=${POLL_INTERVAL_MS / 1000}s, max=${MAX_CONCURRENT})`);
}

export function stopJobWorker() {
  if (_pollerTimer) {
    clearTimeout(_pollerTimer);
    _pollerTimer = null;
    console.log("job-worker: detenido");
  }
}
