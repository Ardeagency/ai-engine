/**
 * Mission Generator Service — convierte vera_pending_actions aprobadas en
 * body_missions ejecutables.
 *
 * Flujo:
 *   1. Lee vera_pending_actions con status='approved'
 *   2. Filtra las que ya tienen body_mission asociada (via metadata)
 *   3. Crea body_missions con mission_type=`execute_${action_type}` y action_payload
 *      con todo el contexto (target_id, proposed_payload, vera_reasoning)
 *   4. Marca pending_action como status='executing' para evitar duplicados
 *
 * Sin LLM. Pura traducción de pending_action → body_mission. El job_worker
 * se encarga después de ejecutar la mission contra el sistema correspondiente.
 *
 * Se ejecuta como sensor brand-wide con cadencia configurable (default 5 min).
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

export async function generateMissionsForBrand(brandContainerId, organizationId) {
  if (!brandContainerId || !organizationId) {
    return { generated: 0, skipped: 0, error: "missing ids" };
  }

  // 1) pending_actions aprobadas para esta brand
  const { data: approved, error: readErr } = await supabase
    .from("vera_pending_actions")
    .select("id, organization_id, brand_container_id, action_type, target_table, target_id, proposed_payload, vera_reasoning, source_signal_id, priority")
    .eq("brand_container_id", brandContainerId)
    .eq("organization_id",    organizationId)
    .eq("status",             "approved")
    .order("priority", { ascending: false })
    .limit(20);

  if (readErr) {
    console.warn(`[mission-generator] read pending_actions falló: ${readErr.message}`);
    return { generated: 0, skipped: 0, error: readErr.message };
  }
  if (!approved?.length) return { generated: 0, skipped: 0 };

  let generated = 0, skipped = 0;
  for (const action of approved) {
    // 2) ¿Ya existe body_mission para esta action?
    const { data: existing } = await supabase
      .from("body_missions")
      .select("id")
      .eq("organization_id", action.organization_id)
      .contains("action_payload", { vera_pending_action_id: action.id })
      .maybeSingle();

    if (existing?.id) {
      skipped++;
      continue;
    }

    // 3) Crear body_mission
    const missionType = `execute_${action.action_type}`;
    const { data: mission, error: insErr } = await supabase
      .from("body_missions")
      .insert({
        organization_id:    action.organization_id,
        brand_container_id: action.brand_container_id,
        trigger_signal_id:  action.source_signal_id || null,
        mission_type:       missionType,
        status:             "pending",
        action_payload: {
          vera_pending_action_id: action.id,
          action_type:            action.action_type,
          target_table:           action.target_table,
          target_id:              action.target_id,
          proposed_payload:       action.proposed_payload || {},
          vera_reasoning:         action.vera_reasoning || null,
          priority:               action.priority,
          generated_at:           new Date().toISOString(),
        },
        result_reference: {},
      })
      .select("id")
      .maybeSingle();

    if (insErr) {
      console.warn(`[mission-generator] insert body_mission para action ${action.id} falló: ${insErr.message}`);
      continue;
    }

    // 4) Marcar pending_action como executing (link bidireccional)
    await supabase
      .from("vera_pending_actions")
      .update({
        status:           "executing",
        executing_at:     new Date().toISOString(),
        execution_result: { body_mission_id: mission?.id || null },
        updated_at:       new Date().toISOString(),
      })
      .eq("id", action.id);

    generated++;
  }

  return { generated, skipped };
}
