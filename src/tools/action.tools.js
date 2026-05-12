/**
 * Herramientas de ESCRITURA (acciones).
 * El gate de consentimiento se aplica en tool.dispatcher.js, no aquí.
 * createFlowSchedule siempre crea en estado "draft" por seguridad.
 */
import { supabase } from "../lib/supabase.js";

async function verifyBrandContainerAndGetBrandId(brandContainerId, organizationId) {
  const { data: bc } = await supabase
    .from("brand_containers")
    .select("id")
    .eq("id", brandContainerId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!bc) {
    throw Object.assign(
      new Error("brand_container no encontrado para esta organización"),
      { statusCode: 404 }
    );
  }

  const { data: brand } = await supabase
    .from("brands")
    .select("id")
    .eq("project_id", brandContainerId)
    .maybeSingle();

  if (!brand) {
    throw Object.assign(
      new Error("brand no encontrado para este brand_container"),
      { statusCode: 404 }
    );
  }

  return brand.id;
}

/**
 * Marcar un flow como favorito. No requiere consentimiento humano (es preferencia del usuario).
 */
export async function likeFlow(flowId, userId) {
  const { error } = await supabase
    .from("user_flow_favorites")
    .upsert(
      {
        user_id: userId,
        flow_id: flowId,
        is_favorite: true,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "user_id,flow_id" }
    );

  if (error) throw error;
  return { ok: true, action: "liked", flow_id: flowId };
}

/**
 * Programar un flow en schedule.
 * Siempre inicia en estado "draft" — el usuario debe activarlo manualmente.
 * REQUIERE consentimiento: APPROVE_ACTION:SCHEDULE_FLOW
 */
export async function createFlowSchedule(params, brandContainerId, organizationId, userId) {
  const brandId = await verifyBrandContainerAndGetBrandId(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("flow_schedules")
    .insert({
      user_id: userId,
      flow_id: params.flow_id,
      brand_id: brandId,
      cron_expression: params.cron_expression,
      job_name: params.job_name || `vera_schedule_${Date.now()}`,
      production_count: params.production_count || 1,
      aspect_ratio: params.aspect_ratio || "1:1",
      production_specifications: params.production_specifications || null,
      status: "draft", // SEGURIDAD: siempre draft, el humano activa
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Disparar ejecución de un flow.
 * REQUIERE consentimiento: APPROVE_ACTION:TRIGGER_FLOW_RUN
 */
export async function triggerFlowRun(params, brandContainerId, organizationId, userId) {
  const brandId = await verifyBrandContainerAndGetBrandId(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("flow_runs")
    .insert({
      flow_id: params.flow_id,
      brand_id: brandId,
      user_id: userId,
      status: "queued",
      entity_id: params.entity_id || null,
      audience_id: params.audience_id || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
