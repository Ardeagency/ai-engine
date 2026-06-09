/**
 * Webhook Routes — endpoints para eventos externos y automatizaciones.
 *
 * POST /webhooks/signal      → Supabase Database Webhook (nueva señal de competidor)
 * POST /webhooks/url-trigger → Convierte una URL en trigger de análisis inmediato
 * POST /webhooks/run-scraper → Fuerza ciclo de scraping (admin, requires token)
 *
 * Estos endpoints no requieren auth de usuario — tienen su propia validación:
 *   - /signal:      HMAC de Supabase (X-Supabase-Signature header)
 *   - /url-trigger: Bearer token de la org (validación ligera por organizationId)
 *   - /run-scraper: X-Internal-Token header
 */
import express from "express";
import {
  signalWebhookController,
  urlTriggerController,
  runScraperController,
} from "../controllers/signal-webhook.controller.js";
import { enqueueComfyFlow, enqueueStudioComfyRun } from "../services/comfy-flow-runner.service.js";

const router = express.Router();

// req.rawBody es inyectado por el middleware global express.json({ verify: (req,_,buf) => req.rawBody=buf })
// definido en index.js — disponible aquí sin middlewares adicionales en la ruta.
// El HMAC de Supabase se valida en signalWebhookController usando req.rawBody.
router.post("/signal", signalWebhookController);

// El usuario o el sistema envía una URL para análisis inmediato
router.post("/url-trigger", urlTriggerController);

// Admin: forzar ciclo de scraping manual
router.post("/run-scraper", runScraperController);

// FEAT-033: dispara un flow ComfyUI manual (encola en comfy_flow_jobs)
router.post("/comfy/run", async (req, res) => {
  try {
    const { organizationId, brandContainerId, scheduleId, flowSlug, inputs } = req.body || {};
    if (!organizationId || !flowSlug) return res.status(400).json({ error: "organizationId y flowSlug requeridos" });
    const jobId = await enqueueComfyFlow({ organizationId, brandContainerId, scheduleId, flowSlug, inputs, source: "user" });
    res.json({ enqueued: true, jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Opcion A: puente Studio (frontend) -> ComfyUI. El boton "Run" del Studio postea aqui su
// webhookBody (payload + rpc_build_manual_context). Reusa el flow_run ya creado por el frontend
// (capability via meta.run_id) -> el poll del Studio encuentra los outputs en su propio runId.
router.post("/comfy/studio-run", async (req, res) => {
  try {
    const out = await enqueueStudioComfyRun(req.body || {});
    res.json({ enqueued: true, ...out });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
