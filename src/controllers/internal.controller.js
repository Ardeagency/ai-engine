/**
 * Internal Controller — endpoints para webhooks internos y administración.
 *
 * Autenticado con x-webhook-secret (webhooks de Supabase y org-servers)
 * o X-Internal-Key (llamadas admin internas).
 */
import { supabase } from "../lib/supabase.js";
import {
  getAllOrgs,
  getRegistrySize,
  getOrgEntry,
  registerRemoteOrg,
  updateRemoteOrgEndpoint,
  markOrgSleeping,
  unregisterOrg,
} from "../services/openclaw.registry.js";
import { provisionOpenClawForOrg } from "../services/openclaw.provisioner.js";
import { logProvisioningEvent } from "../lib/provisioning-events.js";
import { runOrgSync } from "../services/org-sync.service.js";
import { invalidateAutonomyCache, recordAutonomyChange } from "../lib/autonomy.js";
import { invalidateOrgJwt } from "../lib/org-jwt.js";
import { clearOrgSessions } from "../lib/session.manager.js";
import { checkRemoteOrgsNow } from "../services/server.health.service.js";
import {
  deleteOrgServer,
  sleepOrgServer,
  wakeOrgServer,
  listOrgServers,
  verifyHetznerConnection,
} from "../services/hetzner.provisioner.js";

// UUID genérico — acepta v1/v4/v5/etc + UUIDs demo (a1000000-…). Rechaza
// strings que no tengan formato UUID. Antes era v4 strict (`4xxx-[89ab]xxx`)
// pero rechazaba UUIDs demo legítimos como a1000000-0000-0000-0000-000000000001.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertWebhookSecret(req, res) {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: "INTERNAL_WEBHOOK_SECRET no configurado en el servidor" });
    return false;
  }
  const incoming = req.headers["x-webhook-secret"];
  if (incoming !== secret) {
    res.status(401).json({ error: "Webhook secret inválido" });
    return false;
  }
  return true;
}

function assertInternalKey(req, res) {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    res.status(500).json({ error: "INTERNAL_API_KEY no configurado en el servidor" });
    return false;
  }
  if (req.headers["x-internal-key"] !== key) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// Versión middleware de assertInternalKey — MISMA lógica, para gatear rutas
// declaradas inline en internal.routes.js (que no pasan por un controlador con
// su propio assert). Evita que un handler nuevo se registre sin auth por olvido.
export function requireInternalKey(req, res, next) {
  if (assertInternalKey(req, res)) next();
}

function assertValidUuid(value, res, fieldName = "id") {
  if (!value || !UUID_REGEX.test(value)) {
    res.status(400).json({ error: `${fieldName} debe ser un UUID v4 válido` });
    return false;
  }
  return true;
}

// ── POST /internal/org-created ────────────────────────────────────────────────
// Webhook de Supabase cuando se crea una organización.
// Trigger: migrate_v9_org_provision_trigger.sql

export const orgCreated = async (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const record         = req.body?.record || req.body;
  const organizationId = record?.id;
  const orgName        = record?.name;

  if (!assertValidUuid(organizationId, res, "organization_id")) return;

  console.log(`internal: org-created webhook → id="${organizationId}" name="${orgName}"`);

  // Responder rápido a Supabase (no bloquear el webhook)
  res.json({ received: true, organizationId });

  // Provisionar en background
  // KILL-SWITCH temporal: DISABLE_ORG_AUTO_PROVISION=true en .env desactiva
  // el provisioning automatico. Re-habilitar quitando el env y reiniciando.
  if (process.env.DISABLE_ORG_AUTO_PROVISION === "true") {
    console.log(`internal: org \"${organizationId}\" auto-provision DISABLED (env flag)`);
    return;
  }
  setImmediate(async () => {
    try {
      await provisionOpenClawForOrg(organizationId, orgName);
      console.log(`internal: provisioning iniciado para org "${organizationId}"`);
    } catch (e) {
      console.error(`internal: provisioning falló para org "${organizationId}":`, e.message);
    }
  });
};

// ── POST /internal/server-ready ───────────────────────────────────────────────
// Llamado por el org-server al terminar cloud-init.
// Body: { org_id, server_ip, server_port, org_token, agent_id }
// Header: x-webhook-secret

export const serverReady = async (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const { org_id, server_ip, server_port, org_token, agent_id } = req.body || {};

  if (!assertValidUuid(org_id, res, "org_id")) return;

  if (!server_ip || typeof server_ip !== "string") {
    return res.status(400).json({ error: "server_ip es requerido y debe ser un string" });
  }
  if (!org_token || typeof org_token !== "string") {
    return res.status(400).json({ error: "org_token es requerido" });
  }

  const port    = Number(server_port) || 3001;
  const agentId = agent_id || `org_${org_id.replace(/-/g, "").slice(0, 24)}`;

  console.log(`internal: server-ready → org="${org_id}" ip="${server_ip}:${port}" agent="${agentId}"`);

  // Verificar si ya existía una entrada en DB para obtener el hetzner_server_id
  const { data: existing } = await supabase
    .from("openclaw_instances")
    .select("hetzner_server_id, status")
    .eq("organization_id", org_id)
    .maybeSingle();

  // FIX 2026-07-01: registrar las skills realmente instaladas + phase='complete'.
  // El cloud-init copia TODAS las skills de defaults/skills (cp -r skills/*), pero
  // antes serverReady no tocaba skills_installed ni provisioning_phase → la columna
  // quedaba stale/vacía tras (re)provisión (parecía que faltaba cmo-strategizing).
  let skillsInstalled = [];
  try {
    skillsInstalled = readdirSync(path.join(DEFAULTS_DIR, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    console.warn(`internal: server-ready no pudo listar skills de defaults: ${e.message}`);
  }

  // Actualizar DB: IP, puerto, token, status → healthy
  const { error: updateError } = await supabase
    .from("openclaw_instances")
    .update({
      status:          "healthy",
      server_type:     "hetzner",
      server_ip,
      server_port:     port,
      org_token,
      agent_id:        agentId,
      internal_url:    `http://${server_ip}:${port}`,
      sleeping:        false,
      ...(skillsInstalled.length
        ? { skills_installed: skillsInstalled, provisioning_phase: "complete" }
        : {}),
      last_activity_at: new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    })
    .eq("organization_id", org_id);

  if (updateError) {
    console.error(`internal: server-ready DB update falló para org "${org_id}":`, updateError.message);
    await logProvisioningEvent({
      organizationId: org_id,
      eventType:      "provisioning_failed",
      phase:          "server_ready",
      message:        `DB update falló: ${updateError.message}`,
      metadata:       { stage: "serverReady" },
    });
    return res.status(500).json({ error: "Error actualizando la instancia en la base de datos" });
  }

  // Log: cloud-init completo y server respondió ready
  await logProvisioningEvent({
    organizationId: org_id,
    eventType:      "cloud_init_completed",
    phase:          "agent_starting",
    message:        `Cloud-init completo, server-ready recibido (${server_ip}:${port})`,
    metadata:       { server_ip, port, agent_id: agentId },
  });

  // Registrar (o actualizar) en el registry en memoria
  const prevEntry = getOrgEntry(org_id);

  if (prevEntry?.type === "remote") {
    // Wake: actualizar IP y token existentes
    updateRemoteOrgEndpoint(org_id, {
      ip:              server_ip,
      port,
      token:           org_token,
      hetznerServerId: existing?.hetzner_server_id,
    });
  } else {
    // Provisioning inicial: registrar como nuevo org remoto
    registerRemoteOrg(org_id, {
      ip:              server_ip,
      port,
      token:           org_token,
      hetznerServerId: existing?.hetzner_server_id,
      agentId,
    });
  }

  console.log(`internal: org "${org_id}" registrada como REMOTE → ${server_ip}:${port}`);

  // Log: agente online en el registry
  await logProvisioningEvent({
    organizationId: org_id,
    eventType:      "agent_online",
    phase:          "complete",
    message:        `Agente registrado en registry — provisioning completo`,
    metadata:       { server_ip, port, agent_id: agentId, was_wake: prevEntry?.type === "remote" },
  });

  return res.json({ ok: true, org_id, server_ip, port });
};

// ── POST /internal/org/:orgId/autonomy-changed ────────────────────────────────
// El frontend llama esto cuando el usuario cambia el nivel de autonomía.

const VALID_LEVELS = new Set(["restringido", "parcial", "total"]);

export const autonomyChanged = async (req, res) => {
  if (!assertInternalKey(req, res)) return;

  const { orgId } = req.params;
  const { from_level, to_level } = req.body;

  if (!assertValidUuid(orgId, res, "orgId")) return;

  if (from_level && !VALID_LEVELS.has(from_level)) {
    return res.status(400).json({ error: "from_level inválido. Valores: restringido, parcial, total" });
  }
  if (to_level && !VALID_LEVELS.has(to_level)) {
    return res.status(400).json({ error: "to_level inválido. Valores: restringido, parcial, total" });
  }

  invalidateAutonomyCache(orgId);
  invalidateOrgJwt(orgId);
  const sessionsCleared = clearOrgSessions(orgId);

  if (from_level && to_level) {
    recordAutonomyChange(orgId, from_level, to_level);
  }

  console.log(
    `internal: autonomy-changed org="${orgId}" ${from_level ?? "?"}→${to_level ?? "?"} | sesiones: ${sessionsCleared}`
  );

  return res.json({
    ok:               true,
    org_id:           orgId,
    sessions_cleared: sessionsCleared,
    notice_registered: Boolean(from_level && to_level),
  });
};

// ── POST /internal/sync-orgs ──────────────────────────────────────────────────
// Fuerza una sincronización inmediata de orgs sin agente.

export const syncOrgs = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  res.json({ started: true, message: "org-sync iniciado en background" });
  setImmediate(async () => {
    try {
      await runOrgSync();
      console.log("internal: sync-orgs completado");
    } catch (e) {
      console.error("internal: sync-orgs falló:", e.message);
    }
  });
};

// ── GET /internal/instances ───────────────────────────────────────────────────
// Listado de instancias activas en registry y DB.

export const listInstances = async (req, res) => {
  if (!assertInternalKey(req, res)) return;

  try {
    const { data: dbInstances } = await supabase
      .from("openclaw_instances")
      .select(
        "organization_id, agent_id, workspace_path, status, server_type, server_ip, server_port, hetzner_server_id, sleeping, last_activity_at, created_at, updated_at"
      )
      .order("created_at", { ascending: false });

    res.json({
      registry_size:  getRegistrySize(),
      openclaw_agents: getAllOrgs(),
      db_instances:   dbInstances || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── POST /internal/org/:orgId/sleep ──────────────────────────────────────────
// Pone a dormir el org-server: snapshot + destrucción del servidor.

export const sleepOrg = async (req, res) => {
  if (!assertInternalKey(req, res)) return;

  const { orgId } = req.params;
  if (!assertValidUuid(orgId, res, "orgId")) return;

  const { data: instance } = await supabase
    .from("openclaw_instances")
    .select("hetzner_server_id, server_type, status, sleeping")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!instance) return res.status(404).json({ error: "Org no encontrada en openclaw_instances" });
  if (instance.server_type !== "hetzner") return res.status(400).json({ error: "Solo org-servers Hetzner pueden entrar en sleep" });
  if (instance.sleeping) return res.status(409).json({ error: "Org ya está en sleep" });
  if (!instance.hetzner_server_id) return res.status(400).json({ error: "hetzner_server_id no disponible" });

  res.json({ started: true, org_id: orgId, message: "Sleep iniciado en background" });

  setImmediate(async () => {
    try {
      const { snapshotId } = await sleepOrgServer(instance.hetzner_server_id, orgId);

      await supabase.from("openclaw_instances").update({
        status:            "sleeping",
        sleeping:          true,
        hetzner_server_id: null,
        server_ip:         null,
        snapshot_id:       String(snapshotId),
        updated_at:        new Date().toISOString(),
      }).eq("organization_id", orgId);

      markOrgSleeping(orgId);

      console.log(`internal: org "${orgId}" en sleep — snapshot #${snapshotId}`);
    } catch (e) {
      console.error(`internal: sleep org "${orgId}" falló:`, e.message);
    }
  });
};

// ── POST /internal/org/:orgId/wake ────────────────────────────────────────────
// Despierta un org-server desde su snapshot.

export const wakeOrg = async (req, res) => {
  if (!assertInternalKey(req, res)) return;

  const { orgId } = req.params;
  if (!assertValidUuid(orgId, res, "orgId")) return;

  const { data: instance } = await supabase
    .from("openclaw_instances")
    .select("snapshot_id, sleeping, server_type")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!instance) return res.status(404).json({ error: "Org no encontrada" });
  if (!instance.sleeping) return res.status(409).json({ error: "Org no está en sleep" });
  if (!instance.snapshot_id) return res.status(400).json({ error: "No hay snapshot disponible para esta org" });

  // Leer plan de la org para seleccionar el tipo de servidor
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("name, plan")
    .eq("id", orgId)
    .maybeSingle();

  res.json({ started: true, org_id: orgId, message: "Wake iniciado — disponible en ~90s" });

  setImmediate(async () => {
    try {
      const { hetznerServerId, orgToken } = await wakeOrgServer(
        { id: orgId, name: orgRow?.name, plan: orgRow?.plan || "starter" },
        Number(instance.snapshot_id)
      );

      await supabase.from("openclaw_instances").update({
        status:            "starting",
        sleeping:          false,
        hetzner_server_id: hetznerServerId,
        org_token:         orgToken,
        updated_at:        new Date().toISOString(),
      }).eq("organization_id", orgId);

      console.log(`internal: org "${orgId}" despertando — servidor #${hetznerServerId}`);
    } catch (e) {
      console.error(`internal: wake org "${orgId}" falló:`, e.message);
    }
  });
};

// ── DELETE /internal/org/:orgId/server ────────────────────────────────────────
// Destruye el servidor Hetzner de una org (sin snapshot — datos se pierden).

export const deleteOrgHetznerServer = async (req, res) => {
  if (!assertInternalKey(req, res)) return;

  const { orgId } = req.params;
  if (!assertValidUuid(orgId, res, "orgId")) return;

  const { data: instance } = await supabase
    .from("openclaw_instances")
    .select("hetzner_server_id, server_type")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!instance?.hetzner_server_id) {
    return res.status(404).json({ error: "No hay servidor Hetzner activo para esta org" });
  }

  try {
    await deleteOrgServer(instance.hetzner_server_id);
    await supabase.from("openclaw_instances")
      .update({ status: "stopped", hetzner_server_id: null, server_ip: null, updated_at: new Date().toISOString() })
      .eq("organization_id", orgId);
    unregisterOrg(orgId);
    res.json({ ok: true, org_id: orgId, deleted_server_id: instance.hetzner_server_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── GET /internal/hetzner/servers ────────────────────────────────────────────
// Lista todos los org-servers activos en Hetzner.

export const listHetznerServers = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  try {
    const servers = await listOrgServers();
    res.json({ count: servers.length, servers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── GET /internal/hetzner/status ─────────────────────────────────────────────
// Verifica la conexión con la API de Hetzner.

export const hetznerStatus = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  const result = await verifyHetznerConnection();
  res.status(result.ok ? 200 : 503).json(result);
};

// ── POST /internal/health/remote ─────────────────────────────────────────────
// Fuerza un health check inmediato de todos los org-servers remotos.

export const forceRemoteHealthCheck = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  try {
    const results = await checkRemoteOrgsNow();
    res.json({ checked: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── GET /internal/defaults.tar.gz ─────────────────────────────────────────────
// Sirve un tarball con todos los defaults (prompts, skills, memory-banks)
// para que los org-servers lo descarguen durante cloud-init.
// Autenticado con x-webhook-secret.

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname_ctrl = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.resolve(__dirname_ctrl, "../../defaults");

export const serveDefaultsTarball = (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  try {
    // Generar tarball on-the-fly desde defaults/
    // Incluye: *.md (prompts), skills/, memory-banks/
    const tarball = execSync(
      `tar -czf - -C "${DEFAULTS_DIR}" .`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 }
    );

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", "attachment; filename=defaults.tar.gz");
    res.send(tarball);
  } catch (e) {
    console.error("internal: error generando defaults tarball:", e.message);
    res.status(500).json({ error: "Error generando tarball de defaults" });
  }
};

// ── GET /internal/mcp-server.js ───────────────────────────────────────────────
// Sirve el código del MCP server para que los org-servers lo instalen en
// cloud-init y/o en cada wake. Autenticado con x-webhook-secret.
import { readFileSync, readdirSync } from "fs";
const MCP_SERVER_PATH = path.resolve(__dirname_ctrl, "../mcp/ai-engine-tools.js");

export const serveMcpServer = (req, res) => {
  if (!assertWebhookSecret(req, res)) return;
  try {
    const content = readFileSync(MCP_SERVER_PATH, "utf8");
    res.setHeader("Content-Type", "application/javascript");
    res.send(content);
  } catch (e) {
    console.error("internal: error sirviendo mcp-server.js:", e.message);
    res.status(500).json({ error: "Error sirviendo MCP server" });
  }
};

// ── GET /internal/anthropic-proxy.js ──────────────────────────────────────────
// Sirve el código del anthropic-proxy. Reemplaza el b64 inline en cloud-init
// para mantener user_data < 32 KB (límite duro de Hetzner Cloud).
const ANTHROPIC_PROXY_PATH = path.resolve(__dirname_ctrl, "../../anthropic-proxy/server.js");

export const serveAnthropicProxy = (req, res) => {
  if (!assertWebhookSecret(req, res)) return;
  try {
    const content = readFileSync(ANTHROPIC_PROXY_PATH, "utf8");
    res.setHeader("Content-Type", "application/javascript");
    res.send(content);
  } catch (e) {
    console.error("internal: error sirviendo anthropic-proxy.js:", e.message);
    res.status(500).json({ error: "Error sirviendo anthropic-proxy" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// VERA Pending Actions — endpoints user-facing (Fase IV)
// Auth: req.user inyectado por userAuthMiddleware
// ═══════════════════════════════════════════════════════════════════════════
import { assertOrgMember } from "../lib/chat-security.js";

export const approveVeraAction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "action id requerido" });

    // Pre-check: cargar action para asegurar membresía
    const { data: action } = await supabase
      .from("vera_pending_actions")
      .select("organization_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!action) return res.status(404).json({ error: "action not found" });

    await assertOrgMember(action.organization_id, req.user.id);

    if (action.status !== "pending") {
      return res.status(409).json({ error: `action no esta en pending (status=${action.status})` });
    }

    // 1. RPC fn_vpa_approve (transición pending → approved)
    const { error: rpcErr } = await supabase.rpc("fn_vpa_approve", {
      p_action_id: id,
      p_approver:  req.user.id,
    });
    if (rpcErr) return res.status(400).json({ error: rpcErr.message });

    // 2. Ejecutar (dynamic import para no romper boot si executor falla)
    const { executeAction } = await import("../services/action-executor.service.js");
    try {
      const result = await executeAction(id, req.user.id);
      return res.json({ ok: true, action: result });
    } catch (execErr) {
      // executeAction ya marcó status=failed y notificó; devolvemos 500 al cliente
      return res.status(500).json({ ok: false, error: execErr.message });
    }
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message || "error" });
  }
};

export const rejectVeraAction = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!id) return res.status(400).json({ error: "action id requerido" });

    const { data: action } = await supabase
      .from("vera_pending_actions")
      .select("organization_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!action) return res.status(404).json({ error: "action not found" });

    await assertOrgMember(action.organization_id, req.user.id);

    if (action.status !== "pending") {
      return res.status(409).json({ error: `action no esta en pending (status=${action.status})` });
    }

    const { data, error: rpcErr } = await supabase.rpc("fn_vpa_reject", {
      p_action_id: id,
      p_rejecter:  req.user.id,
      p_reason:    reason || null,
    });
    if (rpcErr) return res.status(400).json({ error: rpcErr.message });

    return res.json({ ok: true, action: data });
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message || "error" });
  }
};

export const listVeraActions = async (req, res) => {
  try {
    const {
      organization_id,
      status = "pending",
      brand_container_id,
      limit = 50,
    } = req.query;

    if (!organization_id) {
      return res.status(400).json({ error: "organization_id requerido" });
    }

    await assertOrgMember(organization_id, req.user.id);

    let q = supabase
      .from("vera_pending_actions")
      .select("*")
      .eq("organization_id", organization_id)
      .order("created_at", { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 50, 200));

    if (status && status !== "all") q = q.eq("status", status);
    if (brand_container_id) q = q.eq("brand_container_id", brand_container_id);

    const { data, error } = await q;
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ actions: data, count: data.length });
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message || "error" });
  }
};

// ── POST /internal/crawl-site ────────────────────────────────────────────────
// BFS recursivo de descubrimiento de rutas. Devuelve pages[] + stats.
// Body: { url, max_pages?, max_depth?, max_concurrent?, delay_ms?, timeout_ms?, include_html? }
// Header: x-webhook-secret
export const crawlSiteHandler = async (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const {
    url,
    max_pages = 200,
    max_depth = 5,
    max_concurrent = 5,
    delay_ms = 200,
    timeout_ms = 15000,
    include_html = false,
  } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url (string) requerido" });
  }

  try {
    const { crawlSite } = await import("../services/site-crawler.service.js");
    const startedAt = new Date().toISOString();
    const result = await crawlSite({
      seedUrl: url,
      maxPages: Math.min(Math.max(parseInt(max_pages, 10) || 200, 1), 1000),
      maxDepth: Math.min(Math.max(parseInt(max_depth, 10) || 5, 1), 10),
      maxConcurrent: Math.min(Math.max(parseInt(max_concurrent, 10) || 5, 1), 20),
      delayMs: Math.max(parseInt(delay_ms, 10) || 0, 0),
      timeoutMs: Math.min(Math.max(parseInt(timeout_ms, 10) || 15000, 1000), 60000),
      includeHtml: !!include_html,
      onProgress: (p) => {
        if (p.phase === "batch_end") {
          console.log(`crawl: depth=${p.depth} pages=${p.pages} queue=${p.queue} new=${p.newRoutesInBatch}`);
        }
      },
    });

    return res.json({
      started_at: startedAt,
      seed: result.seed,
      terminated: result.terminated,
      stats: result.stats,
      pages: result.pages.map((p) => ({
        url: p.url,
        status: p.status,
        content_length: p.content_length,
        depth: p.depth,
        ...(include_html ? { html: p.html } : {}),
      })),
      errors: result.errors,
    });
  } catch (e) {
    console.error("crawl-site error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};

// ── POST /internal/brand-scrape/start ────────────────────────────────────────
// Crea un brand_scrape_job y arranca el pipeline en background.
// Body: { url, organization_id?, max_pages?, max_depth? }
// Header: x-webhook-secret
// Response inmediata: { job_id }
export const brandScrapeStart = async (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const { url, organization_id = null, max_pages, max_depth, created_by = null } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url (string) requerido" });
  }

  try {
    const { createJob, runPipeline } = await import("../services/brand-scrape-orchestrator.service.js");
    const { jobId } = await createJob({ seedUrl: url, organizationId: organization_id, createdBy: created_by });

    // Disparar pipeline en background, sin esperar
    setImmediate(() => {
      runPipeline(jobId, {
        maxPages: Math.min(Math.max(parseInt(max_pages, 10) || 80, 1), 200),
        maxDepth: Math.min(Math.max(parseInt(max_depth, 10) || 4, 1), 8),
      }).catch((err) => console.error(`runPipeline jobId=${jobId} fatal:`, err));
    });

    return res.json({ job_id: jobId, status: "queued" });
  } catch (e) {
    console.error("brand-scrape-start error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};

// ── GET /internal/brand-scrape/status/:jobId ─────────────────────────────────
// Polling endpoint para el frontend.
// Header: x-webhook-secret
export const brandScrapeStatus = async (req, res) => {
  if (!assertWebhookSecret(req, res)) return;

  const { jobId } = req.params;
  if (!jobId) return res.status(400).json({ error: "jobId requerido" });

  try {
    const { getStatus } = await import("../services/brand-scrape-orchestrator.service.js");
    const job = await getStatus(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    return res.json({
      job_id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      brand_payload: job.brand_payload,
      error: job.error,
      cost_usd: job.cost_usd,
      tokens_in: job.tokens_in,
      tokens_out: job.tokens_out,
      started_at: job.started_at,
      finished_at: job.finished_at,
    });
  } catch (e) {
    console.error("brand-scrape-status error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
