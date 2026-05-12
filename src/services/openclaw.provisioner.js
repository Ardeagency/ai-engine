/**
 * OpenClaw Provisioner — crea y destruye agentes OpenClaw por organización.
 *
 * Modo Hetzner (único modo soportado):
 *   Flujo autónomo: crea servidor Hetzner dedicado con cloud-init.
 *   1. Chequeo idempotencia
 *   2. Insertar openclaw_instances status="provisioning", server_type="hetzner"
 *   3. hetznerProvisioner.createOrgServer() → Hetzner crea el servidor con cloud-init
 *   4. Guarda hetzner_server_id en DB
 *   5. El servidor llama a /internal/server-ready cuando está listo
 *   6. internal.controller.serverReady() actualiza DB a "healthy" y registra en registry
 *   (el provisioner retorna inmediatamente — el resto es asíncrono)
 */
import { supabase } from "../lib/supabase.js";
import { createOrgServer } from "./hetzner.provisioner.js";
import { logProvisioningEvent } from "../lib/provisioning-events.js";

export async function provisionOpenClawForOrg(organizationId, orgName) {
  const { data: existing } = await supabase
    .from("openclaw_instances")
    .select("id, status, agent_id, server_type")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing?.status && ["healthy", "provisioning", "starting"].includes(existing.status)) {
    console.log(`provisioner: org "${organizationId}" ya tiene instancia (${existing.status})`);
    return { alreadyInProgress: true, agentId: existing.agent_id };
  }

  return await _provisionHetznerServer(organizationId, orgName, existing);
}

// ── Provisioning Hetzner ───────────────────────────────────────────────────────

/**
 * Crea un servidor Hetzner dedicado para la organización.
 * Retorna inmediatamente — el provisioning real es asíncrono via cloud-init.
 * El servidor llamará a /internal/server-ready cuando esté listo.
 */
async function _provisionHetznerServer(organizationId, orgName, existing) {
  const agentId = `org_${organizationId.replace(/-/g, "").slice(0, 24)}`;

  const upsertData = {
    organization_id: organizationId,
    agent_id:        agentId,
    workspace_path:  `remote://hetzner/${agentId}`,
    status:          "provisioning",
    server_type:     "hetzner",
    container_name:  agentId,
    internal_url:    "hetzner://pending",
    updated_at:      new Date().toISOString(),
  };

  if (existing) {
    await supabase.from("openclaw_instances").update(upsertData).eq("organization_id", organizationId);
  } else {
    await supabase.from("openclaw_instances").insert(upsertData);
  }

  await logProvisioningEvent({
    organizationId,
    eventType: "server_create_requested",
    phase:     "creating_server",
    message:   `Provisioning iniciado para org ${orgName || organizationId}`,
    metadata:  { agent_id: agentId, server_type: "hetzner" },
  });

  const { data: orgRow } = await supabase
    .from("organizations")
    .select("name, plan")
    .eq("id", organizationId)
    .maybeSingle();
  const plan = orgRow?.plan || "starter";

  const startedAt = Date.now();
  try {
    const { hetznerServerId, orgToken } = await createOrgServer({
      id:   organizationId,
      name: orgName || orgRow?.name || organizationId,
      plan,
    });

    await supabase
      .from("openclaw_instances")
      .update({
        hetzner_server_id: hetznerServerId,
        org_token:         orgToken,
        updated_at:        new Date().toISOString(),
      })
      .eq("organization_id", organizationId);

    await logProvisioningEvent({
      organizationId,
      eventType:  "server_created",
      phase:      "server_ready",
      message:    `Servidor Hetzner #${hetznerServerId} creado — esperando cloud-init`,
      metadata:   { hetzner_server_id: hetznerServerId, plan },
      durationMs: Date.now() - startedAt,
    });

    console.log(`provisioner: [hetzner] org "${organizationId}" → servidor #${hetznerServerId} creado — esperando server-ready...`);
    return { agentId, hetznerServerId, pending: true };
  } catch (e) {
    const errorMsg = e.message || "Error desconocido";
    console.error(`provisioner: [hetzner] org "${organizationId}" → FAILED:`, errorMsg);
    await supabase
      .from("openclaw_instances")
      .update({ status: "failed", error_message: errorMsg.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("organization_id", organizationId);

    await logProvisioningEvent({
      organizationId,
      eventType:  "provisioning_failed",
      phase:      "failed",
      message:    errorMsg,
      metadata:   { stage: "createOrgServer" },
      durationMs: Date.now() - startedAt,
    });
    throw e;
  }
}

// ── Deprovision ───────────────────────────────────────────────────────────────

export async function deprovisionOpenClawForOrg(organizationId) {
  // Log antes del delete para que el FK no se rompa (instance_id puede ser null en eventos)
  await logProvisioningEvent({
    organizationId,
    eventType: "server_destroyed",
    phase:     "complete",
    message:   "Instancia eliminada de openclaw_instances",
  });
  await supabase.from("openclaw_instances").delete().eq("organization_id", organizationId);
  console.log(`provisioner: org "${organizationId}" eliminada de openclaw_instances`);
}
