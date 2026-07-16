/**
 * vera-feed.tools.js — Tools que Vera usa durante el ciclo de pulso (brain feed).
 *
 * - createOrgNotification: notifica a la org cuando algo requiere su decisión.
 * - proposeStrategicRecommendation: deja un brief 'proposed' para revisión humana.
 * - getBrainFeed: drill-down al payload completo de un feed cuando el resumen
 *   inline no fue suficiente.
 *
 * Cada tool valida que el recurso pertenece a la org del caller (multi-tenant
 * safety) antes de escribir/leer.
 */

import { supabase } from "../lib/supabase.js";

const VALID_SEVERITIES = new Set(["info", "warning", "critical"]);

export async function createOrgNotification(params, brandContainerId, organizationId) {
  const { severity = "info", type = "vera_insight", title, body,
          action_url = null, action_label = null, brand_container_id = null,
          metadata = {} } = params || {};

  if (!title || !body) throw new Error("title y body son requeridos");
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`severity debe ser uno de: ${[...VALID_SEVERITIES].join(", ")}`);
  }

  // El brand_container_id efectivo: parámetro explícito, o el del caller (si Vera
  // está operando en un brand específico), o null (notificación org-wide).
  const effectiveBrandId = brand_container_id || brandContainerId || null;
  if (effectiveBrandId) {
    const { data: bc } = await supabase
      .from("brand_containers")
      .select("id")
      .eq("id", effectiveBrandId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!bc) throw new Error(`brand_container ${effectiveBrandId} no pertenece a esta org`);
  }

  const { error, data } = await supabase.from("org_notifications").insert({
    organization_id:    organizationId,
    brand_container_id: effectiveBrandId,
    severity,
    type,
    title,
    body,
    action_url,
    action_label,
    metadata: { source: "vera_cycle_pulse", ...metadata },
  }).select("id, created_at").single();

  if (error) throw new Error(`createOrgNotification: ${error.message}`);

  return {
    success: true,
    notification_id: data.id,
    created_at: data.created_at,
    message: `Notificación "${title.slice(0, 60)}" creada (severity=${severity})`,
  };
}

export async function proposeStrategicRecommendation(params, brandContainerId, organizationId) {
  const {
    title, description, topic, tone = null, mood = null,
    confidence = "media", rationale = null, recommended_network = null,
    target_persona = null, anchor_product_name = null, brand_container_id = null,
  } = params || {};

  if (!title || !topic || !description) {
    throw new Error("title, topic y description son requeridos");
  }
  const validConfidence = new Set(["baja", "media", "alta"]);
  if (!validConfidence.has(confidence)) {
    throw new Error(`confidence debe ser: ${[...validConfidence].join(", ")}`);
  }

  const effectiveBrandId = brand_container_id || brandContainerId;
  if (!effectiveBrandId) throw new Error("brand_container_id requerido");

  const { data: bc } = await supabase
    .from("brand_containers")
    .select("id")
    .eq("id", effectiveBrandId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!bc) throw new Error(`brand_container ${effectiveBrandId} no pertenece a esta org`);

  const { error, data } = await supabase.from("strategic_recommendations").insert({
    organization_id:        organizationId,
    brand_container_id:     effectiveBrandId,
    title,
    description,
    topic,
    tone,
    mood,
    confidence,
    rationale_commercial:   rationale,
    recommended_network:    recommended_network ? (Array.isArray(recommended_network) ? recommended_network : [recommended_network]) : null,
    target_persona,
    anchor_product_name,
    status:                 "proposed",
    vera_model:             "via_cycle_pulse",
    generated_at:           new Date().toISOString(),
  }).select("id, generated_at").single();

  if (error) throw new Error(`proposeStrategicRecommendation: ${error.message}`);

  return {
    success: true,
    recommendation_id: data.id,
    status: "proposed",
    message: `Brief "${title.slice(0, 60)}" propuesto (confidence=${confidence})`,
  };
}

const VALID_BUCKETS = new Set([
  "all",
  "brand_context",
  "competitor_intelligence",
  "trend_signals",
  "threats_and_opportunities",
  "operational_context",
  "counts",
]);

export async function getBrainFeed(params, brandContainerId, organizationId) {
  const { feed_id, bucket = "all" } = params || {};
  if (!feed_id) throw new Error("feed_id requerido");
  if (!VALID_BUCKETS.has(bucket)) {
    throw new Error(`bucket debe ser uno de: ${[...VALID_BUCKETS].join(", ")}`);
  }

  const { data: feed, error } = await supabase
    .from("vera_brain_feeds")
    .select("id, brand_container_id, organization_id, window_start, window_end, feed_payload, status, actions_count")
    .eq("id", feed_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`getBrainFeed: ${error.message}`);
  if (!feed) throw new Error(`brain feed ${feed_id} no encontrado o no pertenece a esta org`);

  const payload = feed.feed_payload || {};
  return {
    success: true,
    feed_id: feed.id,
    brand_container_id: feed.brand_container_id,
    window: { start: feed.window_start, end: feed.window_end },
    status: feed.status,
    data: bucket === "all" ? payload : (payload[bucket] || null),
  };
}

/**
 * initiateConversation — Vera ABRE un hilo con un humano de la org sin esperar a
 * que le escriban. Crea la conversación (metadata.initiated_by='vera') + el primer
 * mensaje (role=assistant) + una notificación para que el humano sepa que Vera le
 * escribió. Parte del modelo "ejecutar-e-informar": Vera rinde cuentas por su cuenta.
 *
 * params: { topic, opening_message, reason?, audience_role?, brand_container_id? }
 *  - audience_role: si se pasa, dirige el hilo a un miembro con ese rol; si no,
 *    prefiere owner/admin, y si no hay, cualquier miembro.
 */
export async function initiateConversation(params, brandContainerId, organizationId) {
  const { topic, opening_message, reason = null, audience_role = null,
          brand_container_id = null } = params || {};
  if (!topic || !opening_message) {
    throw new Error("topic y opening_message son requeridos");
  }

  // Resolver el humano destinatario dentro de la org (user_id es NOT NULL).
  const { data: members, error: mErr } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", organizationId);
  if (mErr) throw new Error(`initiateConversation: ${mErr.message}`);
  if (!members || !members.length) {
    throw new Error("la org no tiene miembros a quien escribir");
  }
  const rank = (r) => (r === "owner" ? 0 : r === "admin" ? 1 : 2);
  let target = null;
  if (audience_role) {
    target = members.find((m) => m.role === audience_role) || null;
  }
  if (!target) {
    target = [...members].sort((a, b) => rank(a.role) - rank(b.role))[0];
  }

  const effectiveBrandId = brand_container_id || brandContainerId || null;

  const { data: conv, error: cErr } = await supabase
    .from("ai_conversations")
    .insert({
      organization_id:    organizationId,
      brand_container_id: effectiveBrandId,
      user_id:            target.user_id,
      title:              topic.slice(0, 120),
      is_active:          true,
      metadata:           { initiated_by: "vera", reason, source: "vera_brain_feed" },
    })
    .select("id")
    .single();
  if (cErr) throw new Error(`initiateConversation: ${cErr.message}`);

  const { error: msgErr } = await supabase.from("ai_messages").insert({
    conversation_id: conv.id,
    organization_id: organizationId,
    role:            "assistant",
    content:         opening_message,
    metadata:        { initiated_by: "vera", reason },
  });
  if (msgErr) throw new Error(`initiateConversation (mensaje): ${msgErr.message}`);

  // Avisar al humano que Vera abrió un hilo (para que aparezca como no leído).
  await supabase.from("org_notifications").insert({
    organization_id:    organizationId,
    brand_container_id: effectiveBrandId,
    severity:           "info",
    type:               "vera_message",
    title:              `Vera te escribió: ${topic.slice(0, 80)}`,
    body:               opening_message.slice(0, 280),
    action_url:         `/vera?c=${conv.id}`,
    action_label:       "Abrir conversación",
    metadata:           { source: "vera_initiated_conversation", conversation_id: conv.id },
  });

  return {
    success: true,
    conversation_id: conv.id,
    target_user_id: target.user_id,
    target_role: target.role,
    message: `Conversación "${topic.slice(0, 60)}" iniciada con ${target.role}`,
  };
}
