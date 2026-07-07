/**
 * Social Media Analytics Tools — análisis real via APIs externas.
 *
 * DISPONIBLES en nivel "parcial" (fase B) y "total" (fase C).
 * Los tokens se obtienen internamente — OpenClaw NUNCA los ve.
 *
 * Herramientas:
 *   getMetaPageInsights   — métricas de la página de Facebook (alcance, fans, engagement)
 *   getMetaPosts          — posts recientes con likes, comentarios, shares e impresiones
 *   getInstagramInsights  — métricas de la cuenta de Instagram Business
 *   getInstagramPosts     — posts de Instagram con engagement real
 *   getGoogleAnalytics    — sesiones, usuarios, páginas vistas, fuentes de tráfico (GA4)
 *   getSocialSummary      — resumen cross-platform de todas las integraciones activas
 */
import { getIntegrationToken } from "../lib/integration-token.js";

const META_GRAPH_BASE = `https://graph.facebook.com/v22.0`;
const GA4_DATA_BASE   = `https://analyticsdata.googleapis.com/v1beta`;
const GA4_ADMIN_BASE  = `https://analyticsadmin.googleapis.com/v1beta`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extrae hashtags del texto del post (deterministico, sin LLM). Formato consistente
// con los de competidores (Apify): SIN el '#', case original, dedupe case-insensitive.
// Lookbehind negativo para no cazar fragmentos de URL / entidades HTML / mid-word.
// Alimenta dashboard_estrategia_hashtags para posts propios (DATA-002).
function extractHashtags(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/(?<![\p{L}\p{N}_/&])#[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  const out = [], seen = new Set();
  for (const m of matches) {
    const tag = m.slice(1), key = tag.toLowerCase();
    if (tag && !seen.has(key)) { seen.add(key); out.push(tag); }
  }
  return out;
}

// Códigos de rate-limit de Meta (Graph API). Cuando aparecen, NO reintentar a
// ciegas: hay que esperar `estimated_time_to_regain_access` minutos. Ver docs:
// developers.facebook.com/docs/graph-api/overview/rate-limiting/
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80006, 80014]);
// % de uso (call_count / total_time / total_cputime) a partir del cual pausamos
// proactivamente para no llegar al 100% (= bloqueo temporal).
const META_USAGE_CEILING = Number(process.env.META_USAGE_CEILING || 80);

// Parsea los headers de telemetría de Meta y devuelve el peor caso:
//   pct       → mayor % de uso reportado (call_count|total_time|total_cputime)
//   regainMin → minutos a esperar si ya estamos throttleados (0 = aún hay margen)
function _parseMetaUsage(headers) {
  let pct = 0, regainMin = 0;
  const consume = (raw) => {
    if (!raw) return;
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    // x-business-use-case-usage: { "<biz_id>": [ {type, call_count, total_time, ...} ] }
    // x-app-usage / x-page-usage: { call_count, total_time, total_cputime }
    const buckets = Array.isArray(obj) ? obj
      : (obj.call_count != null ? [obj] : Object.values(obj).flat());
    for (const b of buckets) {
      if (!b) continue;
      pct = Math.max(pct, b.call_count || 0, b.total_time || 0, b.total_cputime || 0);
      regainMin = Math.max(regainMin, b.estimated_time_to_regain_access || 0);
    }
  };
  consume(headers.get("x-business-use-case-usage"));
  consume(headers.get("x-app-usage"));
  consume(headers.get("x-page-usage"));
  return { pct, regainMin };
}

// metaGetRaw — como metaGet pero además devuelve la telemetría de uso y el bloque
// `paging` para poder paginar de forma sana (header-aware).
async function metaGetRaw(path, token, params = {}) {
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", token);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v));
  });
  const res  = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  const usage = _parseMetaUsage(res.headers);
  if (json?.error) {
    const err = new Error(`Meta API: ${json.error.message || json.error.type}`);
    err.code = json.error.code;
    err.isRateLimit = META_RATE_LIMIT_CODES.has(json.error.code);
    err.usage = usage;
    throw err;
  }
  return { json, usage, paging: json?.paging || null };
}

async function metaGet(path, token, params = {}) {
  const { json } = await metaGetRaw(path, token, params);
  return json;
}

async function gaPost(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.error) {
    throw new Error(`Google Analytics API: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json;
}

async function gaGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (json?.error) {
    throw new Error(`Google Analytics Admin API: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json;
}

/**
 * Obtiene el token de página de Facebook (más permisos que el user token).
 * Usa /me/accounts para encontrar la página activa en metadata.
 */
async function _getMetaPageToken(userToken, selectedPageId, metadata) {
  const activePageId = selectedPageId || metadata?.selected_page_id || metadata?.pages?.[0]?.id;

  const accounts = await metaGet("/me/accounts", userToken, {
    fields: "id,name,access_token",
    limit: 50,
  });

  const pages = accounts?.data || [];
  if (!pages.length) throw new Error("No hay páginas de Facebook conectadas a esta cuenta.");

  const page = activePageId
    ? pages.find((p) => p.id === String(activePageId))
    : pages[0];

  if (!page) throw new Error(`Página ${activePageId} no encontrada. Páginas disponibles: ${pages.map((p) => p.name).join(", ")}`);

  return { pageId: page.id, pageName: page.name, pageToken: page.access_token };
}

/**
 * Parsea rango de fechas: "7d" | "30d" | "90d" | "YYYY-MM-DD/YYYY-MM-DD"
 */
function _parseDateRange(range = "30d") {
  const now = new Date();
  if (range.endsWith("d")) {
    const days = parseInt(range) || 30;
    const start = new Date(now);
    start.setDate(start.getDate() - days);
    return {
      since: Math.floor(start.getTime() / 1000),
      until: Math.floor(now.getTime() / 1000),
      startDate: start.toISOString().split("T")[0],
      endDate: now.toISOString().split("T")[0],
    };
  }
  // YYYY-MM-DD/YYYY-MM-DD
  const [start, end] = range.split("/");
  return {
    since: Math.floor(new Date(start).getTime() / 1000),
    until: Math.floor(new Date(end || now).getTime() / 1000),
    startDate: start,
    endDate: end || now.toISOString().split("T")[0],
  };
}

// ── Herramientas ──────────────────────────────────────────────────────────────

/**
 * getMetaPageInsights — métricas de la página de Facebook.
 *
 * Usa únicamente métricas válidas en Meta Graph API v22+.
 * fan_count y followers_count se leen del objeto página (no de insights)
 * porque las métricas de fans fueron deprecadas en v17-v22.
 */
export async function getMetaPageInsights({ brandContainerId = null, organizationId, range = "30d" }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageName, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  const { since, until } = _parseDateRange(range);

  // Métricas válidas en v22.0 con period=day (se suman manualmente en el período)
  // Ref: https://developers.facebook.com/docs/graph-api/reference/v22.0/insights
  const SAFE_METRICS = [
    "page_views_total",       // visitas al perfil de la página
    "page_post_engagements",  // interacciones totales con posts (reacciones, comments, shares)
    "page_daily_follows",     // nuevos seguidores en el período
    "page_daily_unfollows_unique", // unfollows en el período
    "page_total_actions",     // clicks en CTA (botón de contacto, website, etc.)
  ];

  // Obtener info de la página y métricas en paralelo
  const [pageInfo, ...insightResults] = await Promise.all([
    metaGet(`/${pageId}`, pageToken, {
      fields: "id,name,fan_count,followers_count,category,talking_about_count",
    }),
    // Pedir cada métrica individualmente para que un fallo no bloquee las demás
    ...SAFE_METRICS.map((metric) =>
      metaGet(`/${pageId}/insights`, pageToken, {
        metric,
        period: "day",
        since,
        until,
      }).catch(() => null)
    ),
  ]);

  // Agregar valores diarios por métrica
  const metricsMap = {};
  SAFE_METRICS.forEach((metric, idx) => {
    const result = insightResults[idx];
    metricsMap[metric] = (result?.data || []).reduce(
      (sum, item) => sum + ((item.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0)),
      0
    );
  });

  const fans       = pageInfo.fan_count || 0;
  const followers  = pageInfo.followers_count || 0;
  const engagements = metricsMap.page_post_engagements || 0;
  const engagementRate = fans > 0 ? ((engagements / fans) * 100).toFixed(2) : "0.00";

  return {
    platform: "facebook",
    page: {
      id: pageInfo.id,
      name: pageName,
      category: pageInfo.category || null,
      total_fans: fans,
      total_followers: followers,
      talking_about_count: pageInfo.talking_about_count || 0,
    },
    period: {
      range,
      since: new Date(since * 1000).toISOString().split("T")[0],
      until: new Date(until * 1000).toISOString().split("T")[0],
    },
    metrics: {
      page_views:        metricsMap.page_views_total || 0,
      post_engagements:  engagements,
      new_followers:     metricsMap.page_daily_follows || 0,
      unfollows:         metricsMap.page_daily_unfollows_unique || 0,
      cta_clicks:        metricsMap.page_total_actions || 0,
      engagement_rate:   `${engagementRate}%`,
    },
  };
}

/**
 * getMetaPosts — publicaciones recientes de Facebook con métricas de rendimiento.
 */
export async function getMetaPosts({ brandContainerId = null, organizationId, limit = 10 }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageName, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  // post_impressions fue deprecado en Meta v22 (nov 2025). Usamos campos básicos
  // y añadimos insights con fallback — si falla, devolvemos likes/comments/shares.
  const data = await metaGet(`/${pageId}/posts`, pageToken, {
    fields: "id,message,story,created_time,full_picture,permalink_url," +
            "likes.summary(true),comments.summary(true),shares",
    limit: Math.min(limit, 25),
  });

  const posts = (data?.data || []).map((p) => {
    const likes    = p.likes?.summary?.total_count || 0;
    const comments = p.comments?.summary?.total_count || 0;
    const shares   = p.shares?.count || 0;
    const interactions = likes + comments + shares;
    return {
      id: p.id,
      platform: "facebook",
      text: (p.message || p.story || "").slice(0, 300),
      created_at: p.created_time,
      permalink: p.permalink_url,
      image: p.full_picture || null,
      metrics: {
        likes,
        comments,
        shares,
        total_interactions: interactions,
      },
    };
  });

  return { platform: "facebook", page: pageName, post_count: posts.length, posts };
}

/**
 * getInstagramInsights — métricas de la cuenta de Instagram Business.
 *
 * Estrategia de métricas para v22+:
 *   - Se evita "views" (marcada "in development", inestable en algunos accounts)
 *   - Se usa "reach" con time_series para sumar el período manualmente (más compatible)
 *   - Se usa "total_interactions", "accounts_engaged", "follows_and_unfollows"
 *     con metric_type=total_value (más eficiente para totales)
 *   - Cada llamada tiene .catch(() => null) para que un fallo no rompa todo
 */
export async function getInstagramInsights({ brandContainerId = null, organizationId, range = "30d" }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  // Obtener IG Business Account vinculada a la página de Facebook.
  // profile_picture_url se omite — URL CDN firmada que expira y da 403 en el browser.
  const fbPage = await metaGet(`/${pageId}`, pageToken, {
    fields: "instagram_business_account{id,username,followers_count,media_count}",
  });

  const igAccount = fbPage?.instagram_business_account;
  if (!igAccount?.id) {
    throw new Error(
      "No hay cuenta de Instagram Business vinculada a esta página de Facebook. " +
      "El usuario debe conectar Instagram en la configuración de Facebook."
    );
  }

  const { since, until } = _parseDateRange(range);
  const days = Math.max(1, parseInt(range) || 30);

  // Métricas ESTABLES en v22+ con metric_type=total_value (sin breakdown para máx. compatibilidad)
  // "views" es "in development" y puede fallar en algunos accounts → se omite
  const TOTAL_VALUE_METRICS = [
    "reach",              // cuentas únicas que vieron contenido
    "total_interactions", // suma de likes + comments + shares + saves
    "accounts_engaged",   // cuentas que interactuaron
    "follows_and_unfollows", // followers ganados/perdidos
  ];

  const [igAccountInfo, ...insightResults] = await Promise.all([
    metaGet(`/${igAccount.id}`, pageToken, {
      fields: "followers_count,media_count",
    }).catch(() => ({})),
    ...TOTAL_VALUE_METRICS.map((metric) =>
      metaGet(`/${igAccount.id}/insights`, pageToken, {
        metric,
        metric_type: "total_value",
        period: "day",
        since,
        until,
      }).catch((err) => {
        console.warn(`[ig-insights] ${metric} falló:`, err?.message || err);
        return null;
      })
    ),
  ]);

  // Extraer totals de cada métrica
  const totals = {};
  TOTAL_VALUE_METRICS.forEach((metric, idx) => {
    const result = insightResults[idx];
    // Formato total_value: data[0].total_value.value
    // Formato time_series fallback: data[].values[].value (suma manual)
    const metricData = result?.data?.[0];
    if (metricData?.total_value?.value !== undefined) {
      totals[metric] = Number(metricData.total_value.value) || 0;
    } else if (metricData?.values) {
      totals[metric] = (metricData.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
    } else {
      totals[metric] = 0;
    }
  });

  // follows_and_unfollows devuelve un objeto {FOLLOW: N, UNFOLLOW: N} en algunas versiones
  // Si el total_value.value existe, lo usamos directamente; los breakdowns son opcionales
  const followers = igAccountInfo.followers_count || igAccount.followers_count || 0;
  const reach     = totals.reach || 0;

  return {
    platform: "instagram",
    account: {
      id: igAccount.id,
      username: `@${igAccount.username}`,
      followers,
      media_count: igAccountInfo.media_count || igAccount.media_count || 0,
    },
    period: {
      range,
      since: new Date(since * 1000).toISOString().split("T")[0],
      until: new Date(until * 1000).toISOString().split("T")[0],
    },
    metrics: {
      reach,
      total_interactions: totals.total_interactions || 0,
      accounts_engaged:   totals.accounts_engaged || 0,
      follows_and_unfollows_net: totals.follows_and_unfollows || 0,
      avg_daily_reach:    reach > 0 ? Math.round(reach / days) : 0,
    },
  };
}

/**
 * getInstagramPosts — posts recientes de Instagram con métricas de engagement.
 */
export async function getInstagramPosts({ brandContainerId = null, organizationId, limit = 12 }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  const fbPage = await metaGet(`/${pageId}`, pageToken, {
    fields: "instagram_business_account{id,username}",
  });

  const igId = fbPage?.instagram_business_account?.id;
  if (!igId) throw new Error("No hay cuenta de Instagram Business vinculada.");

  // like_count y comments_count son campos básicos disponibles con instagram_basic.
  // Si la cuenta ocultó los likes, like_count devuelve 0 (no lanza error).
  const data = await metaGet(`/${igId}/media`, pageToken, {
    fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count",
    limit: Math.min(limit, 30),
  }).catch((err) => {
    console.warn("[ig-posts] Error al obtener media:", err?.message || err);
    return { data: [] };
  });

  const posts = (data?.data || []).map((m) => {
    const likes    = m.like_count || 0;
    const comments = m.comments_count || 0;
    const total    = likes + comments;
    return {
      id: m.id,
      platform: "instagram",
      caption: (m.caption || "").slice(0, 300),
      media_type: (m.media_type || "IMAGE").toLowerCase(),
      // Solo permalink público — las URLs de CDN de Meta expiran y dan 403
      permalink: m.permalink,
      created_at: m.timestamp,
      metrics: {
        likes,
        comments,
        total_interactions: total,
      },
    };
  });

  return {
    platform: "instagram",
    account: `@${fbPage.instagram_business_account?.username}`,
    post_count: posts.length,
    posts,
  };
}

/**
 * fetchOwnPostsPage — ingesta SANA y paginada de publicaciones propias (IG/FB).
 *
 * Diseñada para backfill histórico sin romper los rate limits de Meta:
 *   - Paginación con cursor (`after`), página de `pageSize` (≤50 recomendado).
 *   - Solo campos baratos (NO insights por-post → eso dispara total_time al 100%).
 *   - Lee el header X-Business-Use-Case-Usage en cada llamada y PAUSA al llegar
 *     a `usageCeiling` % (default 80) o si Meta ya nos throttleó.
 *   - `stopBeforeTs`: corta cuando un post es más viejo que la ventana del plan.
 *   - `maxPages`: presupuesto de páginas por ciclo (la cola lo reanuda después).
 *
 * Devuelve { posts, nextAfter, reachedCutoff, reachedEnd, pausedForUsage, usage, pages, oldest }
 * con posts ya normalizados al shape que consume persistOwnPosts.
 */
export async function fetchOwnPostsPage({
  brandContainerId = null, organizationId, network,
  after = null, pageSize = 50, maxPages = 3,
  stopBeforeTs = null, usageCeiling = META_USAGE_CEILING,
}) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageName, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  // Resolver edge + campos + normalizador según red.
  let edge, fields, normalize, accountLabel = pageName;
  if (network === "instagram") {
    const fbPage = await metaGet(`/${pageId}`, pageToken, {
      fields: "instagram_business_account{id,username}",
    });
    const igId = fbPage?.instagram_business_account?.id;
    if (!igId) {
      const e = new Error("No hay cuenta de Instagram Business vinculada a esta página.");
      e.noIgLinked = true;
      throw e;
    }
    accountLabel = `@${fbPage.instagram_business_account?.username}`;
    edge   = `/${igId}/media`;
    fields = "id,caption,media_type,permalink,timestamp,like_count,comments_count";
    normalize = (m) => {
      const likes = m.like_count || 0, comments = m.comments_count || 0;
      return {
        id: m.id, platform: "instagram",
        text: (m.caption || "").slice(0, 2000),
        hashtags: extractHashtags(m.caption || ""),
        created_at: m.timestamp, permalink: m.permalink, image: null,
        media_type: (m.media_type || "IMAGE").toLowerCase(),
        metrics: { likes, comments, shares: 0, total_interactions: likes + comments },
      };
    };
  } else { // facebook
    edge   = `/${pageId}/posts`;
    fields = "id,message,story,created_time,full_picture,permalink_url," +
             "likes.summary(true),comments.summary(true),shares";
    normalize = (p) => {
      const likes    = p.likes?.summary?.total_count || 0;
      const comments = p.comments?.summary?.total_count || 0;
      const shares   = p.shares?.count || 0;
      return {
        id: p.id, platform: "facebook",
        text: (p.message || p.story || "").slice(0, 2000),
        hashtags: extractHashtags(p.message || p.story || ""),
        created_at: p.created_time, permalink: p.permalink_url, image: p.full_picture || null,
        metrics: { likes, comments, shares, total_interactions: likes + comments + shares },
      };
    };
  }

  const posts = [];
  let cursor = after, pages = 0;
  let reachedCutoff = false, reachedEnd = false, pausedForUsage = false;
  let usage = { pct: 0, regainMin: 0 }, oldest = null;
  const cutoffMs = stopBeforeTs ? new Date(stopBeforeTs).getTime() : null;

  for (; pages < maxPages; ) {
    let resp;
    try {
      resp = await metaGetRaw(edge, pageToken, {
        fields, limit: Math.min(pageSize, 100), after: cursor || undefined,
      });
    } catch (e) {
      // Throttle de Meta → no es fallo del backfill: pausamos y reanudamos luego.
      if (e.isRateLimit) { pausedForUsage = true; usage = e.usage || usage; break; }
      throw e;
    }
    pages++;
    usage = resp.usage || usage;
    const items = resp.json?.data || [];

    for (const it of items) {
      const post = normalize(it);
      const ts = post.created_at ? new Date(post.created_at).getTime() : null;
      if (cutoffMs && ts != null && ts < cutoffMs) { reachedCutoff = true; break; }
      posts.push(post);
      if (ts != null && (oldest == null || ts < oldest)) oldest = ts;
    }

    cursor = resp.paging?.cursors?.after || null;
    const hasNext = Boolean(resp.paging?.next && cursor);
    if (reachedCutoff || !hasNext) { reachedEnd = !hasNext && !reachedCutoff; break; }

    // Guardia de uso: si nos acercamos al límite, paramos y dejamos que la cola
    // reanude en el próximo ciclo (la ventana de Meta es móvil de 1h).
    if (usage.pct >= usageCeiling || usage.regainMin > 0) { pausedForUsage = true; break; }
  }

  return {
    network, account: accountLabel,
    posts, nextAfter: cursor,
    reachedCutoff, reachedEnd, pausedForUsage,
    usage, pages,
    oldest: oldest ? new Date(oldest).toISOString() : null,
  };
}

/**
 * getGoogleAnalytics — métricas de GA4: tráfico, usuarios, fuentes, páginas top.
 */
export async function getGoogleAnalytics({ brandContainerId = null, organizationId, range = "30d", propertyId }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "google");

  // Seleccionar propiedad GA4
  let propId = propertyId || integ.metadata?.ga4_property_id;
  if (!propId) {
    const accountSummaries = await gaGet(`${GA4_ADMIN_BASE}/accountSummaries`, integ.access_token);
    const properties = [];
    for (const acc of accountSummaries?.accountSummaries || []) {
      for (const ps of acc.propertySummaries || []) {
        const m = (ps.property || "").match(/properties\/(\d+)/);
        if (m) properties.push({ id: m[1], name: ps.displayName });
      }
    }
    if (!properties.length) throw new Error("No hay propiedades GA4 en esta cuenta de Google.");
    propId = properties[0].id;
  }

  const { startDate, endDate } = _parseDateRange(range);

  // Reporte principal: métricas clave
  const [overviewReport, sourcesReport, pagesReport] = await Promise.all([
    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "newUsers" },
        { name: "screenPageViews" },
        { name: "bounceRate" },
        { name: "averageSessionDuration" },
        { name: "conversions" },
      ],
    }),

    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "conversions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    }),

    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }, { name: "averageSessionDuration" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    }),
  ]);

  // Parsear overview
  const metrics = {};
  const metricNames = overviewReport?.metricHeaders?.map((h) => h.name) || [];
  const row = overviewReport?.rows?.[0]?.metricValues || [];
  metricNames.forEach((name, i) => {
    metrics[name] = row[i]?.value ?? "0";
  });

  // Parsear fuentes de tráfico
  const sources = (sourcesReport?.rows || []).map((r) => ({
    channel:     r.dimensionValues?.[0]?.value || "Desconocido",
    sessions:    Number(r.metricValues?.[0]?.value || 0),
    users:       Number(r.metricValues?.[1]?.value || 0),
    conversions: Number(r.metricValues?.[2]?.value || 0),
  }));

  // Parsear páginas top
  const topPages = (pagesReport?.rows || []).map((r) => ({
    path:       r.dimensionValues?.[0]?.value || "/",
    title:      r.dimensionValues?.[1]?.value || "",
    page_views: Number(r.metricValues?.[0]?.value || 0),
    users:      Number(r.metricValues?.[1]?.value || 0),
    avg_time_s: Math.round(Number(r.metricValues?.[2]?.value || 0)),
  }));

  const durationSecs = Number(metrics.averageSessionDuration || 0);
  const durationMin  = `${Math.floor(durationSecs / 60)}m ${Math.round(durationSecs % 60)}s`;

  return {
    platform:  "google_analytics",
    property:  { id: propId },
    period:    { range, start_date: startDate, end_date: endDate },
    overview: {
      sessions:              Number(metrics.sessions || 0),
      total_users:           Number(metrics.totalUsers || 0),
      new_users:             Number(metrics.newUsers || 0),
      page_views:            Number(metrics.screenPageViews || 0),
      bounce_rate:           `${(Number(metrics.bounceRate || 0) * 100).toFixed(1)}%`,
      avg_session_duration:  durationMin,
      conversions:           Number(metrics.conversions || 0),
    },
    traffic_sources: sources,
    top_pages:       topPages,
  };
}

/**
 * getSocialSummary — resumen ejecutivo de todas las integraciones activas.
 * Ideal para el análisis inicial antes de profundizar en cada plataforma.
 */
export async function getSocialSummary({ brandContainerId = null, organizationId }) {
  const { supabase } = await import("../lib/supabase.js");

  let query = supabase
    .from("brand_integrations")
    .select("id, platform, external_account_name, is_active, last_sync_at, scope, metadata, brand_container_id, brand_containers!inner(organization_id)")
    .eq("is_active", true)
    .eq("brand_containers.organization_id", organizationId);

  if (brandContainerId) {
    query = query.eq("brand_container_id", brandContainerId);
  }

  const { data: integrations } = await query;

  if (!integrations?.length) {
    return {
      connected_platforms: [],
      message: "No hay integraciones activas. El usuario debe conectar sus cuentas en la configuración de la marca.",
    };
  }

  const summary = {
    connected_platforms: integrations.map((i) => ({
      platform:      i.platform,
      account:       i.external_account_name || "Sin nombre",
      last_sync:     i.last_sync_at,
      scopes:        i.scope || [],
      has_page_data: !!i.metadata?.selected_page_id || !!i.metadata?.pages?.length,
    })),
    instructions: "Usa getMetaPageInsights, getInstagramInsights o getGoogleAnalytics para obtener métricas detalladas de cada plataforma conectada.",
  };

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT INSIGHTS — read-only para Vera, lee tablas ya pobladas por scrapers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getBrandContent — resumen ejecutivo del estado del contenido de la marca.
 *
 * Lee TODO desde tablas que el scraper y los analyzers ya populan diariamente:
 *   • brand_narrative_pillars  → top pilares por engagement
 *   • brand_content_analysis   → distribución de tonos y emociones
 *   • brand_audience_heatmap   → mejor hora/día por red
 *   • brand_posts.sentiment    → sentiment promedio + breakdown
 *   • audience_personas        → resumen de alignment vs público real
 *   • vera_pending_actions     → recomendaciones pendientes
 *
 * No llama APIs externas, no consume tokens. Vera la usa cuando el usuario
 * pregunta "¿cómo me va con el contenido?", "¿cuál es mi mejor pillar?",
 * "¿cuándo conviene publicar?", etc.
 */
export async function getBrandContent({ brandContainerId = null, organizationId, daysWindow = 90 }) {
  const { supabase } = await import("../lib/supabase.js");

  // Resolver brand_container_ids
  let brandIds = brandContainerId ? [brandContainerId] : [];
  if (!brandIds.length) {
    const { data: bcs } = await supabase
      .from("brand_containers")
      .select("id, nombre_marca")
      .eq("organization_id", organizationId);
    brandIds = (bcs || []).map((b) => b.id);
  }
  if (!brandIds.length) {
    return { message: "Esta organización no tiene marcas configuradas." };
  }

  // 1) brand_narrative_pillars — top por engagement
  const { data: pillars } = await supabase
    .from("brand_narrative_pillars")
    .select("brand_container_id, pillar_name, post_count, avg_engagement, avg_reach, last_post_at")
    .in("brand_container_id", brandIds)
    .order("avg_engagement", { ascending: false })
    .limit(15);

  // 2) brand_content_analysis — agregar distribuciones de tono y emoción
  const { data: analyses } = await supabase
    .from("brand_content_analysis")
    .select("tone_detected, dominant_emotion, narrative_pillar, fatigue_risk, clarity_score")
    .in("brand_container_id", brandIds);

  const toneDist  = {};
  const emoDist   = {};
  let totalAnalyses = 0, totalFatigueRisk = 0, totalClarity = 0;
  for (const a of analyses || []) {
    totalAnalyses++;
    if (a.tone_detected)    toneDist[a.tone_detected]     = (toneDist[a.tone_detected]     || 0) + 1;
    if (a.dominant_emotion) emoDist[a.dominant_emotion]   = (emoDist[a.dominant_emotion]   || 0) + 1;
    if (a.fatigue_risk) totalFatigueRisk++;
    if (typeof a.clarity_score === "number") totalClarity += a.clarity_score;
  }
  const topTones    = Object.entries(toneDist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ tone: k, count: v, pct: Math.round((v / totalAnalyses) * 100) }));
  const topEmotions = Object.entries(emoDist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ emotion: k, count: v, pct: Math.round((v / totalAnalyses) * 100) }));
  const avgClarity  = totalAnalyses > 0 ? Number((totalClarity / totalAnalyses).toFixed(2)) : null;
  const fatiguePct  = totalAnalyses > 0 ? Math.round((totalFatigueRisk / totalAnalyses) * 100) : 0;

  // 3) brand_audience_heatmap — mejor momento para publicar
  const { data: heatmap } = await supabase
    .from("brand_audience_heatmap")
    .select("platform, best_hour, best_day, hour_engagement, day_engagement")
    .in("brand_container_id", brandIds);

  const dayNames = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const bestTimes = (heatmap || []).map((h) => ({
    platform:  h.platform,
    best_hour: h.best_hour != null ? `${h.best_hour}:00 UTC` : null,
    best_day:  h.best_day  != null ? dayNames[h.best_day]    : null,
  }));

  // 4) brand_posts.sentiment — promedio sobre los últimos N días
  const cutoff = new Date(Date.now() - daysWindow * 86_400_000).toISOString();
  const { data: posts } = await supabase
    .from("brand_posts")
    .select("sentiment, captured_at, network, is_competitor")
    .in("brand_container_id", brandIds)
    .gte("captured_at", cutoff);

  let ownPos = 0, ownNeg = 0, ownNeutral = 0, ownTotal = 0;
  let compPos = 0, compNeg = 0, compNeutral = 0, compTotal = 0;
  for (const p of posts || []) {
    const s = p.sentiment?.score;
    if (p.is_competitor) {
      compTotal++;
      if (s > 0.1) compPos++;
      else if (s < -0.1) compNeg++;
      else compNeutral++;
    } else {
      ownTotal++;
      if (s > 0.1) ownPos++;
      else if (s < -0.1) ownNeg++;
      else ownNeutral++;
    }
  }

  // 5) audience_personas — resumen alignment
  const { data: personas } = await supabase
    .from("audience_personas")
    .select("id, name, alignment_score, alignment_analyzed_at")
    .in("brand_container_id", brandIds);

  const personasSummary = (personas || []).map((p) => {
    const score = p.alignment_score != null ? Number(p.alignment_score) : null;
    let label = "no-data";
    if (score != null) {
      if (score >= 0.75) label = "high";
      else if (score >= 0.5) label = "medium";
      else label = "low";
    }
    return { name: p.name, alignment_score: score, alignment_label: label };
  });

  // 6) vera_pending_actions — sugerencias activas
  const { data: pendingActions } = await supabase
    .from("vera_pending_actions")
    .select("action_type, target_table, vera_reasoning, vera_confidence, priority, created_at")
    .in("brand_container_id", brandIds)
    .eq("status", "pending")
    .order("priority", { ascending: false });

  // 7) brand_vulnerabilities — threats activos (open)
  const { data: threats } = await supabase
    .from("brand_vulnerabilities")
    .select("title, description, severity, status, metadata, created_at")
    .in("brand_container_id", brandIds)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(15);

  // Resumen final compacto para Vera
  return {
    brand_container_ids: brandIds,
    window_days:         daysWindow,
    summary: {
      total_posts_analyzed: totalAnalyses,
      avg_clarity:          avgClarity,
      fatigue_risk_pct:     fatiguePct,
    },
    top_pillars: (pillars || []).slice(0, 6).map((p) => ({
      pillar:         p.pillar_name,
      posts:          p.post_count,
      avg_engagement: Math.round(p.avg_engagement || 0),
      last_post_at:   p.last_post_at,
    })),
    tone_distribution:    topTones,
    emotion_distribution: topEmotions,
    best_publish_times:   bestTimes,
    sentiment: {
      own:        { total: ownTotal,  positive: ownPos,  negative: ownNeg,  neutral: ownNeutral },
      competitor: { total: compTotal, positive: compPos, negative: compNeg, neutral: compNeutral },
    },
    audience_alignment: personasSummary,
    pending_actions: (pendingActions || []).map((a) => ({
      action_type: a.action_type,
      reasoning:   (a.vera_reasoning || "").slice(0, 200),
      confidence:  a.vera_confidence,
      priority:    a.priority,
    })),
    active_threats: (threats || []).map((t) => ({
      title:       t.title,
      description: t.description,
      severity:    t.severity,
      threat_type: t.metadata?.threat_type || null,
      detected_at: t.created_at,
      ...(t.metadata?.ratio          != null && { engagement_ratio: t.metadata.ratio }),
      ...(t.metadata?.drop_pct       != null && { drop_pct:         t.metadata.drop_pct }),
      ...(t.metadata?.neg_pct        != null && { negative_pct:     t.metadata.neg_pct }),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIENCE TOOLS — read-only para Vera + sync con APIs externas para scraper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getAudienceAlignment — read-only. Vera invoca esta tool cuando el usuario
 * pregunta sobre el match entre su audiencia objetivo y la real, o cuando
 * abre una pending_action de tipo update_persona.
 *
 * NO ejecuta cómputo — solo lee lo que el scraper ya pre-computó. Cero costo.
 */
export async function getAudienceAlignment({ brandContainerId = null, organizationId }) {
  const { supabase } = await import("../lib/supabase.js");

  // Auto-discover brand_container_id si no fue pasado: usar todas las brands de la org
  let brandIds = brandContainerId ? [brandContainerId] : [];
  if (!brandIds.length) {
    const { data: bcs } = await supabase
      .from("brand_containers")
      .select("id")
      .eq("organization_id", organizationId);
    brandIds = (bcs || []).map((b) => b.id);
  }
  if (!brandIds.length) {
    return { personas: [], message: "Esta organización no tiene marcas configuradas." };
  }

  const { data: personas } = await supabase
    .from("audience_personas")
    .select("id, name, description, datos_demograficos, alignment_score, alignment_analyzed_at, top_converting_segment, real_age_distribution, real_gender_distribution, real_location_distribution, brand_container_id")
    .in("brand_container_id", brandIds)
    .eq("organization_id",    organizationId);

  if (!personas?.length) {
    return { brand_container_ids: brandIds, personas: [], message: "Estas marcas no tienen personas conceptuales todavía." };
  }

  const { data: segments } = await supabase
    .from("audience_segments")
    .select("id, platform, external_audience_name, external_audience_type, estimated_size, status, brand_container_id")
    .in("brand_container_id", brandIds)
    .eq("status", "active")
    .limit(50);

  const personaIds = personas.map((p) => p.id);
  const { data: pendingActions } = await supabase
    .from("vera_pending_actions")
    .select("id, target_id, vera_reasoning, vera_confidence, status, priority, created_at")
    .in("brand_container_id", brandIds)
    .eq("action_type",        "update_persona")
    .eq("target_table",       "audience_personas")
    .in("target_id",          personaIds)
    .eq("status",             "pending");

  const _stripMeta = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith("_")));
  const _topEntry = (dist) => {
    const entries = Object.entries(_stripMeta(dist)).sort((a, b) => Number(b[1]) - Number(a[1]));
    return entries[0] || null;
  };

  const summarized = personas.map((p) => {
    const score = p.alignment_score != null ? Number(p.alignment_score) : null;
    let label = "unknown";
    if (score != null) {
      if (score >= 0.75) label = "high";
      else if (score >= 0.5) label = "medium";
      else label = "low";
    }
    const topAge    = _topEntry(p.real_age_distribution);
    const topGender = _topEntry(p.real_gender_distribution);
    const topCountry = _topEntry(p.real_location_distribution?.countries);
    const realSummary = [
      topAge && `edad ${topAge[0]} (${(Number(topAge[1]) * 100).toFixed(0)}%)`,
      topGender && `${topGender[0]} (${(Number(topGender[1]) * 100).toFixed(0)}%)`,
      topCountry && `${topCountry[0]} (${(Number(topCountry[1]) * 100).toFixed(0)}%)`,
    ].filter(Boolean).join(" / ") || "(sin datos reales todavía)";

    const pendingAction = (pendingActions || []).find((a) => a.target_id === p.id);

    return {
      id:                  p.id,
      name:                p.name,
      target_summary:      (p.datos_demograficos || []).join("; ") || p.description || "(sin demografía explícita)",
      alignment_score:     score,
      alignment_label:     label,
      alignment_analyzed_at: p.alignment_analyzed_at,
      real_audience_summary: realSummary,
      top_converting_campaign: p.top_converting_segment && Object.keys(p.top_converting_segment).length
        ? p.top_converting_segment
        : null,
      pending_action: pendingAction ? {
        id:         pendingAction.id,
        reasoning:  pendingAction.vera_reasoning,
        confidence: pendingAction.vera_confidence,
        priority:   pendingAction.priority,
        created_at: pendingAction.created_at,
      } : null,
    };
  });

  return {
    brand_container_ids: brandIds,
    personas:            summarized,
    active_segments: {
      count:     segments?.length || 0,
      platforms: [...new Set((segments || []).map((s) => s.platform))],
      sample:    (segments || []).slice(0, 5).map((s) => ({ name: s.external_audience_name, type: s.external_audience_type, size: s.estimated_size })),
    },
    summary: {
      total_personas:   personas.length,
      with_alignment:   summarized.filter((p) => p.alignment_score != null).length,
      pending_pivots:   summarized.filter((p) => p.pending_action).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// META AD LIBRARY — ads activos/históricos de competidores (público, no requiere
// ser dueño de la cuenta). Endpoint /ads_archive de Graph API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getMetaAdLibrary — pulla ads del competidor desde Meta Ad Library API.
 *
 * Auth: usa access_token del brand_integrations.platform=facebook.
 *
 * Limitaciones del endpoint público:
 *   - Sin spend/impressions para ads comerciales (solo políticos/issue ads)
 *   - Demographics y targeting solo en EU (DSA disclosure)
 *   - Hasta 1000 ads por query, paginar con cursor (no implementado MVP)
 *
 * Modos de búsqueda:
 *   - searchPageIds: array de Facebook page_ids (más preciso)
 *   - searchTerms: texto libre (busca en creative + page name)
 */
export async function getMetaAdLibrary({ brandContainerId = null, organizationId, searchTerms, searchPageIds, country = "CO", limit = 50 }) {
  if (!searchTerms && !(searchPageIds && searchPageIds.length)) {
    throw new Error("getMetaAdLibrary: requiere searchTerms o searchPageIds");
  }
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");

  const url = new URL(`${META_GRAPH_BASE}/ads_archive`);
  url.searchParams.set("access_token", integ.access_token);
  url.searchParams.set("ad_reached_countries", JSON.stringify([country]));
  url.searchParams.set("ad_active_status", "ALL");
  url.searchParams.set("ad_type", "ALL");
  url.searchParams.set("limit", String(Math.min(limit, 100)));
  url.searchParams.set("fields", [
    "id", "page_id", "page_name", "publisher_platforms",
    "ad_creation_time", "ad_delivery_start_time", "ad_delivery_stop_time",
    "ad_creative_bodies", "ad_creative_link_titles", "ad_creative_link_descriptions",
    "ad_creative_link_captions", "ad_snapshot_url",
    "languages", "currency", "bylines",
    "target_ages", "target_gender", "target_locations", "eu_total_reach",
  ].join(","));

  if (searchTerms)              url.searchParams.set("search_terms", searchTerms);
  if (searchPageIds?.length)    url.searchParams.set("search_page_ids", JSON.stringify(searchPageIds));

  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (json?.error) {
    const e = new Error(`Meta Ad Library: ${json.error.message || json.error.type}`);
    if (/permission|access|capability/i.test(json.error.message || "")) e.needsReauth = true;
    throw e;
  }

  const ads = (json.data || []).map((a) => ({
    ad_archive_id:       a.id,
    page_id:             a.page_id,
    page_name:           a.page_name,
    publisher_platforms: a.publisher_platforms || [],
    creation_time:       a.ad_creation_time,
    delivery_start:      a.ad_delivery_start_time,
    delivery_stop:       a.ad_delivery_stop_time,
    creative_bodies:     a.ad_creative_bodies || [],
    creative_titles:     a.ad_creative_link_titles || [],
    creative_descs:      a.ad_creative_link_descriptions || [],
    creative_captions:   a.ad_creative_link_captions || [],
    snapshot_url:        a.ad_snapshot_url,
    languages:           a.languages || [],
    currency:            a.currency || null,
    bylines:             a.bylines || null,
    target_ages:         a.target_ages || null,
    target_gender:       a.target_gender || null,
    target_locations:    a.target_locations || null,
    eu_total_reach:      a.eu_total_reach || null,
  }));

  return {
    platform:  "meta",
    country,
    search:    { terms: searchTerms || null, page_ids: searchPageIds || null },
    total_ads: ads.length,
    ads,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIENCE DEMOGRAPHICS — composición real del público (gender/age/location)
// Tools usadas por el scraper (sensor_type = *_audience_demographics) para
// poblar audience_personas.real_* y permitir alignment vs persona conceptual.
// NO usan LLM — solo APIs oficiales y normalización determinista.
// ─────────────────────────────────────────────────────────────────────────────

function _normalizeGenderKey(k) {
  const lower = String(k || "").toLowerCase().trim();
  if (["f", "female", "femenino", "mujer", "women"].includes(lower)) return "female";
  if (["m", "male", "masculino", "hombre", "men"].includes(lower)) return "male";
  return "unknown";
}

function _normalizeGenderDistribution(dist) {
  if (!dist) return {};
  const out = {};
  let total = 0;
  for (const [k, v] of Object.entries(dist)) {
    const norm = _normalizeGenderKey(k);
    const num = Number(v) || 0;
    out[norm] = (out[norm] || 0) + num;
    total += num;
  }
  if (total > 0 && Math.abs(total - 1) > 0.01) {
    Object.keys(out).forEach((k) => { out[k] = out[k] / total; });
  }
  return out;
}

/**
 * getMetaAudienceDemographics — composición demográfica del público en Meta (FB+IG).
 *
 * Fuente principal: Instagram follower_demographics (breakdowns age/gender/country/city).
 * Fallback de ubicación: Facebook page_fans_country / page_fans_city.
 * Cada llamada falla en silencio — devolvemos lo disponible.
 */
export async function getMetaAudienceDemographics({ brandContainerId = null, organizationId }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  const { pageId, pageName, pageToken } = await _getMetaPageToken(
    integ.access_token, null, integ.metadata
  );

  const fbPage = await metaGet(`/${pageId}`, pageToken, {
    fields: "instagram_business_account{id,username,followers_count}",
  }).catch(() => ({}));
  const igAccount = fbPage?.instagram_business_account;

  const out = {
    platform: "meta",
    page: { id: pageId, name: pageName },
    instagram: igAccount ? {
      id: igAccount.id,
      username: `@${igAccount.username}`,
      followers: igAccount.followers_count || 0,
    } : null,
    data_sources: [],
    age_distribution: {},
    gender_distribution: {},
    location_distribution: { countries: {}, cities: {} },
    total_audience: 0,
  };

  const parseIgBreakdown = (resp) => {
    const results = resp?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    const raw = {};
    let total = 0;
    for (const r of results) {
      const key = (r.dimension_values || []).join("|") || "unknown";
      const val = Number(r.value) || 0;
      raw[key] = (raw[key] || 0) + val;
      total += val;
    }
    const dist = {};
    if (total > 0) Object.entries(raw).forEach(([k, v]) => { dist[k] = v / total; });
    return { distribution: dist, total };
  };

  if (igAccount?.id) {
    const breakdowns = ["age", "gender", "country", "city"];
    const [ageRes, genderRes, countryRes, cityRes] = await Promise.all(
      breakdowns.map((bd) =>
        metaGet(`/${igAccount.id}/insights`, pageToken, {
          metric: "follower_demographics",
          period: "lifetime",
          metric_type: "total_value",
          breakdown: bd,
        }).catch((err) => {
          console.warn(`[audience-demographics] IG ${bd} falló: ${err?.message || err}`);
          return null;
        })
      )
    );

    if (ageRes) {
      out.age_distribution = parseIgBreakdown(ageRes).distribution;
      out.data_sources.push("ig:age");
    }
    if (genderRes) {
      out.gender_distribution = _normalizeGenderDistribution(parseIgBreakdown(genderRes).distribution);
      out.data_sources.push("ig:gender");
    }
    if (countryRes) {
      const { distribution, total } = parseIgBreakdown(countryRes);
      out.location_distribution.countries = distribution;
      out.total_audience = Math.max(out.total_audience, total);
      out.data_sources.push("ig:country");
    }
    if (cityRes) {
      out.location_distribution.cities = parseIgBreakdown(cityRes).distribution;
      out.data_sources.push("ig:city");
    }
  }

  // Fallback de ubicación desde Facebook si IG no aportó
  if (!Object.keys(out.location_distribution.countries).length) {
    const fbCountry = await metaGet(`/${pageId}/insights`, pageToken, {
      metric: "page_fans_country",
      period: "lifetime",
    }).catch(() => null);
    const last = fbCountry?.data?.[0]?.values?.slice(-1)?.[0]?.value;
    if (last && typeof last === "object") {
      const total = Object.values(last).reduce((s, v) => s + Number(v || 0), 0);
      const dist = {};
      Object.entries(last).forEach(([k, v]) => { dist[k] = total > 0 ? Number(v) / total : 0; });
      out.location_distribution.countries = dist;
      out.total_audience = Math.max(out.total_audience, total);
      out.data_sources.push("fb:country");
    }
  }
  if (!Object.keys(out.location_distribution.cities).length) {
    const fbCity = await metaGet(`/${pageId}/insights`, pageToken, {
      metric: "page_fans_city",
      period: "lifetime",
    }).catch(() => null);
    const last = fbCity?.data?.[0]?.values?.slice(-1)?.[0]?.value;
    if (last && typeof last === "object") {
      const total = Object.values(last).reduce((s, v) => s + Number(v || 0), 0);
      const dist = {};
      Object.entries(last).forEach(([k, v]) => { dist[k] = total > 0 ? Number(v) / total : 0; });
      out.location_distribution.cities = dist;
      out.data_sources.push("fb:city");
    }
  }

  return out;
}

/**
 * getMetaAdsAudiences — sync de custom_audiences + saved_audiences de Meta Ads.
 *
 * Devuelve segmentos de audiencia operativos (no demografía agregada) para que
 * el scraper los UPSERTee en audience_segments. Estos son los segmentos accionables
 * que la marca ya está usando en sus campañas.
 *
 * Requiere scopes: ads_read (mínimo) o ads_management (para más detalle).
 */
export async function getMetaAdsAudiences({ brandContainerId = null, organizationId, adAccountId }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");

  // Resolver ad_account_id: primero el override, luego metadata, luego /me/adaccounts
  let actId = adAccountId || integ.metadata?.selected_ad_account_id;
  if (!actId) {
    const accs = await metaGet("/me/adaccounts", integ.access_token, {
      fields: "id,name,account_id,currency,account_status",
      limit: 25,
    }).catch(() => null);
    const active = (accs?.data || []).find((a) => a.account_status === 1) || accs?.data?.[0];
    if (!active) {
      return { platform: "meta", ad_account: null, custom_audiences: [], saved_audiences: [], message: "Sin ad accounts accesibles (revisa scopes ads_read/ads_management)" };
    }
    actId = active.id; // ya viene con prefijo "act_"
  }
  if (!actId.startsWith("act_")) actId = `act_${actId}`;

  // Custom audiences (incluyendo lookalikes y custom)
  const customResp = await metaGet(`/${actId}/customaudiences`, integ.access_token, {
    fields: "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,delivery_status",
    limit: 100,
  }).catch((err) => {
    console.warn(`[meta-ads-audiences] customaudiences falló: ${err?.message}`);
    return { data: [] };
  });

  // Saved audiences (con targeting explícito)
  const savedResp = await metaGet(`/${actId}/saved_audiences`, integ.access_token, {
    fields: "id,name,description,targeting,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated",
    limit: 100,
  }).catch((err) => {
    console.warn(`[meta-ads-audiences] saved_audiences falló: ${err?.message}`);
    return { data: [] };
  });

  const customAudiences = (customResp?.data || []).map((a) => {
    const lower = Number(a.approximate_count_lower_bound) || 0;
    const upper = Number(a.approximate_count_upper_bound) || 0;
    return {
      external_audience_id:   a.id,
      external_audience_name: a.name,
      external_audience_type: a.subtype || "CUSTOM",
      description:            a.description || null,
      size_lower_bound:       lower || null,
      size_upper_bound:       upper || null,
      estimated_size:         lower && upper ? Math.round((lower + upper) / 2) : null,
      time_created:           a.time_created,
      time_updated:           a.time_updated,
      delivery_status:        a.delivery_status?.code || null,
      raw_targeting:          {},
    };
  });

  // Helpers para parsear el targeting de saved_audiences (esquema Meta)
  const _genderMap = { 1: "male", 2: "female" };
  const _parseSavedTargeting = (t) => {
    if (!t) return {};
    const ageRange = (t.age_min || t.age_max) ? { min: t.age_min || null, max: t.age_max || null } : {};
    const genders  = (t.genders || []).map((g) => _genderMap[g] || "unknown");
    const locations = [];
    if (t.geo_locations) {
      (t.geo_locations.countries || []).forEach((c) => locations.push({ type: "country", value: c }));
      (t.geo_locations.cities    || []).forEach((c) => locations.push({ type: "city",    value: c.name || c.key }));
      (t.geo_locations.regions   || []).forEach((c) => locations.push({ type: "region",  value: c.name || c.key }));
    }
    const interests = (t.interests || []).map((i) => ({ id: i.id, name: i.name }));
    const behaviors = (t.behaviors || []).map((b) => ({ id: b.id, name: b.name }));
    const languages = (t.locales || []).map(String);
    return { ageRange, genders, locations, interests, behaviors, languages };
  };

  const savedAudiences = (savedResp?.data || []).map((a) => {
    const lower = Number(a.approximate_count_lower_bound) || 0;
    const upper = Number(a.approximate_count_upper_bound) || 0;
    const parsed = _parseSavedTargeting(a.targeting);
    return {
      external_audience_id:   a.id,
      external_audience_name: a.name,
      external_audience_type: "SAVED",
      description:            a.description || null,
      size_lower_bound:       lower || null,
      size_upper_bound:       upper || null,
      estimated_size:         lower && upper ? Math.round((lower + upper) / 2) : null,
      time_created:           a.time_created,
      time_updated:           a.time_updated,
      age_range:              parsed.ageRange,
      genders:                parsed.genders,
      locations:              parsed.locations,
      interests:              parsed.interests,
      behaviors:              parsed.behaviors,
      languages:              parsed.languages,
      raw_targeting:          a.targeting || {},
    };
  });

  return {
    platform:         "meta",
    ad_account:       actId,
    custom_audiences: customAudiences,
    saved_audiences:  savedAudiences,
    counts: {
      custom: customAudiences.length,
      saved:  savedAudiences.length,
    },
  };
}

/**
 * getGa4AudienceDemographics — composición demográfica del tráfico web (GA4).
 *
 * 4 reportes en paralelo (age, gender, country, city) normalizados al mismo
 * formato que getMetaAudienceDemographics para que el scraper los fusione.
 */
export async function getGa4AudienceDemographics({ brandContainerId = null, organizationId, range = "30d", propertyId }) {
  const integ = await getIntegrationToken(brandContainerId, organizationId, "google");

  let propId = propertyId || integ.metadata?.ga4_property_id;
  if (!propId) {
    const accountSummaries = await gaGet(`${GA4_ADMIN_BASE}/accountSummaries`, integ.access_token);
    const properties = [];
    for (const acc of accountSummaries?.accountSummaries || []) {
      for (const ps of acc.propertySummaries || []) {
        const m = (ps.property || "").match(/properties\/(\d+)/);
        if (m) properties.push({ id: m[1], name: ps.displayName });
      }
    }
    if (!properties.length) throw new Error("No hay propiedades GA4 en esta cuenta de Google.");
    propId = properties[0].id;
  }

  const { startDate, endDate } = _parseDateRange(range);

  const buildReport = (dim) => ({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: dim }],
    metrics: [{ name: "totalUsers" }],
    orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    limit: 50,
  });

  const [ageR, genderR, countryR, cityR] = await Promise.all([
    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, buildReport("userAgeBracket")).catch(() => null),
    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, buildReport("userGender")).catch(() => null),
    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, buildReport("country")).catch(() => null),
    gaPost(`${GA4_DATA_BASE}/properties/${propId}:runReport`, integ.access_token, buildReport("city")).catch(() => null),
  ]);

  const parseDist = (report) => {
    if (!report?.rows?.length) return { distribution: {}, total: 0 };
    const raw = {};
    let total = 0;
    for (const row of report.rows) {
      const key = row.dimensionValues?.[0]?.value || "unknown";
      const v = Number(row.metricValues?.[0]?.value || 0);
      raw[key] = v;
      total += v;
    }
    const dist = {};
    if (total > 0) Object.entries(raw).forEach(([k, v]) => { dist[k] = v / total; });
    return { distribution: dist, total };
  };

  const ageData     = parseDist(ageR);
  const genderData  = parseDist(genderR);
  const countryData = parseDist(countryR);
  const cityData    = parseDist(cityR);

  return {
    platform: "ga4",
    property: { id: propId },
    period:   { range, start_date: startDate, end_date: endDate },
    data_sources: [
      ageR     && "ga4:age",
      genderR  && "ga4:gender",
      countryR && "ga4:country",
      cityR    && "ga4:city",
    ].filter(Boolean),
    age_distribution: ageData.distribution,
    gender_distribution: _normalizeGenderDistribution(genderData.distribution),
    location_distribution: {
      countries: countryData.distribution,
      cities:    cityData.distribution,
    },
    total_audience: Math.max(ageData.total, genderData.total, countryData.total, cityData.total),
  };
}


/**
 * fetchOwnPostComments — comentarios del PUBLICO en publicaciones PROPIAS via
 * Graph API (sin Apify). Recibe posts [{ id, post_id, network }] y devuelve
 * filas listas para brand_post_comments (sin tocar DB; las persiste el sensor
 * meta_posts). Crudas: is_processed=false -> las puntua el cron de comentarios.
 */
export async function fetchOwnPostComments({ brandContainerId, organizationId, posts, perPost = 100 }) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  let pageToken = null;
  try {
    const integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
    const tok = await _getMetaPageToken(integ.access_token, null, integ.metadata);
    pageToken = tok && tok.pageToken ? tok.pageToken : null;
  } catch (_) { return []; }
  if (!pageToken) return [];

  const rows = [];
  for (const op of posts) {
    if (!op || !op.post_id) continue;
    const isIg = op.network === "instagram";
    let data = [];
    try {
      const res = await metaGet(`/${op.post_id}/comments`, pageToken, isIg
        ? { fields: "id,text,username,timestamp,like_count", limit: perPost }
        : { fields: "id,message,from{id,name},created_time,like_count", limit: perPost });
      data = (res && res.data) || [];
    } catch (_) { continue; }
    for (const c of data) {
      const content = isIg ? (c.text || "") : (c.message || "");
      if (!c.id || !content) continue;
      rows.push({
        brand_post_id: op.id,
        brand_container_id: brandContainerId,
        organization_id: organizationId,
        network: op.network,
        external_comment_id: c.id,
        author_handle: isIg ? (c.username || null) : (c.from && c.from.id ? c.from.id : null),
        author_display_name: isIg ? (c.username || null) : (c.from && c.from.name ? c.from.name : null),
        content,
        posted_at: isIg ? (c.timestamp || null) : (c.created_time || null),
        metrics: { likes: Number(c.like_count) || 0 },
        source: "meta_api",
        is_processed: false,
      });
    }
  }
  return rows;
}
