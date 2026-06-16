/**
 * platform-metrics.js — Catálogo y normalización de métricas por plataforma.
 *
 * PROBLEMA QUE RESUELVE: cada red social tiene su propia "moneda" de datos
 * (TikTok cuenta plays, X cuenta impressions, YouTube views, IG reach) y nombra
 * sus campos distinto (like_count vs likes vs diggCount). Sin una capa de
 * traducción, los consumidores (columnas generadas, ~100 RPCs, brain-feed de
 * Vera) reciben claves que no reconocen → engagement = 0.
 *
 * DISEÑO:
 *   - La INTELIGENCIA por plataforma vive aquí (config declarativa, extensible).
 *   - La DB guarda solo claves CANÓNICAS y calcula con columnas generadas simples.
 *   - Agregar una red nueva = agregar su schema aquí (no tocar SQL ni populators).
 *
 * CANÓNICAS DE INTERACCIÓN (activas, cuentan como engagement):
 *   likes · comments · shares · saves
 * CANÓNICAS DE ALCANCE (pasivas, NO son engagement — van a reach_total):
 *   reach · impressions · views · plays
 *
 * engagement_total = likes+comments+shares+saves   (columna generada)
 * reach_total      = mayor métrica de alcance disponible (columna generada)
 * engagement_rate  = engagement_total / reach_total (columna generada)
 */

const INTERACTION_KEYS = ["likes", "comments", "shares", "saves"];
const REACH_KEYS        = ["reach", "impressions", "views", "plays"];

/**
 * Schema por plataforma. `map` traduce campo NATIVO → clave canónica; cuando
 * varios nativos mapean a la misma canónica, se SUMAN (ej. en X retweets+quotes
 * → shares). `reachCanon` indica cuál canónica de alcance usa esa red.
 *
 * Las redes cuyo dato ya llega canónico (IG/FB vía scraper) no necesitan `map`:
 * pasan por passthrough.
 */
const METRIC_SCHEMAS = {
  tiktok: {
    label: "TikTok",
    map: {
      like_count:    "likes",
      comment_count: "comments",
      share_count:   "shares",
      view_count:    "plays",   // en TikTok "view" = reproducción
    },
    reachCanon: "plays",
  },
  x: {
    label: "X",
    map: {
      like_count:      "likes",
      reply_count:     "comments",
      retweet_count:   "shares",   // retweets + quotes ambos amplifican
      quote_count:     "shares",
      bookmark_count:  "saves",
      impression_count:"impressions",
    },
    reachCanon: "impressions",
  },
  youtube: {
    label: "YouTube",
    map: {
      viewCount:    "views",
      likeCount:    "likes",
      commentCount: "comments",
    },
    reachCanon: "views",
  },
  // instagram / facebook: el scraper ya entrega claves canónicas → passthrough.
  instagram: { label: "Instagram", reachCanon: "reach" },
  facebook:  { label: "Facebook",  reachCanon: "reach" },
};

/**
 * Traduce las métricas crudas de una red a claves canónicas.
 * Acumula cuando varios campos nativos mapean a la misma canónica.
 * Si la red no tiene `map` (IG/FB), devuelve las métricas tal cual (passthrough),
 * confiando en que ya vienen canónicas.
 *
 * @param {string} network
 * @param {object} raw — métricas nativas de la API/scraper
 * @returns {object} métricas canónicas
 */
export function normalizeMetrics(network, raw) {
  const schema = METRIC_SCHEMAS[String(network || "").toLowerCase()];
  const src = raw && typeof raw === "object" ? raw : {};
  if (!schema || !schema.map) return { ...src }; // passthrough (ya canónico)

  const out = {};
  for (const [nativeKey, canon] of Object.entries(schema.map)) {
    const v = Number(src[nativeKey]);
    if (!Number.isFinite(v) || v === 0) continue;
    out[canon] = (out[canon] || 0) + v;
  }
  // Conservar claves que ya vinieran canónicas y no las hayamos sobrescrito
  // (defensivo: si una API mezcla nativas + canónicas).
  for (const k of [...INTERACTION_KEYS, ...REACH_KEYS]) {
    if (out[k] == null && Number.isFinite(Number(src[k]))) out[k] = Number(src[k]);
  }
  return out;
}

/** Suma de interacciones activas (lo que SÍ es engagement). */
export function interactionsOf(metrics) {
  const m = metrics || {};
  return INTERACTION_KEYS.reduce((s, k) => s + (Number(m[k]) || 0), 0);
}

/** Alcance de un post: la mayor métrica de alcance disponible (evita doble conteo). */
export function reachOf(metrics) {
  const m = metrics || {};
  return REACH_KEYS.reduce((mx, k) => Math.max(mx, Number(m[k]) || 0), 0);
}

/** engagement_rate = interacciones / alcance (0 si no hay alcance conocido). */
export function engagementRateOf(metrics) {
  const reach = reachOf(metrics);
  if (!reach) return 0;
  return interactionsOf(metrics) / reach;
}

export { METRIC_SCHEMAS, INTERACTION_KEYS, REACH_KEYS };
