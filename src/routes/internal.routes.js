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
  approveVeraAction,
  rejectVeraAction,
  listVeraActions,
} from "../controllers/internal.controller.js";
import { userAuthMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// ── Webhooks de Supabase (autenticados con x-webhook-secret) ─────────────────
router.post("/org-created",   orgCreated);   // trigger v9: nueva organización
router.post("/server-ready",  serverReady);  // org-server notifica que está listo (cloud-init completo)

// ── Defaults tarball (para cloud-init de org-servers) ─────────────────────────
router.get("/defaults.tar.gz", serveDefaultsTarball);

// ── MCP server JS (descargado en wake/cloud-init para instalar el cliente MCP)
router.get("/mcp-server.js", serveMcpServer);

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

export default router;
