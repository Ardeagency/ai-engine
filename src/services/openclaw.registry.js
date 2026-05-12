/**
 * OpenClaw Registry — mapa en memoria de agentes activos por organización.
 *
 * Soporta dos tipos de entrada:
 *
 *   type: 'local'
 *     → Agente OpenClaw CLI corriendo en el mismo servidor que AI Engine.
 *     → Estructura: { type, agentId, workspaceDir, mcpServerName, status, registeredAt }
 *
 *   type: 'remote'
 *     → Org-server dedicado en Hetzner con openclaw-bridge HTTP en puerto 3001.
 *     → Estructura: { type, agentId, ip, port, token, hetznerServerId, status, registeredAt }
 *
 * El registry NO persiste. Al reiniciar, initRegistry() lo reconstruye desde
 * openclaw_instances en Supabase.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { supabase } from "../lib/supabase.js";

const execFileAsync = promisify(execFile);

// Clave: organizationId → entry (local | remote)
const _registry = new Map();

// ── Lectura ───────────────────────────────────────────────────────────────────

export function getRegistrySize() {
  return _registry.size;
}

export function getAllOrgs() {
  return Array.from(_registry.entries()).map(([orgId, entry]) => ({
    organizationId: orgId,
    ...entry,
  }));
}

/**
 * Retorna la entrada completa de la org (local o remote), o null si no está registrada.
 */
export function getOrgEntry(organizationId) {
  return _registry.get(organizationId) ?? null;
}

export function getOrgAgentId(organizationId) {
  return _registry.get(organizationId)?.agentId ?? null;
}

/**
 * Retorna la URL base del org-server remoto (http://ip:port).
 * Retorna null si la org no está en el registry o es de tipo local.
 */
export function getOrgServerUrl(organizationId) {
  const entry = _registry.get(organizationId);
  if (!entry || entry.type !== "remote") return null;
  return `http://${entry.ip}:${entry.port}`;
}

/**
 * Retorna true si la org tiene un agente disponible (local o remoto) y está healthy.
 */
export function isOrgAvailable(organizationId) {
  const entry = _registry.get(organizationId);
  if (!entry) return false;
  return entry.status === "healthy";
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Registra una org con agente local (modelo anterior).
 * Llamado por openclaw.provisioner.js al finalizar el provisioning local.
 */
export function registerOrg(organizationId, { agentId, workspaceDir, mcpServerName = null }) {
  _registry.set(organizationId, {
    type:          "local",
    agentId,
    workspaceDir,
    mcpServerName,
    status:        "healthy",
    registeredAt:  new Date().toISOString(),
  });
}

/**
 * Registra una org con org-server remoto en Hetzner (modelo nuevo).
 * Llamado por internal.controller.js cuando recibe POST /internal/server-ready.
 */
export function registerRemoteOrg(organizationId, { ip, port, token, hetznerServerId, agentId }) {
  _registry.set(organizationId, {
    type:            "remote",
    agentId:         agentId || `org_${organizationId.replace(/-/g, "").slice(0, 24)}`,
    ip,
    port:            Number(port) || 3001,
    token,
    hetznerServerId: hetznerServerId ?? null,
    status:          "healthy",
    registeredAt:    new Date().toISOString(),
  });
}

/**
 * Actualiza solo el IP, puerto y token de una org remota ya registrada.
 * Usado cuando un org-server despierta (wake) con una nueva IP.
 */
export function updateRemoteOrgEndpoint(organizationId, { ip, port, token, hetznerServerId }) {
  const existing = _registry.get(organizationId);
  if (!existing || existing.type !== "remote") return;
  _registry.set(organizationId, {
    ...existing,
    ip,
    port:            Number(port) || existing.port,
    token:           token || existing.token,
    hetznerServerId: hetznerServerId ?? existing.hetznerServerId,
    status:          "healthy",
    registeredAt:    new Date().toISOString(), // resetear timestamp
  });
}

export function markOrgDegraded(organizationId) {
  const entry = _registry.get(organizationId);
  if (entry) _registry.set(organizationId, { ...entry, status: "degraded" });
}

export function markOrgHealthy(organizationId) {
  const entry = _registry.get(organizationId);
  if (entry) _registry.set(organizationId, { ...entry, status: "healthy" });
}

export function markOrgSleeping(organizationId) {
  const entry = _registry.get(organizationId);
  if (entry) _registry.set(organizationId, { ...entry, status: "sleeping" });
}

export function unregisterOrg(organizationId) {
  _registry.delete(organizationId);
}

// ── Ping local ────────────────────────────────────────────────────────────────

async function _pingLocalAgent(agentId) {
  try {
    const env = {
      ...process.env,
      OPENAI_API_KEY:         process.env.OPENAI_API_KEY,
      OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    };
    const result = await execFileAsync(
      "openclaw",
      ["agent", "--local", "--agent", agentId, "--message", "Responde solo: OK", "--json"],
      { env, timeout: 45_000 }
    );
    const combined = (result.stdout || "") + (result.stderr || "");
    return combined.includes('"payloads"');
  } catch {
    return false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Reconstruye el registry desde openclaw_instances en Supabase.
 * Se llama una vez al arrancar AI Engine.
 * Registra instancias locales (CLI) y remotas (Hetzner).
 */
export async function initRegistry() {
  const { data: instances, error } = await supabase
    .from("openclaw_instances")
    .select(
      "organization_id, agent_id, workspace_path, status, server_type, server_ip, server_port, org_token, hetzner_server_id"
    )
    .eq("status", "healthy");

  if (error) {
    console.warn("initRegistry: error leyendo openclaw_instances:", error.message);
    return;
  }

  if (!instances?.length) {
    console.log("initRegistry: no hay agentes healthy en DB");
    return;
  }

  const checks = instances.map(async (row) => {
    try {
    const {
      organization_id,
      agent_id,
      server_type,
      server_ip,
      server_port,
      org_token,
      hetzner_server_id,
    } = row;

    if (server_type === "hetzner" && server_ip) {
      registerRemoteOrg(organization_id, {
        ip:               server_ip,
        port:             server_port || 3001,
        token:            org_token,
        hetznerServerId:  hetzner_server_id,
        agentId:          agent_id,
      });
      console.log(`initRegistry: remote org "${organization_id}" → ${server_ip}:${server_port || 3001}`);
    } else {
      // Org local — registrar y verificar con ping
      if (!agent_id) return;
      const workspace = row.workspace_path || null;

      // Registrar primero — el agente puede estar disponible aunque el ping
      // falle por rate-limit de OpenAI. El health service verificará después.
      registerOrg(organization_id, { agentId: agent_id, workspaceDir: workspace });
      const alive = await _pingLocalAgent(agent_id);
      if (alive) {
        console.log(`initRegistry: local agent "${agent_id}" → healthy (ping OK)`);
      } else {
        console.warn(`initRegistry: local agent "${agent_id}" → registered (ping falló, se verificará después)`);
      }
    }
    } catch (e) {
      console.error(`initRegistry: ERROR procesando row:`, e.message);
    }
  });

  await Promise.allSettled(checks);
  console.log(`initRegistry: ${_registry.size} agentes cargados en registry`);
}
