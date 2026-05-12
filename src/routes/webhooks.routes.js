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

const router = express.Router();

// req.rawBody es inyectado por el middleware global express.json({ verify: (req,_,buf) => req.rawBody=buf })
// definido en index.js — disponible aquí sin middlewares adicionales en la ruta.
// El HMAC de Supabase se valida en signalWebhookController usando req.rawBody.
router.post("/signal", signalWebhookController);

// El usuario o el sistema envía una URL para análisis inmediato
router.post("/url-trigger", urlTriggerController);

// Admin: forzar ciclo de scraping manual
router.post("/run-scraper", runScraperController);

export default router;
