import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import { requestLogger } from "./middleware/request-logger.js";
import chatRoutes from "./routes/chat.routes.js";
import agentsRoutes from "./routes/agents.routes.js";
import missionsRoutes from "./routes/missions.routes.js";
import taskRoutes from "./routes/task.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import serverRoutes from "./routes/server.routes.js";
import webhooksRoutes from "./routes/webhooks.routes.js";
import mcpRoutes from "./routes/mcp.routes.js";
import { initRegistry } from "./services/openclaw.registry.js";
import { startHealthService } from "./services/server.health.service.js";
import { startScraperScheduler } from "./services/social-scraper.service.js";
import { startJobWorker }       from "./services/job-worker.service.js";
import { startComfyFlowRunner } from "./services/comfy-flow-runner.service.js";
import { startOrgSyncService }  from "./services/org-sync.service.js";
import { startTokenRefreshService } from "./services/token-refresh.service.js";
import { startBrandSensorSync } from "./services/brand-sensor-sync.service.js";
import { startRecommendationAutoLink } from "./services/recommendation-auto-link.service.js";
import { startDailyBriefingJob } from "./services/daily-briefing-job.service.js";
import { startOutcomeMeasurement } from "./services/outcome-measurement.service.js";
import { retryOrphanReplies } from "./services/retry-orphan-replies.service.js";
import { startSelfRepair } from "./services/self-repair.service.js";
import { AVAILABLE_TOOL_NAMES } from "./services/tool.dispatcher.js";
import { TOOLS_BY_PHASE } from "./lib/tool-phases.js";

// ── Guard de arranque: phase ↔ registry ───────────────────────────────────────
// Toda tool listada en una fase (A/B/C) DEBE tener handler en TOOL_REGISTRY.
// Sin esto, una "tool fantasma" se le ofrece a Vera, ella la invoca y la allowlist
// la rechaza con un error que contradice su propio prompt. Falla ruidosa en boot
// en vez de error silencioso en chat. (deuda: vera-phase-catalog-sync)
{
  const registered = new Set(AVAILABLE_TOOL_NAMES);
  const phaseTools = new Set(Object.values(TOOLS_BY_PHASE).flat());
  const ghosts = [...phaseTools].filter((t) => !registered.has(t));
  if (ghosts.length) {
    console.error(`[boot] FATAL: tools en fase sin handler en TOOL_REGISTRY → ${ghosts.join(", ")}`);
    process.exit(1);
  }
  console.log(`[boot] phase↔registry OK — ${phaseTools.size} tools en fases, todas con handler`);
}

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// El callback `verify` captura el raw body ANTES de que express.json() lo parsee.
// Necesario para validar la firma HMAC de Supabase en /webhooks/signal,
// ya que Supabase firma los bytes exactos del body original (no el JSON re-serializado).
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(requestLogger);

app.get("/", (_req, res) =>
  res.send("AI Engine — Control Plane 🚀")
);

app.use("/chat", chatRoutes);
app.use("/agents", agentsRoutes);
app.use("/missions", missionsRoutes);
app.use("/task-events", taskRoutes);
app.use("/internal", internalRoutes);
app.use("/server", serverRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/mcp", mcpRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initRegistry().catch((e) =>
    console.warn("initRegistry error:", e.message)
  );
  startHealthService();

  // Scraper de competidores — arranca 2 min después del boot y corre cada 45 min
  // Deshabilitar con SCRAPER_ENABLED=false
  if (process.env.SCRAPER_ENABLED !== "false") {
    const intervalMin = parseInt(process.env.SCRAPER_INTERVAL_MINUTES || "45", 10);
    startScraperScheduler(intervalMin);
  }

  // Worker que consume agent_queue_jobs (análisis de señales de competidores)
  if (process.env.JOB_WORKER_ENABLED !== "false") {
    startJobWorker();
  }

  // Comfy flow runner (FEAT-033) — consume comfy_flow_jobs. Inerte salvo COMFY_BRIDGE_ENABLED=true.
  startComfyFlowRunner();

  // Red de seguridad: detecta orgs sin agente OpenClaw y las provisiona automáticamente.
  // Cubre el caso de webhook no configurado, caída del servidor en el momento del INSERT, etc.
  // Deshabilitar con ORG_SYNC_ENABLED=false
  if (process.env.ORG_SYNC_ENABLED !== "false") {
    startOrgSyncService();
  }

  // Refresh proactivo de tokens OAuth (Google) + warnings Meta.
  // Deshabilitar con TOKEN_REFRESH_ENABLED=false
  if (process.env.TOKEN_REFRESH_ENABLED !== "false") {
    startTokenRefreshService();
  }

  // Auto-crea los 7 sensores brand-wide en cada brand_container con integraciones
  // activas. Idempotente — corre cada 5 min y solo inserta si falta.
  // Deshabilitar con BRAND_SENSOR_SYNC_ENABLED=false
  if (process.env.BRAND_SENSOR_SYNC_ENABLED !== "false") {
    startBrandSensorSync();
  }

  // Cierra el loop de aprendizaje: linkea strategic_recommendations aprobadas
  // con posts publicados (match por similitud de copy_seed vs content real).
  // Sin esto, measure_recommendation_outcomes nunca tiene material y Vera no
  // aprende de sus propias predicciones. Cada 30 min.
  // Deshabilitar con RECOMMENDATION_AUTO_LINK_ENABLED=false
  if (process.env.RECOMMENDATION_AUTO_LINK_ENABLED !== "false") {
    startRecommendationAutoLink();
    startDailyBriefingJob();
  }

  // Loop de retroalimentación post-ejecución: mide outcomes de las
  // vera_pending_actions ejecutadas (reglas+math, sin LLM) y los persiste en
  // vera_action_outcomes para que Vera calibre confianza vía getActionOutcomes.
  // Cada 1h. Deshabilitar con OUTCOME_MEASUREMENT_ENABLED=false
  if (process.env.OUTCOME_MEASUREMENT_ENABLED !== "false") {
    startOutcomeMeasurement();
  }

  // Retry de respuestas huérfanas — corre 5s después de arrancar para que el
  // resto del stack (registry, supabase, openclaw connections) esté listo.
  // Reenvía cualquier mensaje user que se quedó sin respuesta en la última hora.
  // Cubre el caso: OpenClaw emite nuevo formato → parser falla → auto-repair
  // fixea + redeploya → al arrancar, esto retoma el mensaje que se perdió.
  // Deshabilitar con RETRY_ORPHAN_REPLIES_ENABLED=false
  if (process.env.RETRY_ORPHAN_REPLIES_ENABLED !== "false") {
    const runOrphan = () =>
      retryOrphanReplies()
        .then((r) => { if (r.retried) console.log(`retry-orphan: scan=${r.scanned} retried=${r.retried}`); })
        .catch((e) => console.warn("retry-orphan: error:", e.message));
    setTimeout(runOrphan, 5000);
    // Periódico: re-entrega la respuesta debida tras un auto-repair (o error
    // transitorio) sin esperar a un reinicio. Cap por conversación dentro del
    // servicio evita re-cobrar en loop sobre un error que no se arregla.
    const orphanMs = Number(process.env.RETRY_ORPHAN_INTERVAL_MS) || 240000; // 4 min
    setInterval(runOrphan, orphanMs);
  }

  // Detector de auto-reparación del sintetizador (lanza runner desacoplado).
  // Activar con SELF_REPAIR_ENABLED=true.
  startSelfRepair();
});
