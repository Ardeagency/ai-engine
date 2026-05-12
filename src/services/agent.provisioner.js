/**
 * Agent Provisioner — puente entre agent.manager.js y openclaw.provisioner.js.
 *
 * agent.manager.js espera que provisionAgent() retorne un objeto con:
 *   { id, workspace_path, tool_phase }
 * donde id es el UUID del agente en la tabla ai_agents (si existe).
 *
 * En la arquitectura v3 usamos openclaw_instances en lugar de ai_agents.
 * Retornamos un objeto compatible que agent.manager puede usar sin fallar.
 */
import { supabase } from "../lib/supabase.js";
import { provisionOpenClawForOrg } from "./openclaw.provisioner.js";

export async function provisionAgent(organizationId) {
  // Obtener nombre de la organización
  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();

  const orgName = org?.name || organizationId;

  // Verificar si ya hay una instancia sana en openclaw_instances
  const { data: existing } = await supabase
    .from("openclaw_instances")
    .select("agent_id, workspace_path, status")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing?.status === "healthy" && existing.agent_id) {
    // Ya existe y está sana → retornar datos compatibles con agent.manager
    return {
      id: organizationId,          // agent.manager usa esto como agentId
      workspace_path: existing.workspace_path,
      tool_phase: "A",
      status: existing.status,
    };
  }

  // Lanzar provisioning en background (no bloquea el chat)
  setImmediate(async () => {
    try {
      await provisionOpenClawForOrg(organizationId, orgName);
  } catch (e) {
      console.error(`agent.provisioner: background provision failed for "${organizationId}":`, e.message);
    }
  });

  // Retornar datos parciales — agent.manager continuará con los valores disponibles
  return {
    id: organizationId,
    workspace_path: existing?.workspace_path || null,
    tool_phase: "A",
    status: "provisioning",
  };
}
