import express from "express";
import {
  orgCreated,
  serverReady,
  listInstances,
  autonomyChanged,
  syncOrgs,
  sleepOrg,
  wakeOrg,
  deleteOrgHetznerServer,
  listHetznerServers,
  hetznerStatus,
  forceRemoteHealthCheck,
  serveDefaultsTarball,
  serveMcpServer,
  serveAnthropicProxy,
  approveVeraAction,
  rejectVeraAction,
  listVeraActions,
  crawlSiteHandler,
  brandScrapeStart,
  brandScrapeStatus,
  requireInternalKey,
} from "../controllers/internal.controller.js";
import { userAuthMiddleware } from "../middleware/auth.middleware.js";
import { runAutoLinkCycle } from "../services/recommendation-auto-link.service.js";
import { deliverCycleFeed, isCycleComplete } from "../services/vera-brain-feed.service.js";
import { supabase } from "../lib/supabase.js";
import crypto from "crypto";

const router = express.Router();

// ── Webhooks de Supabase (autenticados con x-webhook-secret) ─────────────────
router.post("/org-created",   orgCreated);   // trigger v9: nueva organización
router.post("/server-ready",  serverReady);  // org-server notifica que está listo (cloud-init completo)
router.post("/crawl-site",  crawlSiteHandler); // BFS recursivo brand-scraper Fase 1
router.post("/brand-scrape/start",  brandScrapeStart);
router.get("/brand-scrape/status/:jobId", brandScrapeStatus);

// ── Defaults tarball (para cloud-init de org-servers) ─────────────────────────
router.get("/defaults.tar.gz", serveDefaultsTarball);

// ── MCP server JS (descargado en wake/cloud-init para instalar el cliente MCP)
router.get("/mcp-server.js", serveMcpServer);

// ── Anthropic proxy JS (descargado en cloud-init — fuera de user_data para
//    mantener payload < 32 KB que es el límite duro de Hetzner Cloud)
router.get("/anthropic-proxy.js", serveAnthropicProxy);

// ── Admin (autenticados con X-Internal-Key) ───────────────────────────────────
router.post("/sync-orgs",     syncOrgs);     // fuerza sincronización de orgs huérfanas
router.get("/instances",      listInstances);

// ── Hetzner API (rutas estáticas ANTES de las dinámicas con :orgId) ───────────
router.get("/hetzner/servers", listHetznerServers);
router.get("/hetzner/status",  hetznerStatus);

// ── Health checks remotos ─────────────────────────────────────────────────────
router.post("/health/remote",  forceRemoteHealthCheck);

// ── Gestión de org-servers (rutas dinámicas con :orgId) ──────────────────────
router.post("/org/:orgId/autonomy-changed", autonomyChanged);
router.post("/org/:orgId/sleep",   sleepOrg);
router.post("/org/:orgId/wake",    wakeOrg);
router.delete("/org/:orgId/server", deleteOrgHetznerServer);

// ── VERA Pending Actions (Fase IV) — auth via JWT user, no admin token ───────
router.get("/vera-actions",            userAuthMiddleware, listVeraActions);
router.post("/vera-actions/:id/approve", userAuthMiddleware, approveVeraAction);
router.post("/vera-actions/:id/reject",  userAuthMiddleware, rejectVeraAction);

// ── Learning loop: linkea recomendaciones → posts publicados + mide outcomes ──
// GATEADO con X-Internal-Key (requireInternalKey): son operaciones del control
// plane que disparan trabajo/costo. Antes iban SIN auth — cualquiera con la URL
// forzaba el ciclo. (Auditoría seguridad 2026-07-02, C1.)
router.post("/recommendations/auto-link", requireInternalKey, async (req, res) => {
  try {
    const result = await runAutoLinkCycle();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/recommendations/measure-outcomes", requireInternalKey, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("measure_recommendation_outcomes", {});
    if (error) throw new Error(error.message);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── VERA Brain Feed: dispara el ciclo completo (compile + deliver + execute) ─
// POST /internal/vera-brain-feed/run/:brandContainerId
// GATEADO con X-Internal-Key: deliverCycleFeed corre un ciclo AUTÓNOMO de Vera
// (LLM + tools que escriben/actúan) sobre la org dueña del brandContainerId.
// Sin auth, cualquiera con un brand_container_id quemaba presupuesto y mutaba
// datos de un tenant ajeno. (Auditoría seguridad 2026-07-02, C1.)
router.post("/vera-brain-feed/run/:brandContainerId", requireInternalKey, async (req, res) => {
  try {
    const cycleId = req.body?.cycle_id || crypto.randomUUID();
    const result = await deliverCycleFeed(req.params.brandContainerId, cycleId);
    res.json({ ok: true, cycle_id: cycleId, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/vera-brain-feed/ready/:brandContainerId", requireInternalKey, async (req, res) => {
  try {
    const ready = await isCycleComplete(req.params.brandContainerId);
    res.json({ ok: true, ready });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
