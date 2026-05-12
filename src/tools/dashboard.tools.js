/**
 * Dashboard Tools — wrappers de las RPCs portadas de Partner_LLM.
 *
 * Diseño: cada función recibe `organizationId` y un objeto de params opcionales.
 * Vera (OpenClaw) puede pasar `windowDays` (natural para LLM); el helper resuelve
 * a (date_from, date_to) timestamps.
 *
 * Todas las RPCs son SECURITY DEFINER + RLS-friendly: el chequeo de auth lo hace
 * la función SQL contra `is_org_member(p_org_id)`.
 *
 * Categorías:
 *   - Mi Marca (timeline + featured + alerts + top posts) — 14 tools
 *   - Competencia (kpis + top + risk + brand_vs) — 8 tools
 *   - Estrategia (topics + hashtags + tones + platforms + sentiment-by-brand) — 5 tools
 */
import { supabase } from "../lib/supabase.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resuelve {dateFrom, dateTo} desde windowDays. Default 30 días. */
function resolveWindow(windowDays = 30) {
  const now = new Date();
  const from = new Date(now.getTime() - Math.max(1, Number(windowDays)) * 86400_000);
  return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
}

function toUuidArray(maybe) {
  if (maybe == null) return null;
  if (Array.isArray(maybe)) return maybe.length ? maybe : null;
  if (typeof maybe === "string") return [maybe];
  return null;
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
// MI MARCA
// ════════════════════════════════════════════════════════════════════════════

export async function getBrandKpisStrip({
  organizationId,
  windowDays = 30,
  brandContainerIds = null,
  postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_kpis_strip", {
    p_org_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds),
    p_post_source: postSource,
  });
}

export async function getBrandActivityHistory({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_activity_history", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getBrandEngagementTrend({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_engagement_trend", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getBrandSentimentActivity({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_sentiment_activity", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getBrandPostingHours({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own", timezone = "America/Bogota",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_posting_hours", {
    p_org_id: organizationId, p_brand_container_ids: toUuidArray(brandContainerIds),
    p_date_from: dateFrom, p_date_to: dateTo, p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedProfile({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_profile", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedProfileDetails({
  organizationId, brandContainerId, windowDays = null, postSource = "own", timezone = "America/Bogota",
}) {
  const win = windowDays != null ? resolveWindow(windowDays) : { dateFrom: null, dateTo: null };
  return rpc("dashboard_brand_featured_profile_details", {
    p_org_id: organizationId, p_brand_container_id: brandContainerId,
    p_date_from: win.dateFrom, p_date_to: win.dateTo, p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedTopic({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_topic", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedHashtag({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_hashtag", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedHour({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own", timezone = "America/Bogota",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_hour", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedPlatform({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_platform", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedGrowth({
  organizationId, windowDays = 60, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_featured_growth", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getAlertScore({
  organizationId, windowDays = 30, brandContainerIds = null, limit = 5,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_alert_score", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getTopHighlightedPosts({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = "own", limit = 10,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_top_highlighted_posts", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
    p_limit: Math.max(1, Number(limit)),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// COMPETENCIA
// ════════════════════════════════════════════════════════════════════════════

export async function getCompetenciaKpis({
  organizationId, windowDays = 30, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_competencia_kpis", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds),
  });
}

export async function getCompetenciaTop({
  organizationId, windowDays = 30, entityIds = null, limit = 10,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_competencia_top", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getCompetenciaFeatured({
  organizationId, windowDays = 30, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_competencia_featured", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds),
  });
}

export async function getCompetenciaTopPosts({
  organizationId, windowDays = 30, entityIds = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_competencia_top_posts", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getCompetenciaActorDetails({
  organizationId, entityId, windowDays = null, timezone = "America/Bogota",
}) {
  const win = windowDays != null ? resolveWindow(windowDays) : { dateFrom: null, dateTo: null };
  return rpc("dashboard_competencia_actor_details", {
    p_org_id: organizationId, p_entity_id: entityId,
    p_date_from: win.dateFrom, p_date_to: win.dateTo, p_timezone: timezone,
  });
}

export async function getCompetenciaRisk({
  organizationId, windowDays = 30, entityIds = null, limit = 5,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_competencia_risk", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getBrandVsCompetencia({
  organizationId, windowDays = 30, brandContainerIds = null, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_brand_vs_competencia", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_entity_ids: toUuidArray(entityIds),
  });
}

export async function searchCompetidor({ organizationId, searchQuery = "", limit = 10 }) {
  return rpc("dashboard_competencia_search", {
    p_org_id: organizationId, p_search_query: searchQuery, p_limit: Math.max(1, Number(limit)),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ESTRATEGIA
// ════════════════════════════════════════════════════════════════════════════

export async function getEstrategiaTopics({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_estrategia_topics", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
    p_limit: Math.max(1, Number(limit)),
  });
}

export async function getEstrategiaHashtags({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_estrategia_hashtags", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
    p_limit: Math.max(1, Number(limit)),
  });
}

export async function getEstrategiaTones({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_estrategia_tones", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
    p_limit: Math.max(1, Number(limit)),
  });
}

export async function getEstrategiaPlatforms({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_estrategia_platform_comparison", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getEstrategiaSentimentsByBrand({
  organizationId, windowDays = 30, brandContainerIds = null, postSource = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays);
  return rpc("dashboard_estrategia_sentiments_by_brand", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}
