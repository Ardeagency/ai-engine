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
import { createOrgClient } from "../lib/org-jwt.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resuelve {dateFrom, dateTo}. Por defecto, los últimos `windowDays` hasta hoy.
 *
 * `desde`/`hasta` permiten un rango EXPLÍCITO, que es lo que necesita el filtro
 * personalizado del dashboard: windowDays siempre termina en `now`, así que un
 * tramo histórico ("del 3 de marzo al 2 de abril") era inexpresable y Vera no
 * tenía forma de analizarlo aunque las RPCs sí aceptan p_date_from/p_date_to.
 */
function resolveWindow(windowDays = 30, desde = null, hasta = null) {
  const to = hasta ? new Date(hasta) : new Date();
  const from = desde
    ? new Date(desde)
    : new Date(to.getTime() - Math.max(1, Number(windowDays)) * 86400_000);
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() };
}

function toUuidArray(maybe) {
  if (maybe == null) return null;
  if (Array.isArray(maybe)) return maybe.length ? maybe : null;
  if (typeof maybe === "string") return [maybe];
  return null;
}

// AISLAMIENTO MULTI-TENANT (JC 2026-07-16): Vera no consulta Supabase directo;
// ai-engine es el puente y ejecuta CON EL SOMBRERO de la org dueña del dato
// (JWT organization_id vía createOrgClient / org-jwt.js) para que is_org_member de
// cada RPC pase SOLO para su propia data. La Vera de WAKEUP solo ve WAKEUP; si
// pidiera otra org, el RPC responde forbidden. Muchas Veras concurrentes no se
// confunden: cada llamada lleva su propio JWT efímero.
const _bcOrgCache = new Map(); // brand_container_id → organization_id
async function _resolveOrg(args) {
  if (args?.p_org_id) return args.p_org_id;
  const bc = args?.p_brand_container_id;
  if (!bc) return null;
  if (_bcOrgCache.has(bc)) return _bcOrgCache.get(bc);
  const { data } = await supabase
    .from("brand_containers").select("organization_id").eq("id", bc).maybeSingle();
  const org = data?.organization_id || null;
  if (org) _bcOrgCache.set(bc, org);
  return org;
}

async function rpc(name, args, orgId) {
  // orgId = el org VERIFICADO del secCtx (dispatchTool lo inyecta desde el
  // X-Org-Token). SIEMPRE prioritario: el sombrero es la identidad de la Vera
  // solicitante, NUNCA el org del brand_container que venga en los params
  // (eso permitiría cross-org si Vera pasara un brand ajeno). Fix JC 2026-07-16.
  const org = orgId || await _resolveOrg(args);
  // Con org → cliente con el sombrero de esa org (JWT org-scoped, helper canónico
  // org-jwt.js); sin org → service_role (fallback). Consolidado 2026-07-16:
  // antes había un segundo helper (org-scoped-supabase.js) duplicando esto.
  const client = org ? await createOrgClient(org) : supabase;
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
// MI MARCA
// ════════════════════════════════════════════════════════════════════════════

export async function getBrandKpisStrip({
  organizationId,
  windowDays = 30, desde = null, hasta = null,
  brandContainerIds = null,
  postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_kpis_strip", {
    p_org_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds),
    p_post_source: postSource,
  });
}

/**
 * getPlatformHealth — salud POR red social de la marca (Instagram/Facebook/X/
 * TikTok/YouTube). Combina estado de la integración (conectada/needs_reauth/
 * stale), actividad (volumen + días sin publicar), performance real
 * (engagement_rate + reach de las integraciones, NO Apify) y sentimiento de los
 * comentarios. Devuelve score 0-100 + label + señales accionables por red.
 * Vera la usa para "¿cómo está mi presencia en cada red?", "¿qué red está
 * abandonada?", "¿dónde tengo mejor/peor engagement?".
 */
export async function getPlatformHealth({
  organizationId,
  windowDays = 30, desde = null, hasta = null,
  brandContainerIds = null,
  platforms = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_mimarca_platform_health", {
    p_org_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds),
    p_platforms: toUuidArray(platforms), // reutiliza el helper: string|array→array|null
  });
}

export async function getBrandActivityHistory({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_activity_history", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getBrandEngagementTrend({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_engagement_trend", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getBrandPostingHours({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own", timezone = "America/Bogota",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_posting_hours", {
    p_org_id: organizationId, p_brand_container_ids: toUuidArray(brandContainerIds),
    p_date_from: dateFrom, p_date_to: dateTo, p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedProfile({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_profile", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedProfileDetails({
  organizationId, brandContainerId, windowDays = null, desde = null, hasta = null, postSource = "own", timezone = "America/Bogota",
}) {
  const win = windowDays != null ? resolveWindow(windowDays, desde, hasta) : { dateFrom: null, dateTo: null };
  return rpc("dashboard_brand_featured_profile_details", {
    p_org_id: organizationId, p_brand_container_id: brandContainerId,
    p_date_from: win.dateFrom, p_date_to: win.dateTo, p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedTopic({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_topic", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedHashtag({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_hashtag", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedHour({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own", timezone = "America/Bogota",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_hour", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource, p_timezone: timezone,
  });
}

export async function getFeaturedPlatform({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_platform", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getFeaturedGrowth({
  organizationId, windowDays = 60, desde = null, hasta = null, brandContainerIds = null, postSource = "own",
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_featured_growth", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

export async function getAlertScore({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, limit = 5,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_brand_alert_score", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getTopHighlightedPosts({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = "own", limit = 10,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
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
  organizationId, windowDays = 30, desde = null, hasta = null, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_competencia_kpis", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds),
  });
}

export async function getCompetenciaTop({
  organizationId, windowDays = 30, desde = null, hasta = null, entityIds = null, limit = 10,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_competencia_top", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getCompetenciaFeatured({
  organizationId, windowDays = 30, desde = null, hasta = null, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_competencia_featured", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds),
  });
}

export async function getCompetenciaTopPosts({
  organizationId, windowDays = 30, desde = null, hasta = null, entityIds = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_competencia_top_posts", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getCompetenciaActorDetails({
  organizationId, entityId, windowDays = null, desde = null, hasta = null, timezone = "America/Bogota",
}) {
  const win = windowDays != null ? resolveWindow(windowDays, desde, hasta) : { dateFrom: null, dateTo: null };
  return rpc("dashboard_competencia_actor_details", {
    p_org_id: organizationId, p_entity_id: entityId,
    p_date_from: win.dateFrom, p_date_to: win.dateTo, p_timezone: timezone,
  });
}

export async function getCompetenciaRisk({
  organizationId, windowDays = 30, desde = null, hasta = null, entityIds = null, limit = 5,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_competencia_risk", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_entity_ids: toUuidArray(entityIds), p_limit: Math.max(1, Number(limit)),
  });
}

export async function getBrandVsCompetencia({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, entityIds = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
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

export async function getEstrategiaHashtags({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = null, limit = 20,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_estrategia_hashtags", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
    p_limit: Math.max(1, Number(limit)),
  });
}

export async function getEstrategiaPlatforms({
  organizationId, windowDays = 30, desde = null, hasta = null, brandContainerIds = null, postSource = null,
}) {
  const { dateFrom, dateTo } = resolveWindow(windowDays, desde, hasta);
  return rpc("dashboard_estrategia_platform_comparison", {
    p_org_id: organizationId, p_date_from: dateFrom, p_date_to: dateTo,
    p_brand_container_ids: toUuidArray(brandContainerIds), p_post_source: postSource,
  });
}

// ── INTELIGENCIA DE CAMPAÑAS PAGAS (JC 2026-07-16) ──────────────────────────
// No la lista de campañas: el ANÁLISIS. Mejor ROAS/CTR, anuncio más eficiente,
// estructura por objetivo, demografía que convierte. Primer ejemplo del patrón
// "RPC de inteligencia" — datos que Vera puede razonar, no números crudos.
export async function getPaidIntelligence({ brandContainerId, organizationId }) {
  return rpc("dashboard_paid_intelligence", { p_brand_container_id: brandContainerId }, organizationId);
}

// ── INTELIGENCIA DE CONTENIDO ORGÁNICO (JC 2026-07-16) ──────────────────────
// Métricas reales de cada post + contenido crudo + ratios (retención, save_rate,
// share_rate, follow_rate). NO clasifica — Vera razona el porqué. p_competitor
// para analizar el contenido del rival (aprender su patrón).
export async function getContentIntelligence({ brandContainerId, organizationId, source = "own", limit = 12 }) {
  return rpc("dashboard_content_intelligence", {
    p_brand_container_id: brandContainerId, p_source: source, p_limit: limit,
  }, organizationId);
}

// ── PROXIMAS FECHAS / SINCRONIA CON EL MUNDO REAL (JC 2026-07-22) ───────────
// Festivos del mercado objetivo (lib `holidays`, offline) + eventos internacionales
// (mundiales, dias mundiales, Black Friday...) que pobla `world_calendar.py` en
// `real_world_signals`. Es la MISMA fuente que la card "Proximas Fechas" del
// dashboard Tendencias — una sola verdad, no un segundo calendario.
// Vera la usa para anclar contenido/campanas a un momento real del calendario en
// vez de inventar efemerides. Devuelve forma limpia (el RPC trae raw_data crudo).
export async function getUpcomingDates({ organizationId, lookaheadDays = 90, limit = 12 }) {
  const days = Math.min(365, Math.max(1, Number(lookaheadDays) || 90));
  const lim = Math.min(30, Math.max(1, Number(limit) || 12));
  const raw = await rpc("dashboard_tendencias_real_world", {
    p_org_id: organizationId,
    p_lookahead_days: days,
    p_limit_holidays: lim,
    p_limit_history: 0,
  }, organizationId);

  const list = Array.isArray(raw?.upcoming_holidays) ? raw.upcoming_holidays : [];
  const dates = list.map((h) => {
    const rd = h?.raw_data || {};
    return {
      date: h?.event_date || null,
      days_until: Number(h?.days_until),
      name: h?.event_name || "",
      // holiday = festivo del pais; cultural_moment = evento internacional/cultural
      kind: h?.signal_type === "holiday" ? "festivo" : "evento",
      scope: String(rd.scope || "") === "international" ? "internacional" : "nacional",
      geo: h?.geo || null,
      // verdict/reason los emite el collector: conveniencia de la fecha PARA ESTA marca
      verdict: rd.verdict || null,
      reason: h?.event_description || rd.reason || null,
    };
  }).filter((d) => d.date && Number.isFinite(d.days_until));

  return {
    today: raw?.today || null,
    horizon_days: days,
    count: dates.length,
    dates,
  };
}

