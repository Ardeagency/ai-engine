/**
 * Provisioning Events Logger — escribe a la tabla provisioning_events.
 *
 * Captura el ciclo de vida de openclaw_instances para auditoría: creación,
 * cloud-init, server-ready, agent-online, health checks, sleeping/waking,
 * destrucción, fallos. Helper compartido por openclaw.provisioner,
 * hetzner.provisioner, internal.controller (serverReady) y server.health.service.
 *
 * NO usa LLM. Es solo un INSERT con metadata estructurada.
 */
import { supabase } from "./supabase.js";

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.instanceId]   - openclaw_instances.id (resuelve si no se pasa)
 * @param {string} params.eventType      - server_create_requested|server_created|server_ready|cloud_init_started|cloud_init_completed|agent_online|health_check_passed|health_check_failed|server_degraded|retry_triggered|server_sleeping|server_waking|server_destroyed|provisioning_failed
 * @param {string} [params.phase]        - sub-phase opcional (matches openclaw_instances.provisioning_phase)
 * @param {string} [params.message]      - descripción legible
 * @param {object} [params.metadata]     - data estructurada del evento
 * @param {number} [params.durationMs]   - duración del paso si aplica
 */
export async function logProvisioningEvent({
  organizationId,
  instanceId = null,
  eventType,
  phase = null,
  message = null,
  metadata = {},
  durationMs = null,
}) {
  if (!organizationId || !eventType) return null;

  // Resolver instanceId si no fue pasado
  let resolvedInstanceId = instanceId;
  if (!resolvedInstanceId) {
    const { data: inst } = await supabase
      .from("openclaw_instances")
      .select("id")
      .eq("organization_id", organizationId)
      .maybeSingle();
    resolvedInstanceId = inst?.id || null;
  }

  const { data, error } = await supabase
    .from("provisioning_events")
    .insert({
      organization_id: organizationId,
      instance_id:     resolvedInstanceId,
      event_type:      eventType,
      phase,
      message:         message?.slice(0, 1000) || null,
      metadata:        metadata || {},
      duration_ms:     durationMs,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn(`[provisioning-events] insert ${eventType} falló: ${error.message}`);
    return null;
  }
  return data?.id;
}
