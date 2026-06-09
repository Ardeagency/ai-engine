/**
 * decision.tools.js — el nucleo decisional de Estrategia (Motor de Sintesis VERA).
 *
 * proposePendingAction: la tool que conecta el CEREBRO (Vera/Claude) con el pipeline
 * de accion (vera_pending_actions -> dashboard Estrategia -> approve humano -> executor).
 * Aplica las dos reglas del spec de Estrategia:
 *   1. CONFIRMACION CRUZADA DE 2 FUENTES: ninguna accion se propone con una sola señal.
 *   2. RISK-GRADING por action_type: BAJO (auto-elegible) / MEDIO / ALTO / CRITICO
 *      (CRITICO no se propone — solo se notifica).
 * Vera nunca auto-aprueba (escribe en 'pending'); el humano decide en el dashboard.
 */
import { proposeAction } from "../services/pending-action.service.js";
import { supabase } from "../lib/supabase.js";

// Vocabulario permitido (debe coincidir con el CHECK de vera_pending_actions.action_type)
const ALLOWED = new Set([
  "publish_instagram_post","publish_facebook_post","schedule_instagram_post","schedule_facebook_post",
  "update_brand_container","create_brand_color","update_brand_color","delete_brand_color",
  "create_brand_font","update_brand_font","delete_brand_font","create_brand_rule","update_brand_rule","delete_brand_rule",
  "create_product","update_product","delete_product","create_service","update_service","delete_service",
  "create_brief","update_brief","archive_brief","delete_brief",
  "create_persona","update_persona","archive_persona","delete_persona","merge_personas",
  "create_campaign","update_campaign","archive_campaign","launch_campaign","pause_campaign",
  "link_brief_to_campaign","unlink_brief_from_campaign",
  "create_segment","update_segment","delete_segment","link_segment_to_persona",
  "create_audience","update_audience","delete_audience","merge_audiences","archive_audience",
  "create_schedule","update_schedule","pause_schedule","activate_schedule",
  "add_intelligence_entity","remove_intelligence_entity","add_url_watcher","remove_url_watcher",
  "update_monitoring_trigger","add_brand_integration","remove_brand_integration",
  "update_shopify_variant_price","create_shopify_discount","create_shopify_price_rule",
]);

// Risk tier por action_type (spec Estrategia, seccion 5). Default conservador = ALTO.
const RISK = {
  // BAJO — contenido organico / tono / monitoreo (auto-elegible)
  create_brief:"BAJO", update_brief:"BAJO", archive_brief:"BAJO",
  add_intelligence_entity:"BAJO", remove_intelligence_entity:"BAJO",
  add_url_watcher:"BAJO", remove_url_watcher:"BAJO", update_monitoring_trigger:"BAJO",
  create_brand_rule:"BAJO", update_brand_rule:"BAJO",
  // MEDIO — pauta ajuste / producto sugerencia / ADN / schedule
  update_brand_container:"MEDIO", update_product:"MEDIO", create_product:"MEDIO",
  update_campaign:"MEDIO", update_audience:"MEDIO", create_audience:"MEDIO",
  create_segment:"MEDIO", update_segment:"MEDIO",
  create_schedule:"MEDIO", update_schedule:"MEDIO", pause_schedule:"MEDIO", activate_schedule:"MEDIO",
  schedule_instagram_post:"MEDIO", schedule_facebook_post:"MEDIO",
  // ALTO — precio / campaña nueva / publicar / shopify price (approve con edicion)
  launch_campaign:"ALTO", create_campaign:"ALTO", pause_campaign:"ALTO",
  publish_instagram_post:"ALTO", publish_facebook_post:"ALTO",
  update_shopify_variant_price:"ALTO", create_shopify_discount:"ALTO", create_shopify_price_rule:"ALTO",
};

// target_table sugerida por action_type (informativa; el executor despacha por action_type)
function _targetTable(at) {
  if (at.includes("brief")) return "campaign_briefs";
  if (at.includes("campaign")) return "campaigns";
  if (at.includes("audience")) return "audiences";
  if (at.includes("persona")) return "audience_personas";
  if (at.includes("segment")) return "segments";
  if (at.includes("product")) return "products";
  if (at.includes("service")) return "services";
  if (at.includes("schedule")) return "flow_schedules";
  if (at.startsWith("create_brand_") || at.startsWith("update_brand_") || at.startsWith("delete_brand_") || at === "update_brand_container") return "brand_containers";
  if (at.includes("intelligence_entity") || at.includes("url_watcher") || at.includes("monitoring")) return "monitoring_triggers";
  if (at.includes("shopify")) return "shopify_sync";
  if (at.includes("post")) return "brand_posts";
  return "vera_pending_actions";
}

const HORIZON_PRIORITY = { hoy: 9, semana: 6, mes: 3 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * proposePendingAction — Vera propone una accion graduada para el dashboard Estrategia.
 * params: {
 *   action_type, reasoning, confidence (0-1), horizon ("hoy"|"semana"|"mes"),
 *   payload {}, target_id?, source_signals: [str,str,...]  (>=2, regla de 2 fuentes),
 *   impact_estimate? {}
 * }
 */
export async function proposePendingAction(params = {}, brandContainerId, organizationId) {
  const actionType = params.action_type || params.actionType;
  const reasoning  = params.reasoning || params.vera_reasoning;
  const sources    = params.source_signals || params.sources || [];
  const horizon    = (params.horizon || "semana").toLowerCase();

  if (!actionType) throw new Error("proposePendingAction: action_type es requerido");
  if (!reasoning || !String(reasoning).trim()) {
    throw new Error("proposePendingAction: reasoning es obligatorio — Vera debe justificar cada accion (vera_reasoning)");
  }
  // REGLA DE 2 FUENTES
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new Error("proposePendingAction: REGLA DE 2 FUENTES — necesitas >=2 source_signals (de dashboards/señales distintas) que confirmen la oportunidad. Con una sola señal usa createNotification o espera otra confirmacion; no propongas una accion.");
  }
  if (!ALLOWED.has(actionType)) {
    throw new Error(`proposePendingAction: action_type "${actionType}" no es valido. Ej validos: create_brief (CONTENIDO), update_campaign (PAUTA), launch_campaign, update_brand_container (TONO/ADN), create_audience, add_intelligence_entity (MONITOREO).`);
  }
  // RISK-GRADING
  const risk = RISK[actionType] || "ALTO";
  if (risk === "CRITICO") {
    throw new Error("proposePendingAction: accion de riesgo CRITICO (crisis propia / legal-etico / cambio de posicionamiento) — Vera NO propone acciones criticas, solo NOTIFICA. Usa createNotification severity=critical.");
  }

  let confidence = params.confidence ?? params.vera_confidence ?? null;
  if (confidence != null) confidence = Math.max(0, Math.min(1, Number(confidence)));
  const priority = HORIZON_PRIORITY[horizon] ?? 6;

  const payload = {
    ...(params.payload || params.proposed_payload || {}),
    _risk_level:           risk,
    _auto_eligible:        risk === "BAJO",
    _horizon:              horizon,
    _source_signals:       sources,
    _two_source_confirmed: true,
    _opportunity_score:    confidence != null ? Math.round(confidence * 100) : null,
  };

  const sig0 = sources.find((s) => typeof s === "string" && UUID_RE.test(s)) || null;

  const row = await proposeAction({
    organizationId,
    brandContainerId,
    actionType,
    targetTable:      _targetTable(actionType),
    targetId:         params.target_id || null,
    proposedPayload:  payload,
    veraReasoning:    reasoning,
    veraConfidence:   confidence,
    sourceSignalId:   sig0,
  });

  // priority por horizonte (el spec usa priority para el tab HOY/SEMANA/MES)
  try { await supabase.from("vera_pending_actions").update({ priority }).eq("id", row.id); } catch (_) {}

  return {
    proposed: true,
    action_id: row.id,
    action_type: actionType,
    risk_level: risk,
    auto_eligible: risk === "BAJO",
    status: "pending",
    horizon, priority,
    opportunity_score: payload._opportunity_score,
    note: risk === "BAJO"
      ? "Propuesta de bajo riesgo (auto-elegible) — aparece en el plan de Estrategia para aprobacion 1-click."
      : `Propuesta de riesgo ${risk} — requiere aprobacion humana con revision en el dashboard de Estrategia.`,
  };
}
