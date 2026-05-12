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
import { startOrgSyncService }  from "./services/org-sync.service.js";
import { startTokenRefreshService } from "./services/token-refresh.service.js";
import { startBrandSensorSync } from "./services/brand-sensor-sync.service.js";

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
});
