/**
 * Strategy Tools — visibilidad para Vera sobre su propia operación.
 *
 * Disponibles en fase B (parcial) y C (total). Vera lee:
 *   - body_missions          → su backlog de trabajo automático
 *   - vera_pending_actions   → propuestas que hizo y su estado de aprobación
 *
 * IMPORTANTE: Estas tools son SOLO de lectura. Aprobar / rechazar acciones
 * NO se expone a Vera; eso solo lo hace el usuario via /internal/vera-actions/*.
 * Esto evita que Vera se auto-apruebe acciones de escritura.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

const ALLOWED_MISSION_STATUS = new Set([
  "pending", "running", "completed", "failed", "all",
]);

const ALLOWED_ACTION_STATUS = new Set([
  "pending", "approved", "executing", "executed", "failed", "rejected", "expired", "all",
]);

// ── body_missions ────────────────────────────────────────────────────────────

/**
 * Lista las misiones de Vera (briefings, análisis automáticos, respuestas a señales).
 * Filtrable por estado. Por defecto: pending + running.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.status]  pending|running|completed|failed|all
 * @param {number} [params.limit]   máx 50, default 20
 */
export async function getBodyMissions({ organizationId, status, limit }) {
  const bc = await resolveBrandContainer(null, organizationId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  let q = supabase
    .from("body_missions")
    .select("id, mission_type, status, action_payload, result_reference, trigger_signal_id, created_at, updated_at")
    .eq("brand_container_id", bc.id)
    .order("created_at", { ascending: false })
    .limit(cap);

  if (status && ALLOWED_MISSION_STATUS.has(status) && status !== "all") {
    q = q.eq("status", status);
  } else if (!status) {
    q = q.in("status", ["pending", "running"]);
  }

  const { data, error } = await q;
  if (error) throw error;
  return { count: data?.length || 0, missions: data || [] };
}

/**
 * Briefing del día actual de Vera para esta marca.
 * Lee body_missions creadas HOY (Bogotá UTC-5), prioriza completed con result_reference.
 *
 * Retorna un resumen consumible: misiones del día, su estado y links a sus outputs.
 */
export async function getBriefingHoy({ organizationId }) {
  const bc = await resolveBrandContainer(null, organizationId);

  // Ventana = inicio de hoy en Bogotá (UTC-5) hasta ahora
  const now = new Date();
  const bogota = new Date(now.getTime() - 5 * 3600 * 1000);
  const startBogota = new Date(Date.UTC(
    bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate(), 5, 0, 0
  ));

  const { data, error } = await supabase
    .from("body_missions")
    .select("id, mission_type, status, action_payload, result_reference, created_at, updated_at")
    .eq("brand_container_id", bc.id)
    .gte("created_at", startBogota.toISOString())
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) throw error;

  const missions = data || [];
  const summary = {
    fecha_bogota: bogota.toISOString().slice(0, 10),
    total_misiones: missions.length,
    completadas:    missions.filter((m) => m.status === "completed").length,
    en_curso:       missions.filter((m) => m.status === "running").length,
    pendientes:     missions.filter((m) => m.status === "pending").length,
    fallidas:       missions.filter((m) => m.status === "failed").length,
  };

  // Misiones completed con result_reference son los "outputs" del briefing
  const briefing = missions
    .filter((m) => m.status === "completed" && m.result_reference)
    .map((m) => ({
      id:               m.id,
      tipo:             m.mission_type,
      result_reference: m.result_reference,
      completado_at:    m.updated_at,
    }));

  return {
    summary,
    briefing,
    has_pending: summary.pendientes + summary.en_curso > 0,
    raw_missions: missions,
  };
}

// ── vera_pending_actions ─────────────────────────────────────────────────────

/**
 * Cola de acciones que Vera propuso y su estado de aprobación.
 * Vera lee esto para saber qué propuso, qué se aprobó/ejecutó y qué sigue pendiente.
 *
 * NO incluye approve/reject — esas son responsabilidad del usuario.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.status]  pending|approved|executing|executed|failed|rejected|expired|all
 * @param {number} [params.limit]   máx 50, default 20
 */
export async function getPendingActions({ organizationId, status, limit }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  let q = supabase
    .from("vera_pending_actions")
    .select(
      "id, action_type, target_table, target_id, status, " +
      "vera_reasoning, vera_confidence, expires_at, " +
      "created_at, executed_at, error_message"
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(cap);

  if (status && ALLOWED_ACTION_STATUS.has(status) && status !== "all") {
    q = q.eq("status", status);
  } else if (!status) {
    q = q.eq("status", "pending");
  }

  const { data, error } = await q;
  if (error) throw error;

  const actions = data || [];
  return {
    count: actions.length,
    by_status: actions.reduce((acc, a) => {
      acc[a.status] = (acc[a.status] || 0) + 1;
      return acc;
    }, {}),
    actions,
  };
}

/**
 * Detalle completo de una pending_action específica (incluye payload propuesto y current_state).
 * Vera lo usa para revisar qué propuso exactamente o por qué algo falló.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.action_id
 */
export async function getPendingActionDetail({ organizationId, action_id }) {
  if (!action_id) throw new Error("action_id es requerido");

  const { data, error } = await supabase
    .from("vera_pending_actions")
    .select("*")
    .eq("id", action_id)
    .eq("organization_id", organizationId)  // anti cross-tenant
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`Pending action ${action_id} no encontrada para esta organización`);

  return data;
}

// ── Strategy Opportunity Score ───────────────────────────────────────────────
//
// Fórmula compuesta: velocity*0.4 + gap_competencia*0.35 + relevancia_marca*0.25
//
// Definiciones (v1 — ajustables sin romper el contrato):
//   • velocity_norm     = trend_topics.velocity_score / 10              ∈ [0,1]
//   • gap_competencia   = (competidores_usando_topic / total_competidores)
//                          * (marca_NO_usa_topic ? 1 : 0)               ∈ [0,1]
//                         → si la marca ya usa el topic, gap=0 (no es nueva oportunidad)
//                         → si nadie de la competencia lo usa, gap=0 (no es trend competitivo)
//   • relevancia_marca  = min(matches_keywords_marca_en_topic / 3, 1)   ∈ [0,1]
//                         → booleano gradiente con techo en 3 matches
//                         → si la marca no tiene keywords configuradas → 0.5 (neutral)
//
// Ventana temporal: 30 días (consistente con benchmarks de social-analytics skill).
// Retail/precios NO entra en el score base — queda como dimensión auxiliar para v2.

const OPPORTUNITY_WINDOW_DAYS = 30;

async function _computeOpportunityForTopic({ topic, brandContainerId, competitorIds, brandKeywords, sinceISO }) {
  const kwLower = String(topic.keyword || "").toLowerCase().trim();
  if (!kwLower) {
    return null;
  }

  const queries = [];

  // 1. ¿Cuántos competidores DISTINTOS han mencionado este topic en la ventana?
  if (competitorIds.length > 0) {
    queries.push(
      supabase
        .from("intelligence_signals")
        .select("entity_id")
        .in("entity_id", competitorIds)
        .ilike("content_text", `%${kwLower}%`)
        .gte("captured_at", sinceISO)
        .limit(500)
    );
  } else {
    queries.push(Promise.resolve({ data: [] }));
  }

  // 2. ¿La marca propia ha usado el topic en sus posts (no-competidor)?
  queries.push(
    supabase
      .from("brand_posts")
      .select("id", { count: "exact", head: true })
      .eq("brand_container_id", brandContainerId)
      .eq("is_competitor", false)
      .ilike("content", `%${kwLower}%`)
      .gte("captured_at", sinceISO)
  );

  const [sigRes, postRes] = await Promise.all(queries);

  const competitorsUsingTopic = sigRes?.data
    ? new Set(sigRes.data.map((s) => s.entity_id)).size
    : 0;
  const marcaUsaTopic = (postRes?.count || 0) > 0;

  // gap_competencia
  const gapCompetencia = competitorIds.length > 0 && !marcaUsaTopic
    ? competitorsUsingTopic / competitorIds.length
    : 0;

  // relevancia_marca
  let matches = 0;
  for (const kw of brandKeywords) {
    if (kw && kwLower.includes(kw)) matches++;
  }
  const relevanciaMarca = brandKeywords.length === 0
    ? 0.5
    : Math.min(matches / 3, 1);

  const velocityNorm = Math.min(Math.max(Number(topic.velocity_score) || 0, 0) / 10, 1);
  const scoreCompuesto = +(
    velocityNorm * 0.4 +
    gapCompetencia * 0.35 +
    relevanciaMarca * 0.25
  ).toFixed(3);

  return {
    id:           topic.id,
    keyword:      topic.keyword,
    category:     topic.category,
    source:       topic.source,
    sentiment:    topic.sentiment,
    detected_at:  topic.detected_at,
    components: {
      velocity_score:    +velocityNorm.toFixed(3),
      gap_competencia:   +gapCompetencia.toFixed(3),
      relevancia_marca:  +relevanciaMarca.toFixed(3),
    },
    raw_signals: {
      competitors_using_topic: competitorsUsingTopic,
      total_competitors:       competitorIds.length,
      marca_usa_topic:         marcaUsaTopic,
      brand_keyword_matches:   matches,
    },
    score_compuesto: scoreCompuesto,
  };
}

/**
 * Score de Oportunidad estratégica por topic — fórmula compuesta del dashboard Estrategia.
 *
 * Toma los top-N topics del último mes, calcula sus componentes y un score final 0-1
 * ordenado descendente. Vera puede usarlo para priorizar contenido sobre topics que:
 *   - tienen velocidad alta en el ecosistema
 *   - los competidores ya están usando pero la marca no
 *   - encajan con las palabras clave configuradas en el perfil de marca
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {number} [params.limit]  máx 30, default 10
 */
export async function getStrategyOpportunityScore({ organizationId, limit }) {
  const bc = await resolveBrandContainer(null, organizationId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  const sinceISO = new Date(Date.now() - OPPORTUNITY_WINDOW_DAYS * 86400000).toISOString();

  // 1. Top trend_topics por velocity en la ventana
  const { data: topics, error: topicsErr } = await supabase
    .from("trend_topics")
    .select("id, keyword, source, category, velocity_score, relevance_score, sentiment, detected_at")
    .eq("brand_container_id", bc.id)
    .gte("detected_at", sinceISO)
    .order("velocity_score", { ascending: false })
    .limit(cap);

  if (topicsErr) throw topicsErr;
  if (!topics?.length) {
    return {
      count: 0,
      window_days: OPPORTUNITY_WINDOW_DAYS,
      formula: "velocity*0.4 + gap_competencia*0.35 + relevancia_marca*0.25",
      opportunities: [],
      reason: "Sin trend_topics detectados en los últimos 30 días para esta marca",
    };
  }

  // 2. Cargar competidores y keywords de marca en paralelo
  const [entitiesRes, brandRes] = await Promise.all([
    supabase
      .from("intelligence_entities")
      .select("id")
      .eq("brand_container_id", bc.id),
    supabase
      .from("brands")
      .select("palabras_clave")
      .eq("project_id", bc.id)
      .maybeSingle(),
  ]);

  const competitorIds = (entitiesRes.data || []).map((e) => e.id);
  const brandKeywords = (brandRes.data?.palabras_clave || [])
    .map((k) => String(k || "").toLowerCase().trim())
    .filter(Boolean);

  // 3. Calcular score por topic en paralelo
  const computed = await Promise.all(
    topics.map((t) =>
      _computeOpportunityForTopic({
        topic:             t,
        brandContainerId:  bc.id,
        competitorIds,
        brandKeywords,
        sinceISO,
      })
    )
  );

  const opportunities = computed
    .filter(Boolean)
    .sort((a, b) => b.score_compuesto - a.score_compuesto);

  return {
    count:        opportunities.length,
    window_days:  OPPORTUNITY_WINDOW_DAYS,
    formula:      "velocity*0.4 + gap_competencia*0.35 + relevancia_marca*0.25",
    brand_has_keywords: brandKeywords.length > 0,
    competitors_monitored: competitorIds.length,
    opportunities,
  };
}
