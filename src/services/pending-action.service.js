/**
 * Pending Action Service — VERA propone, el usuario decide (o autonomy total ejecuta inline).
 *
 * Flujo:
 *   1. INSERT en vera_pending_actions con TTL según action_type
 *   2. Notifica al owner de la org (in-app + email si type warning/error)
 *   3. Linkea notification_id al action
 *   4. Si autonomy=total → aprueba via RPC + delega a action-executor inline
 *   5. Si autonomy=parcial → retorna el action en estado pending
 */
import { supabase } from "../lib/supabase.js";
import { notifyUser } from "./notification.service.js";

// ── TTL por action_type (horas) ─────────────────────────────────────────────
function _resolveTTL(actionType) {
  if (actionType === "publish_instagram_post" || actionType === "publish_facebook_post") return 24;
  if (actionType === "schedule_instagram_post" || actionType === "schedule_facebook_post") return 72;
  if (actionType === "update_brand_container") return 168;
  if (actionType.startsWith("create_brand_") ||
      actionType.startsWith("update_brand_") ||
      actionType.startsWith("delete_brand_")) return 168;
  return 72;
}

// ── Títulos de notificación por action_type ─────────────────────────────────
const NOTIF_TITLES = {
  publish_instagram_post:    "VERA preparó un post de Instagram para tu aprobación",
  publish_facebook_post:     "VERA preparó un post de Facebook para tu aprobación",
  schedule_instagram_post:   "VERA propone programar un post de Instagram",
  schedule_facebook_post:    "VERA propone programar un post de Facebook",
  update_brand_container:    "VERA propone actualizar el ADN de marca",
  create_brand_color:        "VERA propone añadir un color de marca",
  update_brand_color:        "VERA propone editar un color de marca",
  delete_brand_color:        "VERA propone eliminar un color de marca",
  create_brand_font:         "VERA propone añadir una tipografía",
  update_brand_font:         "VERA propone editar una tipografía",
  delete_brand_font:         "VERA propone eliminar una tipografía",
  create_brand_rule:         "VERA propone una nueva regla de marca",
  update_brand_rule:         "VERA propone editar una regla de marca",
  delete_brand_rule:         "VERA propone eliminar una regla de marca",
  create_product:            "VERA propone un nuevo producto",
  update_product:            "VERA propone editar un producto",
  delete_product:            "VERA propone eliminar un producto",
  create_service:            "VERA propone un nuevo servicio",
  update_service:            "VERA propone editar un servicio",
  delete_service:            "VERA propone eliminar un servicio",
  create_audience:           "VERA propone una nueva audiencia",
  update_audience:           "VERA propone editar una audiencia",
  delete_audience:           "VERA propone eliminar una audiencia",
  merge_audiences:           "VERA propone fusionar audiencias",
  archive_audience:          "VERA propone archivar una audiencia",
  create_campaign:           "VERA propone una nueva campaña",
  update_campaign:           "VERA propone editar una campaña",
  archive_campaign:          "VERA propone archivar una campaña",
  launch_campaign:           "VERA propone lanzar una campaña",
  create_schedule:           "VERA propone un nuevo schedule",
  update_schedule:           "VERA propone editar un schedule",
  pause_schedule:            "VERA propone pausar un schedule",
  activate_schedule:         "VERA propone activar un schedule",
  add_intelligence_entity:   "VERA propone monitorear una nueva entidad",
  remove_intelligence_entity:"VERA propone dejar de monitorear una entidad",
  add_url_watcher:           "VERA propone vigilar una URL",
  remove_url_watcher:        "VERA propone dejar de vigilar una URL",
  update_monitoring_trigger: "VERA propone ajustar un trigger de monitoreo",
  add_brand_integration:     "VERA propone añadir una integración",
  remove_brand_integration:  "VERA propone eliminar una integración",
};

function _buildNotifTitle(actionType) {
  return NOTIF_TITLES[actionType] || `VERA propone una acción (${actionType})`;
}

function _buildNotifMessage(reasoning) {
  const firstLine = String(reasoning || "").split("\n")[0];
  return firstLine.slice(0, 200) + (firstLine.length > 200 ? "..." : "");
}

// ── proposeAction ───────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} [opts.brandContainerId]
 * @param {string} opts.actionType
 * @param {string} opts.targetTable
 * @param {string|null} [opts.targetId]
 * @param {object} opts.proposedPayload
 * @param {object|null} [opts.currentState]
 * @param {string} opts.veraReasoning           — obligatorio
 * @param {number|null} [opts.veraConfidence]   — 0..1
 * @param {string|null} [opts.sourceSignalId]
 * @param {string|null} [opts.sourceJobId]
 * @returns {Promise<object>} action row
 */
export async function proposeAction({
  organizationId,
  brandContainerId = null,
  actionType,
  targetTable,
  targetId = null,
  proposedPayload,
  currentState = null,
  veraReasoning,
  veraConfidence = null,
  sourceSignalId = null,
  sourceJobId = null,
}) {
  if (!veraReasoning || !String(veraReasoning).trim()) {
    throw new Error("vera_reasoning es obligatorio — VERA debe justificar cada propuesta");
  }
  if (!organizationId || !actionType || !targetTable) {
    throw new Error("organizationId, actionType y targetTable son obligatorios");
  }

  const ttlHours = _resolveTTL(actionType);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();

  // 1. INSERT
  const { data: action, error: insertErr } = await supabase
    .from("vera_pending_actions")
    .insert({
      organization_id:    organizationId,
      brand_container_id: brandContainerId,
      action_type:        actionType,
      target_table:       targetTable,
      target_id:          targetId,
      proposed_payload:   proposedPayload || {},
      current_state:      currentState,
      vera_reasoning:     veraReasoning,
      vera_confidence:    veraConfidence,
      source_signal_id:   sourceSignalId,
      source_job_id:      sourceJobId,
      expires_at:         expiresAt,
    })
    .select()
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      throw new Error(
        `Ya existe una acción pendiente del mismo tipo "${actionType}" sobre ${targetTable}/${targetId}`
      );
    }
    throw insertErr;
  }

  // 2. Resolver owner + autonomy
  const { data: org } = await supabase
    .from("organizations")
    .select("owner_user_id, level_of_autonomy")
    .eq("id", organizationId)
    .maybeSingle();

  // 3. Notificar al owner (best-effort)
  if (org?.owner_user_id) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email")
        .eq("id", org.owner_user_id)
        .maybeSingle();

      const notif = await notifyUser({
        user_id:    org.owner_user_id,
        user_email: profile?.email,
        title:      _buildNotifTitle(actionType),
        message:    _buildNotifMessage(veraReasoning),
        type:       "info",
        link_to:    null, // navegacion pendiente: sin ruta org/ valida aun, evitar link roto
      });

      // Linkear notif al action
      if (notif?.id) {
        await supabase
          .from("vera_pending_actions")
          .update({ notification_id: notif.id })
          .eq("id", action.id);
        action.notification_id = notif.id;
      }
    } catch (e) {
      console.warn(`[pending-action] notify error (non-blocking) action=${action.id}: ${e.message}`);
    }
  }

  // 4. Auto-ejecucion: BAJO auto-elegible (cualquier org) o autonomy=total (todo).
  //    MEDIO/ALTO siempre esperan aprobacion humana. CRITICO ni llega aqui.
  const _isBajoAuto = proposedPayload?._auto_eligible === true;
  const _isFullAutonomy = org?.level_of_autonomy === "total";
  if (org?.owner_user_id && (_isBajoAuto || _isFullAutonomy)) {
    try {
      // Auto-aprobacion del SISTEMA (BAJO/autonomy=total) via service-role.
      // La RPC fn_vpa_approve exige permisos de USUARIO que el auto-exec del sistema no necesita.
      await supabase.from("vera_pending_actions")
        .update({ status: "approved", approved_at: new Date().toISOString(), approved_by: org.owner_user_id })
        .eq("id", action.id);

      console.log(`[pending-action] auto-exec ${_isBajoAuto ? "BAJO" : "autonomy=total"} → ejecutando action ${action.id} (${actionType})`);
      const { executeAction } = await import("./action-executor.service.js");
      return await executeAction(action.id, org.owner_user_id, { autoApproved: true });
    } catch (e) {
      console.error(`[pending-action] auto-execute error: ${e.message}`);
      return action;
    }
  }

  // 5. Autonomy parcial → return pending
  return action;
}
