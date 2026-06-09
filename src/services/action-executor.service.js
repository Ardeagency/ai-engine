/**
 * Action Executor Service — ejecuta vera_pending_actions aprobadas.
 *
 * Flujo:
 *   1. SELECT action; valida status === 'approved' o opts.autoApproved
 *   2. UPDATE → executing + executing_at (lock optimista)
 *   3. switch(action_type) → handler específico
 *   4. UPDATE → executed + execution_result OK
 *      o    → failed + error_message si throw
 *   5. notifyUser (success o error)
 *
 * Fase IV — solo update_audience, create_audience, update_brand_container están
 * implementadas. El resto throws "not implemented" para forzar diseño explícito.
 */
import { supabase } from "../lib/supabase.js";
import { notifyUser } from "./notification.service.js";

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * @param {string} actionId
 * @param {string} executedByUserId
 * @param {object} [opts]
 * @param {boolean} [opts.autoApproved] — bypass status check (autonomy total)
 */
export async function executeAction(actionId, executedByUserId, opts = {}) {
  // 1. Cargar acción
  const { data: action, error: loadErr } = await supabase
    .from("vera_pending_actions")
    .select("*")
    .eq("id", actionId)
    .maybeSingle();

  if (loadErr) throw new Error(`Failed to load action ${actionId}: ${loadErr.message}`);
  if (!action) throw new Error(`Action ${actionId} not found`);

  // 2. Validar status
  if (!opts.autoApproved && action.status !== "approved") {
    throw new Error(
      `Action ${actionId} status="${action.status}" — must be 'approved' to execute`
    );
  }

  // 3. Lock → executing
  const { data: locked, error: lockErr } = await supabase
    .from("vera_pending_actions")
    .update({
      status:       "executing",
      executing_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .in("status", ["approved", "pending"])  // pending si autoApproved
    .select()
    .maybeSingle();

  if (lockErr || !locked) {
    throw new Error(
      `Failed to acquire executing lock on ${actionId}: ${lockErr?.message || "race condition"}`
    );
  }

  // 4. Dispatch + capture result/error
  let executionResult = null;
  let errorMessage    = null;

  try {
    executionResult = await _dispatchByActionType(locked);
  } catch (e) {
    errorMessage = e?.message?.slice(0, 1000) || "unknown error";
    console.error(`[action-executor] action ${actionId} (${locked.action_type}) failed:`, errorMessage);
  }

  // 5. Persistir resultado final
  const finalStatus = errorMessage ? "failed" : "executed";
  const finalUpdate = errorMessage
    ? { status: "failed",   error_message: errorMessage }
    : { status: "executed", executed_at: new Date().toISOString(), execution_result: executionResult };

  const { data: finalAction } = await supabase
    .from("vera_pending_actions")
    .update(finalUpdate)
    .eq("id", actionId)
    .select()
    .maybeSingle();

  // 6. Notificar resultado (best-effort)
  await _notifyExecutionResult(finalAction || locked, finalStatus, errorMessage);

  if (errorMessage) throw new Error(errorMessage);
  return finalAction || locked;
}

// ── Dispatcher por action_type ──────────────────────────────────────────────
async function _dispatchByActionType(action) {
  const { action_type: type } = action;

  switch (type) {
    // ── implementadas en Fase IV inicial ─────────────────────────────────
    case "create_audience":
      return await _executeCreateAudience(action);
    case "update_audience":
      return await _executeUpdateAudience(action);
    case "update_brand_container":
      return await _executeUpdateBrandContainer(action);
    case "link_campaign_to_persona":
      return await _executeLinkCampaignToPersona(action);
    case "link_segment_to_persona":
      return await _executeLinkSegmentToPersona(action);
    case "unlink_campaign_persona":
      return await _executeUnlinkCampaignPersona(action);
    case "unlink_segment_persona":
      return await _executeUnlinkSegmentPersona(action);

    case "update_monitoring_trigger":
      return await _executeUpdateMonitoringTrigger(action);

    // ── pending — Fase III/IV completas ──────────────────────────────────
    case "publish_instagram_post":
    case "publish_facebook_post":
    case "schedule_instagram_post":
    case "schedule_facebook_post":
    case "delete_audience":
    case "merge_audiences":
    case "archive_audience":
    case "create_brand_color":
    case "update_brand_color":
    case "delete_brand_color":
    case "create_brand_font":
    case "update_brand_font":
    case "delete_brand_font":
    case "create_brand_rule":
    case "update_brand_rule":
    case "delete_brand_rule":
    case "create_product":
    case "update_product":
    case "delete_product":
    case "create_service":
    case "update_service":
    case "delete_service":
    case "create_campaign":
    case "update_campaign":
    case "archive_campaign":
    case "launch_campaign":
    case "create_schedule":
    case "update_schedule":
    case "pause_schedule":
    case "activate_schedule":
    case "add_intelligence_entity":
    case "remove_intelligence_entity":
    case "add_url_watcher":
    case "remove_url_watcher":
    case "add_brand_integration":
    case "remove_brand_integration":
      throw new Error(`executor not implemented for ${type}`);

    default:
      throw new Error(`unknown action_type: ${type}`);
  }
}

// ── Handlers implementados ──────────────────────────────────────────────────

// Limpia las claves de metadata (_risk_level, _auto_eligible, etc.) del payload.
function _cleanPayload(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

// BAJO — ajusta un sensor de monitoreo existente (pausa/reactiva/cadencia).
async function _executeUpdateMonitoringTrigger(action) {
  if (!action.target_id) throw new Error("update_monitoring_trigger requiere target_id");
  const patch = _cleanPayload(action.proposed_payload);
  if (Object.keys(patch).length === 0) throw new Error("update_monitoring_trigger: payload vacio");
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("monitoring_triggers")
    .update(patch)
    .eq("id", action.target_id)
    .select("id")
    .single();
  if (error) throw new Error(`monitoring_triggers update: ${error.message}`);
  return { table: "monitoring_triggers", row_id: data.id, operation: "update" };
}

async function _executeCreateAudience(action) {
  if (!action.brand_container_id) {
    throw new Error("create_audience requiere brand_container_id");
  }
  const payload = {
    ...action.proposed_payload,
    brand_container_id: action.brand_container_id,
  };
  const { data, error } = await supabase
    .from("audiences")
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`audiences insert: ${error.message}`);
  return { table: "audiences", row_id: data.id, operation: "insert" };
}

async function _executeUpdateAudience(action) {
  if (!action.target_id) throw new Error("update_audience requiere target_id");
  const payload = { ...action.proposed_payload, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from("audiences")
    .update(payload)
    .eq("id", action.target_id)
    .select()
    .single();
  if (error) throw new Error(`audiences update: ${error.message}`);
  return { table: "audiences", row_id: data.id, operation: "update" };
}

async function _executeUpdateBrandContainer(action) {
  if (!action.target_id) throw new Error("update_brand_container requiere target_id");
  const payload = { ...action.proposed_payload, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from("brand_containers")
    .update(payload)
    .eq("id", action.target_id)
    .select()
    .single();
  if (error) throw new Error(`brand_containers update: ${error.message}`);
  return { table: "brand_containers", row_id: data.id, operation: "update" };
}


async function _executeLinkCampaignToPersona(action) {
  const campaignId = action.target_id || action.proposed_payload?.campaign_id;
  const personaId  = action.proposed_payload?.persona_id;
  if (!campaignId) throw new Error("link_campaign_to_persona requiere target_id (campaign_id)");
  if (!personaId)  throw new Error("link_campaign_to_persona requiere proposed_payload.persona_id");

  // Validar que la persona pertenezca al mismo brand_container que la campaign
  const { data: c } = await supabase.from("campaigns").select("id, brand_container_id").eq("id", campaignId).maybeSingle();
  if (!c) throw new Error("campaign no encontrada");
  const { data: p } = await supabase.from("audience_personas").select("id, brand_container_id").eq("id", personaId).maybeSingle();
  if (!p) throw new Error("persona no encontrada");
  if (c.brand_container_id !== p.brand_container_id) throw new Error("campaign y persona en distintos brand_containers");

  const { data, error } = await supabase.from("campaigns").update({ persona_id: personaId, updated_at: new Date().toISOString() }).eq("id", campaignId).select().single();
  if (error) throw new Error();
  return { table: "campaigns", row_id: data.id, operation: "link_persona", persona_id: personaId };
}

async function _executeLinkSegmentToPersona(action) {
  const segmentId = action.target_id || action.proposed_payload?.segment_id;
  const personaId = action.proposed_payload?.persona_id;
  if (!segmentId) throw new Error("link_segment_to_persona requiere target_id (segment_id)");
  if (!personaId) throw new Error("link_segment_to_persona requiere proposed_payload.persona_id");

  const { data: s } = await supabase.from("audience_segments").select("id, brand_container_id").eq("id", segmentId).maybeSingle();
  if (!s) throw new Error("segment no encontrado");
  const { data: p } = await supabase.from("audience_personas").select("id, brand_container_id").eq("id", personaId).maybeSingle();
  if (!p) throw new Error("persona no encontrada");
  if (s.brand_container_id !== p.brand_container_id) throw new Error("segment y persona en distintos brand_containers");

  const { data, error } = await supabase.from("audience_segments").update({ persona_id: personaId, updated_at: new Date().toISOString() }).eq("id", segmentId).select().single();
  if (error) throw new Error();
  return { table: "audience_segments", row_id: data.id, operation: "link_persona", persona_id: personaId };
}

async function _executeUnlinkCampaignPersona(action) {
  const campaignId = action.target_id || action.proposed_payload?.campaign_id;
  if (!campaignId) throw new Error("unlink_campaign_persona requiere target_id");
  const { data, error } = await supabase.from("campaigns").update({ persona_id: null, updated_at: new Date().toISOString() }).eq("id", campaignId).select().single();
  if (error) throw new Error();
  return { table: "campaigns", row_id: data.id, operation: "unlink_persona" };
}

async function _executeUnlinkSegmentPersona(action) {
  const segmentId = action.target_id || action.proposed_payload?.segment_id;
  if (!segmentId) throw new Error("unlink_segment_persona requiere target_id");
  const { data, error } = await supabase.from("audience_segments").update({ persona_id: null, updated_at: new Date().toISOString() }).eq("id", segmentId).select().single();
  if (error) throw new Error();
  return { table: "audience_segments", row_id: data.id, operation: "unlink_persona" };
}

// ── Notificación post-ejecución ─────────────────────────────────────────────
async function _notifyExecutionResult(action, finalStatus, errorMessage) {
  try {
    const { data: org } = await supabase
      .from("organizations")
      .select("owner_user_id")
      .eq("id", action.organization_id)
      .maybeSingle();
    if (!org?.owner_user_id) return;

    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", org.owner_user_id)
      .maybeSingle();

    const link = `https://app.aismartcontent.io/pending-actions/${action.id}`;

    if (finalStatus === "executed") {
      await notifyUser({
        user_id:    org.owner_user_id,
        user_email: profile?.email,
        title:      `Acción ejecutada: ${action.action_type}`,
        message:    `La acción "${action.action_type}" fue completada exitosamente por VERA.`,
        type:       "success",
        link_to:    link,
      });
    } else {
      await notifyUser({
        user_id:    org.owner_user_id,
        user_email: profile?.email,
        title:      `⚠️ Falló la ejecución: ${action.action_type}`,
        message:    `La acción "${action.action_type}" no se pudo completar: ${errorMessage}`,
        type:       "error",
        link_to:    link,
        send_email: true,
      });
    }
  } catch (e) {
    console.warn(`[action-executor] notify error (non-blocking): ${e.message}`);
  }
}
