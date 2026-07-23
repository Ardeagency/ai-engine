/**
 * Social Scraper Service — motor de scraping de competidores.
 *
 * Integración con el schema real de Supabase:
 *   monitoring_triggers  → define QUÉ scraper corre y con qué cadencia por entidad
 *   sensor_runs          → log de ejecución de cada scrape (reemplaza console.log)
 *   intelligence_signals → señales detectadas (posts, cambios de URL, precios)
 *   brand_posts          → copia de posts de competidores para el MCP
 *   agent_queue_jobs     → NO usado aquí — el signal-webhook lo encola al detectar
 *
 * Fuentes de scraping:
 *   - Instagram:  Playwright stealth + interceptor de API interna (anti-bot avanzado)
 *   - TikTok:     Playwright stealth + captura de feed API + fallback JSON hidratado
 *   - YouTube:    InnerTube API interna (sin API key, HTTP directo)
 *   - Amazon:     axios/fetch + cheerio con fallback Playwright (precios, rating)
 *   - Facebook:   Playwright stealth (páginas públicas)
 *   - URL Watch:  diff SHA-256 de texto visible (via url_watchers)
 *
 * Fallback legacy (sin Playwright):
 *   - Instagram: web_profile_info endpoint directo
 *   - TikTok:    JSON __UNIVERSAL_DATA_FOR_REHYDRATION__ vía fetch
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
// Legacy Playwright scrapers eliminados — Apify es ahora el backend (ver apify.client.js).
// Triggers "social" están paused. Stubs para mantener compatibilidad con call sites huérfanos.
const _legacyStub = (name) => async () => {
  console.warn(`[legacy] ${name}() called but Playwright scrapers were removed. Use apify.client.runActor() instead.`);
  return [];
};
const scrapeInstagramPlaywright    = _legacyStub("scrapeInstagramPlaywright");
const scrapeTikTokPlaywright       = _legacyStub("scrapeTikTokPlaywright");
const scrapeYouTubeChannel         = _legacyStub("scrapeYouTubeChannel");
const scrapeAmazonProduct          = _legacyStub("scrapeAmazonProduct");
const scrapeAmazonSearch           = _legacyStub("scrapeAmazonSearch");
const scrapeFacebookPage           = _legacyStub("scrapeFacebookPage");
const scrapeInstagramPostComments  = _legacyStub("scrapeInstagramPostComments");
const scrapeAdLibraryPublic        = _legacyStub("scrapeAdLibraryPublic");
import {
  getMetaPageInsights,
  getMetaPosts,
  getGoogleAnalytics,
  getMetaAudienceDemographics,
  getGa4AudienceDemographics,
  getMetaAdsAudiences,
  getMetaAdLibrary,
  fetchOwnPostComments,
  fetchOwnPostsPage,
} from "../tools/social.tools.js";
import { runAlignmentForBrand } from "./audience-alignment.service.js";
import { runCampaignPerformanceForBrand } from "./campaign-performance.service.js";
import { syncMetaAdInsightsForBrand } from "./sync-meta-ad-insights.service.js";
import { runBrandIndexer } from "./brand-indexer.service.js";
import { archiveThumb } from "./media-archive.service.js";
import { runTikTokVideoInsights, runMercadoLibreMetrics, runMetaAccountInsights, runGoogleAdsInsights, runShopifyMetrics } from "./platform-insights-sensors.service.js";

// Media analysis event-driven: al ingerir un post nuevo, pedimos al python-analyzer
// que describa su imagen/video si aun no tiene media analysis. Fire-and-forget.
import { triggerMediaAnalysis } from "./media-analysis.service.js";

// Service-role: el scraper escribe directo a Supabase sin RLS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

// ── Headers anti-bot ──────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  Accept:          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
  Referer:         "https://www.instagram.com/",
  "X-IG-App-ID":   "936619743392459",
};

const delay    = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter   = (base, spread = 0.3) =>
  base + Math.floor(base * spread * (Math.random() - 0.5) * 2);

// ── sensor_runs helpers ───────────────────────────────────────────────────────
// Registran el ciclo de vida de cada ejecución del scraper en la tabla
// sensor_runs, que ya existe en el schema y está diseñada exactamente para esto.

// Mapa para trackear start_time de cada sensor_run y calcular duration_ms
const _sensorRunStartTimes = new Map();

async function openSensorRun(triggerId, brandContainerId, entityId, sensorType) {
  const startedAt = new Date();
  const { data, error } = await supabase
    .from("sensor_runs")
    .insert({
      trigger_id:         triggerId,
      brand_container_id: brandContainerId,
      entity_id:          entityId,
      sensor_type:        sensorType,
      status:             "running",
      started_at:         startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    console.warn(`scraper: no se pudo abrir sensor_run — ${error.message}`);
    return null;
  }
  _sensorRunStartTimes.set(data.id, startedAt.getTime());
  return data.id;
}

async function closeSensorRun(sensorRunId, status, stats = {}, errorMessage = null) {
  if (!sensorRunId) return;
  const now        = new Date();
  const startTime  = _sensorRunStartTimes.get(sensorRunId);
  const durationMs = startTime ? (now.getTime() - startTime) : null;
  _sensorRunStartTimes.delete(sensorRunId);

  await supabase
    .from("sensor_runs")
    .update({
      status,
      finished_at:   now.toISOString(),
      duration_ms:   durationMs,
      error_message: errorMessage,
      stats,
    })
    .eq("id", sensorRunId);
}

// ── Instagram Scraper ─────────────────────────────────────────────────────────

async function scrapeInstagramProfile(handle) {
  const cleanHandle = handle.replace(/^@/, "").trim();
  try {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${cleanHandle}`;
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, "X-Requested-With": "XMLHttpRequest" },
      signal:  AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];

    const json  = await res.json();
    const edges = json?.data?.user?.edge_owner_to_timeline_media?.edges || [];

    return edges.slice(0, 12).map((e) => {
      const node    = e.node;
      const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
      return {
        external_id:   node.id,
        network:       "instagram",
        content:       caption.slice(0, 2000),
        url:           `https://www.instagram.com/p/${node.shortcode}/`,
        media_type:    node.__typename,
        like_count:    node.edge_liked_by?.count      || 0,
        comment_count: node.edge_media_to_comment?.count || 0,
        timestamp:     new Date(node.taken_at_timestamp * 1000).toISOString(),
      };
    });
  } catch (e) {
    console.warn(`scraper [instagram]: @${handle} — ${e.message}`);
    return [];
  }
}

// ── TikTok Scraper ────────────────────────────────────────────────────────────

async function scrapeTikTokProfile(handle) {
  const cleanHandle = handle.replace(/^@/, "").trim();
  try {
    const res = await fetch(`https://www.tiktok.com/@${cleanHandle}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];

    const html  = await res.text();
    const match = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/
    );
    if (!match) return [];

    const data   = JSON.parse(match[1]);
    const videos = data?.itemList || [];
    if (!videos.length) return [];

    return videos.slice(0, 12).map((v) => ({
      external_id:   v.id,
      network:       "tiktok",
      content:       v.desc || "",
      url:           `https://www.tiktok.com/@${cleanHandle}/video/${v.id}`,
      media_type:    "video",
      like_count:    v.stats?.diggCount    || 0,
      comment_count: v.stats?.commentCount || 0,
      share_count:   v.stats?.shareCount   || 0,
      play_count:    v.stats?.playCount    || 0,
      timestamp:     new Date(v.createTime * 1000).toISOString(),
    }));
  } catch (e) {
    console.warn(`scraper [tiktok]: @${handle} — ${e.message}`);
    return [];
  }
}

// ── URL Watcher ───────────────────────────────────────────────────────────────

async function scrapeUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VeraBot/1.0)" },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, text: "", hash: "" };

    const html = await res.text();

    // Texto limpio (como antes)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 10_000);

    const hash = crypto.createHash("sha256").update(text).digest("hex");

    // B1 — extraer metadata estructurada del HTML (regex-based, no cheerio para no agregar dep)
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").trim();
    const meta_description =
      (html.match(/<meta[^>]+name=[\"\']description[\"\'][^>]+content=[\"\']([^\"\']+)[\"\']/i)?.[1] ||
       html.match(/<meta[^>]+content=[\"\']([^\"\']+)[\"\'][^>]+name=[\"\']description[\"\']/i)?.[1] || "").trim();

    const og_image = (html.match(/<meta[^>]+property=[\"\']og:image[\"\'][^>]+content=[\"\']([^\"\']+)[\"\']/i)?.[1] || "").trim();
    const og_title = (html.match(/<meta[^>]+property=[\"\']og:title[\"\'][^>]+content=[\"\']([^\"\']+)[\"\']/i)?.[1] || "").trim();
    const og_description = (html.match(/<meta[^>]+property=[\"\']og:description[\"\'][^>]+content=[\"\']([^\"\']+)[\"\']/i)?.[1] || "").trim();

    // JSON-LD (schema.org data — product, event, article, etc.)
    const json_ld = [];
    for (const m of html.matchAll(/<script[^>]+type=[\"\']application\/ld\+json[\"\'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { json_ld.push(JSON.parse(m[1].trim())); } catch {}
    }

    // Detectar precio visible (heurística product pages)
    let price = null;
    const priceMatch = text.match(/[\$€£]\s?([0-9]{1,5}[.,][0-9]{2})/);
    if (priceMatch) price = parseFloat(priceMatch[1].replace(",", "."));

    // Extraer precio de JSON-LD si está (más confiable)
    for (const ld of json_ld) {
      const p = ld?.offers?.price || ld?.offers?.[0]?.price;
      if (p) { price = parseFloat(p); break; }
    }

    return {
      ok: true,
      text,
      hash,
      title,
      meta_description,
      og: { image: og_image || null, title: og_title || null, description: og_description || null },
      json_ld,
      price,
    };
  } catch (e) {
    return { ok: false, error: e.message, text: "", hash: "" };
  }
}

// ── Dedup: fuente de verdad → brand_posts.post_id (más robusto que intelligence_signals) ─────
// Motivo: intelligence_signals puede tener formato variable y solo devolvía los últimos 50.
// brand_posts siempre tiene post_id limpio y tiene UNIQUE constraint (entity_id, post_id).

async function getKnownPostIds(entityId) {
  // Traemos los post_id de brand_posts para esta entidad (hasta 500 historial reciente).
  // Esto garantiza que no reinsertamos posts que ya procesamos aunque intelligence_signals
  // tenga más de 50 registros previos.
  const { data } = await supabase
    .from("brand_posts")
    .select("post_id")
    .eq("entity_id", entityId)
    .order("captured_at", { ascending: false })
    .limit(500);

  return new Set((data || []).map((r) => r.post_id).filter(Boolean));
}

// ── Persistencia: nuevos posts → brand_posts (upsert) + intelligence_signals ─────────────────
// Estrategia en dos pasos:
//   1. brand_posts: upsert por (entity_id, post_id) — si ya existe, actualiza métricas.
//      Esto protege contra duplicados incluso en condiciones de carrera.
//   2. intelligence_signals: solo inserta si el post es NUEVO (no existía antes en brand_posts).
//      Señales → alimentan el pipeline de análisis de Vera vía signal-webhook.

async function persistNewPosts(posts, entity) {
  const knownIds = await getKnownPostIds(entity.id);
  const newPosts = posts.filter((p) => !knownIds.has(p.external_id));

  // Aunque no haya posts nuevos, actualizamos las métricas de los ya conocidos (upsert silencioso)
  const allPosts = posts; // los que sí existen se actualizan vía upsert en brand_posts
  for (const post of allPosts) {
    if (knownIds.has(post.external_id)) {
      // Solo actualizar métricas (likes/comments/etc.) — no re-señalizar
      const patch = {
        metrics: {
          likes:    post.like_count,
          comments: post.comment_count,
          shares:   post.share_count  || 0,
          plays:    post.play_count   || 0,
        },
        updated_at: new Date().toISOString(),
      };
      // SEGUNDA VENTANA DE RESCATE: el actor devuelve URLs frescas también de
      // los posts que ya teníamos. Si a este le falta la copia permanente y
      // ahora llega una miniatura viva, se archiva — así lo capturado antes
      // del archivado se recupera solo, corrida a corrida.
      const rescued = await rescueArchivedThumb(entity, post);
      if (rescued) patch.media_assets = rescued;
      await supabase.from("brand_posts")
        .update(patch)
        .eq("entity_id", entity.id)
        .eq("post_id", post.external_id);
    }
  }

  if (!newPosts.length) return 0;

  let inserted = 0;
  for (const post of newPosts) {
    // ── brand_posts: insert con manejo de conflictos resiliente ─────────────
    // Intenta upsert con UNIQUE constraint (si existe, migración v7 aplicada).
    // Si el constraint no existe aún, hace INSERT simple con manejo de duplicados
    // via la capa de pre-check (getKnownPostIds) que ya filtra los conocidos.
    // B1 — media_assets consolidado (URLs de media + previews)
    const media_assets = {
      display_url:     post.display_url     || null,
      thumbnail_url:   post.thumbnail_url   || post.cover_image || null,
      video_url:       post.video_url       || null,
      video_duration:  post.video_duration  || null,
      media_urls:      post.media_urls      || [],
      main_image_url:  post.main_image_url  || null,   // Amazon
      images:          post.images          || [],    // Amazon gallery
      thumbnails:      post.thumbnails      || [],    // YouTube múltiples res
      cover_image:     post.cover_image     || null,  // TikTok
    };

    // ARCHIVO DE MINIATURA (2026-07-22): Instagram y TikTok firman las URLs de
    // su CDN con expiracion — a las pocas semanas dan 403 y el dashboard pierde
    // la cara del contenido. La UNICA ventana en que esa URL sirve es ahora, al
    // capturar. Se copia la miniatura a R2 y se guarda la URL permanente; el
    // frontend la prefiere y cae a la original si no existe.
    // Fail-open: si el archivado falla, el post se guarda igual.
    const archivedUrl = await archiveThumb({
      mediaAssets:      media_assets,
      brandContainerId: entity.brand_container_id,
      network:          post.network,
      postId:           post.external_id,
    });
    if (archivedUrl) media_assets.archived_url = archivedUrl;

    // B1 — metrics expandido
    const metrics = {
      likes:            post.like_count      || 0,
      comments:         post.comment_count   || 0,
      shares:           post.share_count     || 0,
      plays:            post.play_count      || 0,
      saves:            post.saved_count     || 0,
      video_view_count: post.video_view_count || 0,
      video_duration_s: post.duration_seconds || null,
    };

    // B1 — enrichment: todo lo no-media y no-métrica
    const enrichment = {
      // Entidades extraídas
      hashtags:       post.hashtags      || [],
      mentions:       post.mentions      || [],
      tagged_users:   post.tagged_users  || [],
      coauthors:      post.coauthors     || [],
      challenges:     post.challenges    || [],

      // Flags de contenido
      is_sponsored:   Boolean(post.is_sponsored || post.is_ad),
      is_video:       Boolean(post.is_video),
      is_short:       Boolean(post.is_short),
      is_duet:        Boolean(post.is_duet),
      is_stitch:      Boolean(post.is_stitch),
      is_live:        Boolean(post.is_live),
      comments_disabled: Boolean(post.comments_disabled),

      // Contenido adicional
      accessibility_caption: post.accessibility_caption || null,

      // Geo
      location: post.location || null,
      region:   post.region   || null,

      // Autor (clave para engagement_rate y verification)
      author: post.author || null,

      // Audio/música (TikTok)
      music: post.music || null,

      // Amazon commerce
      bullet_points:     post.bullet_points     || null,
      category_path:     post.category_path     || null,
      prime_eligible:    post.prime_eligible    ?? null,
      deal_badge:        post.deal_badge        || null,
      coupon_available:  post.coupon_available  ?? null,
      subscribe_save:    post.subscribe_save    ?? null,
      variants:          post.variants          || null,
      best_sellers_rank: post.best_sellers_rank || null,
      reviews_sample:    post.reviews_sample    || null,
      questions_sample:  post.questions_sample  || null,
    };

    // LINAJE DEL DATO (decision JC 2026-07-15): ai-engine NO analiza, pero SI
    // distingue de quien es cada post. El rol sale del tipo de la entidad:
    // solo competidor_directo/indirecto es COMPETENCIA; referencia_cultural es
    // REFERENCIA (aprender, no rivalizar); aliado es ALIADO; owned_media es
    // PROPIO. Sin tipo declarado se conserva el comportamiento historico
    // (competitor) para no re-clasificar a ciegas.
    const entityTipo = String(entity.metadata?.tipo || "").toLowerCase();
    const isRealCompetitor = entityTipo ? entityTipo.startsWith("competidor") : true;
    const postSource = !entityTipo ? "competitor"
      : entityTipo === "owned_media" ? "own"
      : isRealCompetitor ? "competitor"
      : entityTipo === "aliado" ? "ally"
      : "reference";

    const bpRow = {
      brand_container_id: entity.brand_container_id,
      entity_id:          entity.id,
      network:            post.network,
      profile_handle:     entity.target_identifier,
      post_id:            post.external_id,
      content:            post.content,
      metrics,
      media_assets,
      enrichment,
      // Sin followers_snapshot, post_patterns.engagement_rate = 0 y
      // discover_emerging_patterns nunca detecta nada (filtra por avg > 1.5x baseline).
      followers_snapshot: post.author?.followers_count || null,
      is_competitor: isRealCompetitor,
      post_source:   postSource,
      captured_at:   post.timestamp,
    };

    // Intento 1: upsert con constraint (requiere migración v7)
    let bpErr = null;
    let savedBrandPostId = null;
    const { data: upsertData, error: upsertErr } = await supabase.from("brand_posts").upsert(bpRow, {
      onConflict: "entity_id,post_id",
      ignoreDuplicates: false,
    }).select("id").maybeSingle();
    bpErr = upsertErr;
    savedBrandPostId = upsertData?.id;

    // Si el constraint no existe, hacer INSERT simple
    if (bpErr?.message?.includes("no unique or exclusion constraint")) {
      const { data: insertData, error: insertErr } = await supabase.from("brand_posts")
        .insert(bpRow).select("id").maybeSingle();
      bpErr = insertErr;
      savedBrandPostId = insertData?.id;
    }

    if (bpErr) {
      console.warn(`scraper: brand_posts error — ${bpErr.message}`);
      continue;
    }

    // ── intelligence_signals: solo para posts genuinamente nuevos ──────────
    // El signal desencadena el análisis de Vera a través del signal-webhook.
    const { error: sigErr } = await supabase
      .from("intelligence_signals")
      .insert({
        entity_id:    entity.id,
        signal_type:  "post",
        content_text: JSON.stringify({
          external_id:   post.external_id,
          network:       post.network,
          caption:       post.content,         // campo "caption" para classifyThreatLevel
          content:       post.content,
          url:           post.url,
          media_type:    post.media_type,
          like_count:    post.like_count,
          comment_count: post.comment_count,
          share_count:   post.share_count  || 0,
          play_count:    post.play_count   || 0,
        }),
        content_numeric: post.like_count   || 0,
        ai_analysis:     {},
        captured_at:     post.timestamp,
      });

    if (sigErr) {
      console.warn(`scraper: signal insert error (non-fatal) — ${sigErr.message}`);
    }

    // ── trend_topics: keywords del contenido del post nuevo ───────────────
    if (post.content?.length > 20) {
      await persistTrendTopics(
        post.content,
        entity.brand_container_id,
        entity.id,
        post.network,
        post.timestamp,
      );
    }

    // Media analysis: describe imagen/video del post nuevo (event-driven).
    if (savedBrandPostId) {
      await triggerMediaAnalysis(savedBrandPostId);
    }

    inserted++;
    await delay(jitter(300));
  }

  return inserted;
}

// ── monitoring_triggers: el corazón del scheduler ────────────────────────────
// La tabla monitoring_triggers define POR ENTIDAD cuándo debe correr el scraper.
// Campos usados:
//   sensor_type    → 'social', 'web', 'marketplace', 'news'
//   cadence        → 'interval' | 'daily' | 'hourly' etc.
//   cadence_value  → ej: '60' (minutos), '2h', '1d'
//   next_run_at    → cuándo debe correr el siguiente ciclo
//   status         → 'active' | 'paused' | 'disabled'

async function getTriggersToRun() {
  const { data, error } = await supabase
    .from("monitoring_triggers")
    .select(`
      id,
      brand_container_id,
      entity_id,
      sensor_type,
      config,
      cadence,
      cadence_value,
      priority,
      intelligence_entities(
        id, name, domain, target_identifier, brand_container_id, metadata, organization_id
      )
    `)
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString())
    .in("sensor_type", [
      "social", "web", "marketplace", "youtube", "facebook",
      "meta_page_insights", "meta_posts", "ga4_analytics",
      "meta_audience_demographics", "meta_campaign_audience_demographics", "ga4_audience_demographics",
      "meta_ads_audiences_sync", "audience_alignment_analysis",
      "brand_audience_heatmap_compute", "mission_generation",
      "brand_indexer", "threat_detection", "meta_ad_library_sync",
      "meta_campaign_ad_insights",
      "trends_run",
      "trends_keywords",
      "tiktok_video_insights",
      "mercadolibre_metrics",
      "google_ads_insights",
      "shopify_metrics",
    ])
    .order("priority", { ascending: false })
    .order("next_run_at", { ascending: true })
    .limit(20); // máximo 20 triggers por ciclo

  if (error) {
    console.warn(`scraper: no se pudieron obtener monitoring_triggers — ${error.message}`);
    return [];
  }
  return data || [];
}

// Ventana histórica de posts según el plan de la org (plans.social_history_days).
// Default defensivo: 30 días si no hay plan o columna.
async function getSocialHistoryDays(organizationId) {
  if (!organizationId) return 30;
  try {
    // Override por org (tuning por cliente) — tiene prioridad sobre el plan.
    const { data: org } = await supabase
      .from("organizations")
      .select("social_history_days_override")
      .eq("id", organizationId)
      .maybeSingle();
    if (org?.social_history_days_override) return org.social_history_days_override;

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plans!inner(social_history_days)")
      .eq("organization_id", organizationId)
      .in("status", ["trial", "active", "past_due"])
      .maybeSingle();
    return sub?.plans?.social_history_days || 30;
  } catch (e) {
    console.warn(`[meta_posts] plan window lookup falló (${e.message}) — default 30d`);
    return 30;
  }
}

function computeNextRunAt(cadence, cadenceValue) {
  const now   = new Date();
  const value = parseInt(cadenceValue || "60", 10);

  switch (cadence) {
    case "interval":
      // cadence_value = minutos
      return new Date(now.getTime() + value * 60 * 1000).toISOString();
    case "hourly":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    case "daily":
      return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    default:
      // default: 60 minutos
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }
}

async function updateTriggerAfterRun(triggerId, status, nextRunAt) {
  await supabase
    .from("monitoring_triggers")
    .update({
      last_run_at:     new Date().toISOString(),
      last_run_status: status,
      next_run_at:     nextRunAt,
      updated_at:      new Date().toISOString(),
    })
    .eq("id", triggerId);
}

// ── URL Watchers (via url_watchers table) ────────────────────────────────────

// Cadencia de los URL watchers (web). Editable por env; default 12h.
// Antes: se scrapeaba TODO watcher en cada poll (~15min) -> ~384 fetch/dia con 4 watchers.
const URL_WATCH_CADENCE_HOURS = Number(process.env.URL_WATCH_CADENCE_HOURS) || 12;

async function checkUrlWatchers() {
  const cutoff = new Date(Date.now() - URL_WATCH_CADENCE_HOURS * 3_600_000).toISOString();
  const { data: watchers } = await supabase
    .from("url_watchers")
    .select("id, url, last_hash, entity_id, brand_container_id, label")
    .eq("is_active", true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`) // GATE: solo los vencidos
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(50);

  if (!watchers?.length) return;

  for (const watcher of watchers) {
    await delay(jitter(2000));
    const now = new Date().toISOString();
    const result = await scrapeUrl(watcher.url);
    if (!result.ok) {
      // fetch fallido: marcar revisado igual para respetar la cadencia (no machacar URL muerta)
      await supabase.from("url_watchers").update({ last_checked_at: now }).eq("id", watcher.id);
      continue;
    }

    // SIEMPRE avanzar last_checked_at (+ last_hash) -> respeta el gate y rota la cola
    const changed = result.hash !== watcher.last_hash;
    await supabase
      .from("url_watchers")
      .update({ last_hash: result.hash, last_checked_at: now })
      .eq("id", watcher.id);

    if (!changed) continue;

    console.log(`url-watcher: cambio detectado — ${watcher.label || watcher.url}`);

    if (watcher.entity_id) {
      const now = new Date().toISOString();
      await supabase.from("intelligence_signals").insert({
        entity_id:    watcher.entity_id,
        signal_type:  "url_change",
        content_text: JSON.stringify({
          url:     watcher.url,
          label:   watcher.label,
          excerpt: result.text.slice(0, 1500),
        }),
        ai_analysis: {},
        captured_at: now,
      });

      // ── trend_topics: extraer keywords del texto detectado ────────────
      // Extrae palabras clave del texto cambiado (excluye stopwords comunes)
      await persistTrendTopics(result.text, watcher.brand_container_id, watcher.entity_id, "url_change", now);
    }
  }
}

// ── trend_topics: registrar keywords detectados en señales ───────────────────
// Analiza texto de señales y extrae keywords relevantes (longitud > 4 chars,
// no son stopwords, frecuencia mínima 2 en el texto o son términos de precio/oferta).
// Referencia: tabla trend_topics — keyword, source, category, velocity_score, relevance_score

const STOPWORDS = new Set([
  "para","como","este","esta","esto","pero","también","desde","hasta","sobre",
  "entre","cada","todo","toda","todos","todas","cuando","donde","porque","aunque",
  "what","that","this","with","from","have","will","your","more","they","their",
  "there","which","about","after","would","could","should","these","those","been",
  "were","into","than","then","some","also","just","like","only","make","made",
  "very","most","such","both","here","said","each","much","them","well","long",
]);

function extractKeywords(text, maxKeywords = 8) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  // Contar frecuencias
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  // Priorizar términos de negocio relevantes
  const PRIORITY_TERMS = /sale|offer|price|precio|oferta|descuento|nuevo|launch|lanzamiento|promo|rebajas|nueva|limited|edicion|coleccion|collection|exclusive/i;

  return Object.entries(freq)
    .sort(([ka, fa], [kb, fb]) => {
      const pa = PRIORITY_TERMS.test(ka) ? 10 : 0;
      const pb = PRIORITY_TERMS.test(kb) ? 10 : 0;
      return (fb + pb) - (fa + pa);
    })
    .slice(0, maxKeywords)
    .map(([word, count]) => ({
      keyword:        word,
      velocity_score: Math.min(count / words.length * 100, 10).toFixed(2),
      is_priority:    PRIORITY_TERMS.test(word),
    }));
}

async function persistTrendTopics(text, brandContainerId, entityId, source, capturedAt) {
  try {
    const keywords = extractKeywords(text);
    if (!keywords.length) return;

    const rows = keywords.map((k) => ({
      brand_container_id: brandContainerId,
      keyword:            k.keyword,
      source,
      category:           k.is_priority ? "promo" : "general",
      velocity_score:     parseFloat(k.velocity_score),
      relevance_score:    k.is_priority ? 0.8 : 0.4,
      sentiment:          {},
      detected_at:        capturedAt || new Date().toISOString(),
      metadata:           { entity_id: entityId },
    }));

    const { error } = await supabase.from("trend_topics").insert(rows);
    if (error) console.warn(`scraper: trend_topics error — ${error.message}`);
  } catch (e) {
    console.warn(`scraper: persistTrendTopics error — ${e.message}`);
  }
}

// ── Amazon: persistir en retail_prices + intelligence_signals ────────────────
// retail_prices: tabla diseñada para tracking de precios por retailer/SKU
// intelligence_signals: solo cuando hay cambio de precio o producto nuevo
// Detecta cambio comparando con la última entrada en retail_prices.

async function persistAmazonSignal(product, entity) {
  if (!product) return;
  try {
    const marketplace = entity.metadata?.marketplace || "es";
    const now         = new Date().toISOString();

    // ── retail_prices: registro permanente de precio (siempre upsert) ─────
    // Esta tabla está diseñada exactamente para esto: tracking de precios por retailer
    const { error: rpErr } = await supabase.from("retail_prices").insert({
      brand_container_id: entity.brand_container_id,
      entity_id:          entity.id,
      retailer:           `amazon.${marketplace}`,
      sku:                product.asin,
      product_name:       product.title,
      price:              product.price,
      currency:           marketplace === "es" ? "EUR" : "USD",
      stock_status:       product.availability || "En stock",
      promo_label:        product.discount_pct ? `-${product.discount_pct}%` : null,
      promo_details:      {
        list_price:   product.list_price,
        discount_pct: product.discount_pct,
        rating:       product.rating,
        review_count: product.review_count,
        seller:       product.seller,
        brand:        product.brand,
        url:          product.url,
      },
      captured_at: now,
      metadata:    { asin: product.asin, marketplace },
    });
    if (rpErr) console.warn(`scraper [amazon]: retail_prices error — ${rpErr.message}`);

    // ── intelligence_signals: solo si hay cambio de precio o es nuevo ─────
    // Buscar última entrada en retail_prices para detectar cambio de precio
    const { data: lastEntry } = await supabase
      .from("retail_prices")
      .select("price, captured_at")
      .eq("entity_id", entity.id)
      .eq("sku", product.asin)
      .order("captured_at", { ascending: false })
      .limit(2);  // la primera es la que acabamos de insertar, la segunda es la anterior

    const prevPrice = lastEntry?.[1]?.price ?? null;
    const priceChanged = prevPrice !== null && product.price !== null && prevPrice !== product.price;
    const isFirstRecord = lastEntry?.length <= 1;
    const signalType = isFirstRecord ? "new_product" : (priceChanged ? "price_change" : null);

    if (!signalType) {
      console.log(`scraper [amazon]: ${product.title?.slice(0, 40)} — precio sin cambios (${product.price}€)`);
      return;
    }

    const priceDelta = priceChanged ? +(product.price - prevPrice).toFixed(2) : null;
    const deltaLabel = priceDelta !== null
      ? ` (${priceDelta > 0 ? "+" : ""}${priceDelta}€)`
      : "";

    await supabase.from("intelligence_signals").insert({
      entity_id:       entity.id,
      signal_type:     signalType,
      content_text:    JSON.stringify({
        asin:         product.asin,
        title:        product.title,
        price:        product.price,
        prev_price:   prevPrice,
        price_delta:  priceDelta,
        list_price:   product.list_price,
        discount_pct: product.discount_pct,
        rating:       product.rating,
        review_count: product.review_count,
        availability: product.availability,
        seller:       product.seller,
        brand:        product.brand,
        url:          product.url,
        marketplace,
      }),
      content_numeric: product.price || 0,
      ai_analysis:     {},
      captured_at:     now,
    });

    console.log(`scraper [amazon]: ${signalType} — ${product.title?.slice(0, 40)} ${product.price}€${deltaLabel}`);
  } catch (e) {
    console.warn(`scraper [amazon]: persistAmazonSignal error — ${e.message}`);
  }
}

// ── getTriggersToRun: ahora incluye marketplace y otras fuentes ────────────────
// (reemplaza la función anterior que solo aceptaba social+web)

// ── Función principal: corre los triggers pendientes ─────────────────────────

export async function runCompetitorScraper(brandContainerId = null) {
  console.log("scraper: iniciando ciclo basado en monitoring_triggers...");

  let triggers = await getTriggersToRun();

  // Filtro opcional por brand_container
  if (brandContainerId) {
    triggers = triggers.filter((t) => t.brand_container_id === brandContainerId);
  }

  if (!triggers.length) {
    console.log("scraper: sin monitoring_triggers pendientes");
    // URL watchers no dependen de triggers
    await checkUrlWatchers();
    return { triggers_run: 0, new_signals: 0 };
  }

  let totalNew = 0;

  // ── Pre-pass: batch de social triggers por (organizationId, platform) ──────
  // Evita 1 run Apify por entity. Devuelve un Map keyed por trigger.id con los
  // posts ya scrapeados, para que el loop principal solo persista sin re-scrapear.
  // batchOkTriggers = set de trigger.id cuyos batches terminaron sin error
  // (si NO está aquí, el batch falló → no debemos auto-desactivar la entity).
  const { postsByTrigger: socialBatchResults, batchOkTriggers } = await _runSocialBatchPass(
    triggers.filter(t => t.sensor_type === "social")
  );

  for (const trigger of triggers) {
    const entity     = trigger.intelligence_entities;
    const sensorRunId = await openSensorRun(
      trigger.id,
      trigger.brand_container_id,
      trigger.entity_id,
      trigger.sensor_type
    );

    try {
      // ── Branch nuevo: analytics propias (Meta page/posts + GA4) ────────────
      // No requieren target_identifier — resuelven la integración OAuth desde
      // brand_container_id vía getIntegrationToken() interno.
      if (
        trigger.sensor_type === "meta_page_insights" ||
        trigger.sensor_type === "meta_posts" ||
        trigger.sensor_type === "ga4_analytics" ||
        trigger.sensor_type === "meta_audience_demographics" ||
        trigger.sensor_type === "meta_campaign_audience_demographics" ||
        trigger.sensor_type === "ga4_audience_demographics" ||
        trigger.sensor_type === "meta_ads_audiences_sync" ||
        trigger.sensor_type === "audience_alignment_analysis" ||
        trigger.sensor_type === "brand_audience_heatmap_compute" ||
        trigger.sensor_type === "mission_generation" ||
        trigger.sensor_type === "brand_indexer" ||
        trigger.sensor_type === "threat_detection" ||
        trigger.sensor_type === "meta_ad_library_sync" ||
        trigger.sensor_type === "meta_campaign_ad_insights" ||
        trigger.sensor_type === "trends_run" ||
        trigger.sensor_type === "trends_keywords" ||
        trigger.sensor_type === "tiktok_video_insights" ||
        trigger.sensor_type === "mercadolibre_metrics" ||
        trigger.sensor_type === "google_ads_insights" ||
        trigger.sensor_type === "shopify_metrics"
      ) {
        await runOwnedAnalyticsSensor(trigger, entity, sensorRunId);
        await delay(jitter(2000));
        continue;
      }

      const rawHandle = entity.target_identifier;
      if (!rawHandle) {
        await closeSensorRun(sensorRunId, "skipped", {}, "target_identifier vacío");
        continue;
      }

      // Normalizar: si target_identifier es una URL completa, extraer solo el path/handle.
      // Ej: "https://www.instagram.com/nike/?hl=es" → "nike"
      //     "https://www.tiktok.com/@charlidamelio" → "charlidamelio"
      let handle = rawHandle;
      try {
        if (rawHandle.startsWith("http://") || rawHandle.startsWith("https://")) {
          const url  = new URL(rawHandle);
          const path = url.pathname.replace(/^\/+|\/+$/g, ""); // strip leading/trailing /
          handle = path.replace(/^@/, "");                       // strip @ if present
        }
      } catch {
        // rawHandle no es URL válida — usar tal cual
      }

      let posts = [];

      if (trigger.sensor_type === "social") {
        // Los posts ya fueron scrapeados en el batch pre-pass (1 run Apify por
        // (org, platform) en vez de 1 por entity). Aquí solo recogemos del Map.
        posts = socialBatchResults.get(trigger.id) || [];

      } else if (trigger.sensor_type === "marketplace") {
        // Amazon: rawHandle es el ASIN (ej: "B0BV7XQ9V9") o query de búsqueda
        // Si comienza con "B0" o tiene 10 chars alfanuméricos → ASIN directo
        // Si no → búsqueda de productos
        const isAsin = /^[A-Z0-9]{10}$/.test(handle.toUpperCase());
        if (isAsin) {
          const product = await scrapeAmazonProduct(handle.toUpperCase(), entity.metadata?.marketplace || "es");
          if (product) {
            // Los productos de Amazon se guardan como señales de precio
            await persistAmazonSignal(product, entity);
          }
        } else {
          // Búsqueda de productos del competidor
          const searchResults = await scrapeAmazonSearch(handle, entity.metadata?.marketplace || "es");
          for (const prod of searchResults.slice(0, 5)) {
            const detail = await scrapeAmazonProduct(prod.asin, entity.metadata?.marketplace || "es");
            if (detail) await persistAmazonSignal(detail, entity);
            await delay(jitter(3000));
          }
        }

        const nextRunAt = computeNextRunAt(trigger.cadence, trigger.cadence_value);
        await updateTriggerAfterRun(trigger.id, "success", nextRunAt);
        await closeSensorRun(sensorRunId, "success", { posts_found: 0, new_signals: 0 });
        console.log(`scraper [marketplace]: ${entity.name} — Amazon scrape completado (next: ${nextRunAt})`);
        continue;

      } else if (trigger.sensor_type === "web") {
        // URL watchers procesados por checkUrlWatchers al final del ciclo
        await closeSensorRun(sensorRunId, "skipped", {}, "web sensor usa url_watchers");
        continue;
      }

      const newCount = await persistNewPosts(posts, entity);
      totalNew += newCount;
      // Persistir comentarios inline (Apify IG trae latestComments[6] gratis)
      try { await _persistInlineComments(posts, entity); } catch (e) { console.warn(); }

      // B2 — enriquecer top-3 posts por engagement con recent_comments (solo IG)
      // Controlar vía RECENT_COMMENTS_ENABLED=false para deshabilitar
      if (process.env.RECENT_COMMENTS_ENABLED !== "false" && posts.length > 0) {
        const platform = posts[0]?.network;
        if (platform === "instagram") {
          try {
            await _enrichTopPostsWithIgComments(posts, entity);
          } catch (e) {
            console.warn(`scraper [ig-comments]: ${entity?.name} — ${e.message}`);
          }
        }
      }

      const nextRunAt = computeNextRunAt(trigger.cadence, trigger.cadence_value);
      await updateTriggerAfterRun(trigger.id, "success", nextRunAt);
      await closeSensorRun(sensorRunId, "success", {
        posts_found: posts.length,
        new_signals: newCount,
      });

      // Auto-deactivate: si el scrape devolvió 0 items, incrementar counter.
      // Solo aplica a triggers cuyo batch corrió OK. Si el batch falló (timeout,
      // error de actor) el 0 es falso negativo — no penalizamos la entity.
      try {
        const batchRanOk = trigger.sensor_type !== "social" || batchOkTriggers.has(trigger.id);
        if (posts.length === 0 && batchRanOk) {
          const { data: deact } = await supabase.rpc("mark_empty_platform_inactive", {
            p_entity_id: entity.id, p_threshold: 3,
          });
          if (deact?.action === "deactivated") {
            console.warn(`scraper: ${entity.name} auto-desactivado tras ${deact.consecutive_empty} runs vacíos (threshold=${deact.effective_threshold}) en ${deact.platform}`);
          }
        } else if (posts.length > 0) {
          await supabase.rpc("reset_empty_run_counter", { p_entity_id: entity.id });
        }
      } catch (e) {
        console.warn(`scraper: empty-run tracking falló para ${entity?.name} — ${e.message}`);
      }

      console.log(
        `scraper: ${entity.name} — ${posts.length} posts revisados, ${newCount} nuevos (next: ${nextRunAt})`
      );
    } catch (e) {
      console.error(`scraper: ${entity?.name} falló — ${e.message}`);
      const nextRunAt = computeNextRunAt(trigger.cadence, trigger.cadence_value);
      await updateTriggerAfterRun(trigger.id, "failed", nextRunAt);
      await closeSensorRun(sensorRunId, "failed", {}, e.message?.slice(0, 500));
    }

    await delay(jitter(2000)); // pausa entre entidades
  }

  // URL watchers al final del ciclo
  await checkUrlWatchers();

  // Generar snapshot de analítica para las últimas horas (reporte a brand_analytics_snapshots).
  // Agrupamos triggers por brand_container_id para escribir un snapshot por marca real
  // y evitar el FK violation de un UUID hardcodeado que no existe en brand_containers.
  if (totalNew > 0) {
    const triggersByBrand = new Map();
    for (const t of triggers) {
      if (!t.brand_container_id) continue;
      if (!triggersByBrand.has(t.brand_container_id)) triggersByBrand.set(t.brand_container_id, []);
      triggersByBrand.get(t.brand_container_id).push(t);
    }
    for (const [bid, brandTriggers] of triggersByBrand) {
      await writeCycleSnapshot(bid, brandTriggers, totalNew);
    }
  }

  console.log(`scraper: ciclo completo — ${triggers.length} triggers, ${totalNew} señales nuevas`);

  // ─── VERA BRAIN FEED: despertar a Vera al final del ciclo ─────────────────
  // Para cada brand_container que tuvo al menos 1 trigger en este ciclo,
  // chequear si todos sus sensores están "fresh" y disparar el feed a Vera.
  // Idempotente vía UNIQUE(brand_container_id, cycle_id) en vera_brain_feeds.
  // Deshabilitar con VERA_BRAIN_FEED_ENABLED=false.
  if (process.env.VERA_BRAIN_FEED_ENABLED !== "false") {
    try {
      const brandsTouched = new Set(triggers.map(t => t.brand_container_id).filter(Boolean));
      if (brandsTouched.size > 0) {
        const { deliverCycleFeed, isCycleComplete } = await import("./vera-brain-feed.service.js");
        const cycleId = crypto.randomUUID();
        for (const bid of brandsTouched) {
          const ready = await isCycleComplete(bid);
          if (!ready) continue;
          // Fire-and-forget — no bloqueamos el siguiente ciclo del scheduler
          deliverCycleFeed(bid, cycleId).catch(e =>
            console.warn(`vera-brain-feed: brand=${bid} cycle=${cycleId} falló — ${e.message}`)
          );
        }
      }
    } catch (e) {
      console.warn(`vera-brain-feed: hook falló (non-fatal) — ${e.message}`);
    }
  }

  return { triggers_run: triggers.length, new_signals: totalNew };
}

// ── Analytics Snapshot: resumen del ciclo → brand_analytics_snapshots ─────────
// Escribe un snapshot cada vez que el scraper detecta nuevos posts.
// Columnas de brand_analytics_snapshots: brand_container_id, platform, period_type,
//   period_start, period_end, metrics, computed_at

async function writeCycleSnapshot(brandContainerId, triggers, newSignals) {
  try {
    const now       = new Date();
    // period_start y period_end son tipo DATE en Supabase (no timestamp)
    const periodEnd   = now.toISOString().slice(0, 10);           // "YYYY-MM-DD"
    const periodStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString().slice(0, 10);

    // Agregar métricas de los últimos posts por red social
    const { data: recentPosts } = await supabase
      .from("brand_posts")
      .select("network, metrics, captured_at, entity_id")
      .gte("captured_at", periodStart)
      .order("captured_at", { ascending: false })
      .limit(100);

    const byNetwork = {};
    (recentPosts || []).forEach((p) => {
      const net = p.network || "unknown";
      if (!byNetwork[net]) byNetwork[net] = { posts: 0, likes: 0, comments: 0, shares: 0, plays: 0 };
      byNetwork[net].posts++;
      byNetwork[net].likes    += p.metrics?.likes    || 0;
      byNetwork[net].comments += p.metrics?.comments || 0;
      byNetwork[net].shares   += p.metrics?.shares   || 0;
      byNetwork[net].plays    += p.metrics?.plays    || 0;
    });

    // Totales globales
    const totalPosts    = recentPosts?.length || 0;
    const totalLikes    = Object.values(byNetwork).reduce((s, n) => s + n.likes, 0);
    const totalComments = Object.values(byNetwork).reduce((s, n) => s + n.comments, 0);

    // Insertar snapshot en brand_analytics_snapshots
    const { error } = await supabase.from("brand_analytics_snapshots").upsert({
      brand_container_id: brandContainerId,
      platform:           "all",
      period_type:        "hourly",
      period_start:       periodStart,
      period_end:         periodEnd,
      metrics: {
        new_signals:   newSignals,
        triggers_run:  triggers.length,
        total_posts_in_window: totalPosts,
        total_likes:   totalLikes,
        total_comments: totalComments,
        by_network:    byNetwork,
        entities_scraped: [...new Set(triggers.map((t) => t.intelligence_entities?.name).filter(Boolean))],
      },
      computed_at: now.toISOString(),
    }, { onConflict: "brand_container_id,platform,period_type,period_start" });

    if (error) {
      console.warn(`scraper: snapshot write error (non-fatal) — ${error.message}`);
    } else {
      console.log(`scraper: snapshot horario escrito — ${newSignals} nuevas señales, ${totalPosts} posts en ventana`);
    }
  } catch (e) {
    console.warn(`scraper: writeCycleSnapshot falló (non-fatal) — ${e.message}`);
  }
}

// ── Scheduler interno ─────────────────────────────────────────────────────────
// Corre cada `intervalMinutes` minutos buscando monitoring_triggers vencidos.
// La frecuencia real de scraping por entidad la controla next_run_at en la DB.

let _scraperTimer = null;

// ── Session keepalive: REMOVIDO (2026-06-01) ─────────────────────────────────
// El keepalive de cookies locales (Instagram/TikTok/Facebook via Playwright
// stealth) era legado del modelo PRE-Apify. El scraping se migro a Apify (cloud,
// ver apify.client.js) y ya NO hay sesiones de browser locales que mantener.
// El codigo viejo importaba `../lib/session-manager.js` (modulo inexistente) y
// solo emitia "Cannot find module ... (non-fatal)" cada 12h. Eliminado.

export function startScraperScheduler(intervalMinutes = 10) {
  // El scheduler hace polling cada `intervalMinutes` (default: 10 min).
  // La cadencia real de scraping por entidad la controla next_run_at en monitoring_triggers.
  // Ejemplo: trigger con cadence=interval/45 → el scheduler lo ve cada 10 min
  // y lo ejecuta cuando next_run_at <= NOW(). Así la latencia máxima es 10 min.
  const base = parseInt(process.env.SCRAPER_INTERVAL_MINUTES || String(intervalMinutes), 10) * 60 * 1000;

  const scheduleNext = () => {
    _scraperTimer = setTimeout(async () => {
      try { await runCompetitorScraper(); }
      catch (e) { console.error(`scraper: error en ciclo — ${e.message}`); }
      scheduleNext();
    }, jitter(base, 0.1));
  };

  // Primera ejecución 90 segundos después del boot (da tiempo para que el servidor arranque)
  setTimeout(async () => {
    try { await runCompetitorScraper(); }
    catch (e) { console.error(`scraper: error en primera ejecución — ${e.message}`); }
    scheduleNext();
  }, 90 * 1000);

  const pollMin = base / 60_000;
  console.log(`scraper: scheduler iniciado (polling cada ~${pollMin} min para monitoring_triggers vencidos)`);
}

export function stopScraperScheduler() {
  if (_scraperTimer) {
    clearTimeout(_scraperTimer);
    _scraperTimer = null;
  }
  console.log("scraper: scheduler detenido");
}


// ── Owned analytics sensor: Meta + GA4 vía APIs oficiales ────────────────────
// Triggers con sensor_type = meta_page_insights | meta_posts | ga4_analytics.
// La integración OAuth se resuelve dentro de las tools (getIntegrationToken).

async function runOwnedAnalyticsSensor(trigger, entity, sensorRunId) {
  const sensorType       = trigger.sensor_type;
  const brandContainerId = trigger.brand_container_id;
  let organizationId     = entity?.organization_id;

  // Sensores brand-wide pueden no tener entity asociada — resolver org desde brand_containers
  if (!organizationId && brandContainerId) {
    const { data: bc } = await supabase
      .from("brand_containers")
      .select("organization_id")
      .eq("id", brandContainerId)
      .maybeSingle();
    organizationId = bc?.organization_id;
  }

  if (!organizationId) {
    await closeSensorRun(sensorRunId, "failed", {}, "no se pudo resolver organization_id");
    const nextRunAt = computeNextRunAt(trigger.cadence, trigger.cadence_value);
    await updateTriggerAfterRun(trigger.id, "failed", nextRunAt);
    return;
  }

  try {
    let stats = {};
    // Permite a un sensor sobrescribir la cadencia por ciclo (ej. meta_posts en
    // backfill se re-agenda pronto; al terminar pasa a diario).
    let nextRunOverride = null;

    if (sensorType === "shopify_metrics") {
      const result = await runShopifyMetrics({ brandContainerId, organizationId });
      stats = {
        shop:         result.shop || null,
        orders_30d:   result.orders_30d ?? null,
        revenue_30d:  result.revenue_30d ?? null,
        orders_total: result.orders_total ?? null,
        skipped:      result.skipped || false,
        reason:       result.reason || null,
        errors:       (result.errors && result.errors.length) || 0,
      };

    } else if (sensorType === "google_ads_insights") {
      const result = await runGoogleAdsInsights({ brandContainerId, organizationId });
      stats = {
        customers:     result.customers ?? 0,
        campaign_days: result.campaign_days ?? 0,
        account_days:  result.account_days ?? 0,
        skipped:       result.skipped || false,
        reason:        result.reason || null,
        errors:        (result.errors && result.errors.length) || 0,
      };

    } else if (sensorType === "tiktok_video_insights") {
      const result = await runTikTokVideoInsights({ brandContainerId, organizationId });
      stats = {
        handle:     result.handle || null,
        videos:     result.videos_pulled ?? 0,
        updated:    result.updated ?? 0,
        inserted:   result.inserted ?? 0,
        followers:  result.followers ?? null,
        skipped:    result.skipped || false,
        reason:     result.reason || null,
      };

    } else if (sensorType === "mercadolibre_metrics") {
      const result = await runMercadoLibreMetrics({ brandContainerId, organizationId });
      stats = {
        seller_id:           result.seller_id || null,
        visits_30d:          result.visits_30d ?? null,
        orders_30d:          result.orders_30d ?? null,
        revenue_30d_sampled: result.revenue_30d_sampled ?? null,
        questions_unanswered: result.questions_unanswered ?? null,
        skipped:             result.skipped || false,
        reason:              result.reason || null,
        errors:              (result.errors && result.errors.length) || 0,
      };

    } else if (sensorType === "meta_page_insights") {
      // Insights de CUENTA de Facebook Page + Instagram Business. Escribe el
      // snapshot (estado actual, como antes) Y la serie historica diaria en
      // platform_insights_daily. Antes solo guardaba FB e ignoraba IG a nivel cuenta.
      const result = await runMetaAccountInsights({ brandContainerId, organizationId });
      stats = {
        fb_fans:        result.facebook?.fans ?? null,
        fb_engagements: result.facebook?.engagements ?? null,
        ig_followers:   result.instagram?.followers ?? null,
        ig_reach:       result.instagram?.reach ?? null,
        errors:         (result.errors && result.errors.length) || 0,
      };

    } else if (sensorType === "meta_posts") {
      // ── Ingesta SANA de posts propios IG + FB (cola reanudable header-aware) ──
      // 1) Ventana histórica = plan de la org (3 sem / 1 mes / 3 meses).
      // 2) Backfill por COLA: cada ciclo trae un presupuesto de páginas respetando
      //    el header de uso de Meta, guarda el cursor en monitoring_triggers.config
      //    y se re-agenda pronto hasta alcanzar la ventana → luego pasa a diario.
      const windowDays  = await getSocialHistoryDays(organizationId);
      const planCutoff  = new Date(Date.now() - windowDays * 86_400_000);
      const PAGE_BUDGET = parseInt(process.env.META_BACKFILL_PAGES_PER_RUN || "3", 10);
      const cfg = trigger.config || {};
      const bf  = cfg.backfill || {};
      const newBf = { ...bf };

      let totalFound = 0, totalNew = 0, anyBackfilling = false;

      for (const net of ["instagram", "facebook"]) {
        const st = bf[net] || { status: "pending", after: null, window_cutoff: planCutoff.toISOString(), pages: 0, ingested: 0 };
        // La ventana se "congela" en el primer ciclo para que la cola sea estable.
        const cutoffTs = st.window_cutoff || planCutoff.toISOString();
        try {
          const res = st.status === "done"
            // INCREMENTAL: solo lo nuevo (persistOwnPosts dedup por post_id).
            ? await fetchOwnPostsPage({ brandContainerId, organizationId, network: net, after: null, pageSize: 50, maxPages: 2 })
            // BACKFILL: reanuda desde el cursor, corta en la ventana del plan.
            : await fetchOwnPostsPage({ brandContainerId, organizationId, network: net, after: st.after, pageSize: 50, maxPages: PAGE_BUDGET, stopBeforeTs: cutoffTs });

          const ins = await persistOwnPosts(res.posts || [], brandContainerId, entity.id);
          totalFound += res.posts?.length || 0;
          totalNew   += ins;

          if (st.status === "done") {
            newBf[net] = { ...st, last_run: "incremental", last_usage: res.usage, updated_at: new Date().toISOString() };
          } else {
            const done = res.reachedCutoff || res.reachedEnd;
            newBf[net] = {
              status:        done ? "done" : "running",
              after:         done ? null : res.nextAfter,
              window_cutoff: cutoffTs,
              pages:         (st.pages || 0) + (res.pages || 0),
              ingested:      (st.ingested || 0) + ins,
              oldest:        res.oldest || st.oldest || null,
              last_usage:    res.usage,
              updated_at:    new Date().toISOString(),
            };
            if (!done || res.pausedForUsage) anyBackfilling = true;
          }
        } catch (e) {
          // Sin IG vinculado → marcar done para no reintentar en bucle.
          if (e.noIgLinked && net === "instagram") {
            newBf[net] = { status: "done", reason: "no_ig_linked", updated_at: new Date().toISOString() };
          } else {
            console.warn(`[meta_posts ${net}] ${e.message}`);
            newBf[net] = { ...(bf[net] || {}), status: bf[net]?.status || "running", last_error: (e.message || "").slice(0, 200), updated_at: new Date().toISOString() };
            if (newBf[net].status !== "done") anyBackfilling = true;
          }
        }
      }

      // Comentarios del PÚBLICO en posts propios (sentimiento/riesgo de marca).
      // Solo cuando NO estamos en backfill (para no competir por el rate limit) y
      // acotado a los top recientes — el cron python-analyzer-comments los puntúa.
      let commentsSynced = 0;
      if (!anyBackfilling) {
        try {
          const { data: ownPosts } = await supabase.from("brand_posts")
            .select("id,post_id,network").eq("brand_container_id", brandContainerId)
            .eq("is_competitor", false).order("captured_at", { ascending: false }).limit(40);
          const commentRows = await fetchOwnPostComments({ brandContainerId, organizationId, posts: ownPosts || [] });
          if (commentRows.length) {
            const { error: cErr } = await supabase.from("brand_post_comments")
              .upsert(commentRows, { onConflict: "network,external_comment_id", ignoreDuplicates: true });
            if (cErr) console.warn(`[meta_posts comments] upsert: ${cErr.message}`);
            else commentsSynced = commentRows.length;
          }
        } catch (e) { console.warn(`[meta_posts comments] ${e.message}`); }
      }

      // Persistir estado de la cola + cadencia dinámica.
      await supabase.from("monitoring_triggers")
        .update({ config: { ...cfg, backfill: newBf } })
        .eq("id", trigger.id);
      if (anyBackfilling) {
        const mins = parseInt(process.env.META_BACKFILL_INTERVAL_MIN || "20", 10);
        nextRunOverride = new Date(Date.now() + mins * 60_000).toISOString();
      } else {
        nextRunOverride = computeNextRunAt("daily", "1");
      }

      stats = {
        window_days:     windowDays,
        posts_found:     totalFound,
        new_signals:     totalNew,
        comments_synced: commentsSynced,
        backfilling:     anyBackfilling,
        ig:              newBf.instagram?.status || null,
        fb:              newBf.facebook?.status || null,
        ig_ingested:     newBf.instagram?.ingested || 0,
        fb_ingested:     newBf.facebook?.ingested || 0,
      };

    } else if (sensorType === "ga4_analytics") {
      const result = await getGoogleAnalytics({ brandContainerId, organizationId, range: "30d" });
      await persistAnalyticsSnapshot(brandContainerId, "google_analytics", "monthly", result);
      stats = {
        sessions: result.overview?.sessions,
        users:    result.overview?.total_users,
      };

    } else if (sensorType === "meta_audience_demographics") {
      const result = await getMetaAudienceDemographics({ brandContainerId, organizationId });
      const updated = await persistAudienceDemographics(brandContainerId, "meta", result);
      stats = {
        sources:        result.data_sources,
        total_audience: result.total_audience,
        personas_updated: updated,
      };

    } else if (sensorType === "meta_campaign_audience_demographics") {
      const result = await runCampaignPerformanceForBrand(brandContainerId, organizationId);
      stats = {
        campaigns_analyzed:      result.campaigns_analyzed || 0,
        recommendations_created: result.recommendations_created || 0,
        errors:                  result.errors || 0,
        status:                  result.status || null,
      };

    } else if (sensorType === "meta_campaign_ad_insights") {
      // FEAT-023 — sync ad-level insights diario para dashboard "Mis Campañas".
      // Ventana last_7d para capturar atribuciones tardías (Meta puede actualizar
      // conversions hasta 7d después). Idempotente vía UNIQUE constraint.
      const result = await syncMetaAdInsightsForBrand(brandContainerId, organizationId, { datePreset: "last_7d" });
      stats = {
        campaigns_processed: result.campaigns_processed || 0,
        ads_upserted:        result.ads_upserted || 0,
        errors:              result.errors || 0,
        skipped_no_token:    result.skipped_no_token || 0,
        skipped_no_data:     result.skipped_no_data || 0,
      };

    } else if (sensorType === "ga4_audience_demographics") {
      const result = await getGa4AudienceDemographics({ brandContainerId, organizationId, range: "30d" });
      const updated = await persistAudienceDemographics(brandContainerId, "ga4", result);
      stats = {
        sources:        result.data_sources,
        total_audience: result.total_audience,
        personas_updated: updated,
      };

    } else if (sensorType === "meta_ads_audiences_sync") {
      const result = await getMetaAdsAudiences({ brandContainerId, organizationId });
      const synced = await persistAudienceSegments(brandContainerId, organizationId, result);
      stats = {
        ad_account:    result.ad_account,
        custom_count:  result.counts?.custom || 0,
        saved_count:   result.counts?.saved || 0,
        upserted:      synced,
      };

    } else if (sensorType === "audience_alignment_analysis") {
      const result = await runAlignmentForBrand(brandContainerId, organizationId);
      const lowAlignment = (result.results || []).filter((r) => r.score != null && r.score < 0.5).length;
      const pendingActions = (result.results || []).filter((r) => r.pending_action_id).length;
      stats = {
        personas_analyzed: result.count || 0,
        low_alignment:     lowAlignment,
        pending_actions:   pendingActions,
        skipped:           result.skipped ? result.reason : null,
      };

    } else if (sensorType === "brand_audience_heatmap_compute") {
      const result = await runHeatmapCompute(brandContainerId, organizationId);
      stats = {
        networks_updated: result.networks,
        posts_analyzed:   result.posts,
        window_days:      365,
      };

    } else if (sensorType === "brand_indexer") {
      const result = await runBrandIndexer(brandContainerId, organizationId);
      stats = {
        chunks_indexed:    result.indexed,
        chunks_unchanged:  result.skipped_unchanged,
        embed_errors:      result.embed_errors || 0,
        db_errors:         result.db_errors || 0,
        breakdown:         result.breakdown,
        error:             result.error || null,
      };
      if (result.error && result.indexed === 0 && result.skipped_unchanged === 0) {
        throw new Error(`brand_indexer: ${result.error}`);
      }

    } else if (sensorType === "meta_ad_library_sync") {
      const result = await runMetaAdLibrarySync(brandContainerId, organizationId);
      stats = {
        competitors_searched: result.searched,
        competitors_skipped:  result.skipped_competitors,
        ads_inserted:         result.inserted,
        ads_updated:          result.updated,
        ads_filtered_out:     result.filtered_out,
      };

    } else if (sensorType === "trends_run") {
      // Trends engine: cap de queries derivado del plan de la org.
      // creator=10, team=20, agency=30. Fallback 10 (creator) si no hay plan.
      let maxQ = 10;
      try {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("plans!inner(trends_max_queries)")
          .eq("organization_id", organizationId)
          .in("status", ["trial", "active", "past_due"])
          .maybeSingle();
        if (sub?.plans?.trends_max_queries) maxQ = sub.plans.trends_max_queries;
      } catch (e) {
        console.warn(`scraper [trends_run]: plan lookup falló (${e.message}) — usando default ${maxQ}`);
      }
      // Override por env solo si está explícito y es menor (defensa, no escala arriba)
      const envCap = parseInt(process.env.TRENDS_MAX_QUERIES_PER_RUN || "0", 10);
      if (envCap > 0 && envCap < maxQ) maxQ = envCap;

      const url  = `http://127.0.0.1:8001/trends/run/${brandContainerId}?mock=false&max_queries=${maxQ}`;
      const r    = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!r.ok) throw new Error(`trends/run HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const result = await r.json();
      stats = {
        plan_max_queries:  maxQ,
        queries:           result.queries,
        signals_raw:       result.signals_raw,
        signals_filtered:  result.signals_filtered,
        signals_scored:    result.scored,
        briefs_generated:  result.briefs,
        cost_usd:          result.total_cost_usd,
        cycle_id:          result.cycle_id,
      };

    } else if (sensorType === "trends_keywords") {
      // Keyword Discovery Loop (Tavily). Corre 1x/dia (~5am COT). Presupuesto
      // de llamadas = plan.trends_max_queries; el modulo tiene su propia guarda mensual.
      let maxCalls = 10;
      try {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("plans!inner(trends_max_queries)")
          .eq("organization_id", organizationId)
          .in("status", ["trial", "active", "past_due"])
          .maybeSingle();
        if (sub?.plans?.trends_max_queries) maxCalls = sub.plans.trends_max_queries;
      } catch (e) {
        console.warn(`scraper [trends_keywords]: plan lookup fallo (${e.message}) — default ${maxCalls}`);
      }
      const url = `http://127.0.0.1:8001/trends/keywords/${brandContainerId}?max_calls=${maxCalls}&max_rounds=2`;
      const r   = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!r.ok) throw new Error(`trends/keywords HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const result = await r.json();
      stats = {
        seeds:       result.seeds,
        spent_calls: result.spent_calls,
        measured:    result.measured,
        promoted:    result.promoted,
        month_calls: result.month_calls_before,
      };
    }

    const nextRunAt = nextRunOverride || computeNextRunAt(trigger.cadence, trigger.cadence_value);
    await updateTriggerAfterRun(trigger.id, "success", nextRunAt);
    await closeSensorRun(sensorRunId, "success", stats);
    console.log(`scraper [${sensorType}]: ${entity?.name || "—"} OK (next: ${nextRunAt})`);

  } catch (e) {
    const reason = e?.needsReauth ? "needs_reauth" : (e?.noIntegration ? "no_integration" : "error");
    // Integracion AUSENTE (no reauth): la marca no tiene esa integracion conectada.
    // No es un error del sistema — es un sensor huerfano (p.ej. ga4 en una marca sin
    // Google). Se cierra 'skipped' (no ensucia como fallo) y se ELIMINA el trigger
    // para no reintentar a diario. brand-sensor-sync lo recreara — gated por
    // `requires` — solo si esa integracion aparece. Asi se auto-sana sin ruido.
    if (e?.noIntegration) {
      console.log(`scraper [${sensorType}]: brand ${trigger.brand_container_id} sin integracion — trigger huerfano eliminado`);
      await closeSensorRun(sensorRunId, "skipped", { reason }, "sin integracion conectada (sensor no aplica a esta marca)");
      await supabase.from("monitoring_triggers").delete().eq("id", trigger.id).then(() => {}, () => {});
      return;
    }
    console.warn(`scraper [${sensorType}]: ${entity?.name || "—"} falló (${reason}) — ${e.message}`);
    const nextRunAt = computeNextRunAt(trigger.cadence, trigger.cadence_value);
    await updateTriggerAfterRun(trigger.id, "failed", nextRunAt);
    await closeSensorRun(sensorRunId, "failed", { reason }, e.message?.slice(0, 500));
  }
}

// ── Persistencia de snapshots de analítica ──────────────────────────────────
async function persistAnalyticsSnapshot(brandContainerId, platform, periodType, payload) {
  const now         = new Date();
  const periodEnd   = now.toISOString().slice(0, 10);
  const days        = periodType === "weekly" ? 7 : 30;
  const periodStart = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

  const { error } = await supabase.from("brand_analytics_snapshots").upsert({
    brand_container_id: brandContainerId,
    platform,
    period_type:        periodType,
    period_start:       periodStart,
    period_end:         periodEnd,
    metrics:            payload,
    computed_at:        now.toISOString(),
  }, { onConflict: "brand_container_id,platform,period_type,period_start" });

  if (error) console.warn(`scraper [analytics-snapshot]: ${platform} — ${error.message}`);
}

// ── Persistencia de demografía real → audience_personas.real_* ──────────────
// Estrategia de fusión multi-fuente (Meta + GA4):
//   - Cada distribución almacena bajo `_raw[source]` los datos originales por
//     fuente y bajo `_totals[source]` el peso (audiencia/usuarios totales).
//   - Las claves top-level son la distribución mergeada: weighted average por
//     totales. Si solo una fuente está disponible, ese promedio == esa fuente.
//   - Una nueva corrida del sensor SOBRESCRIBE solo `_raw[source]` y recalcula.
//   - Sin LLM — pura matemática y normalización determinista.

function _stripMeta(obj) {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith("_")));
}

function mergeDistributionFromRaw(raw, totals) {
  const sumWeights = Object.values(totals || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  if (sumWeights <= 0) {
    // Sin pesos: si solo hay una fuente, devolverla; si hay varias, promedio simple
    const keys = Object.keys(raw || {});
    if (!keys.length) return {};
    if (keys.length === 1) return { ..._stripMeta(raw[keys[0]]) };
    const allKeys = new Set();
    Object.values(raw).forEach((d) => Object.keys(d).forEach((k) => allKeys.add(k)));
    const merged = {};
    for (const k of allKeys) {
      const vals = Object.values(raw).map((d) => Number(d[k] || 0));
      merged[k] = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    return merged;
  }
  const allKeys = new Set();
  Object.values(raw).forEach((d) => Object.keys(d || {}).forEach((k) => allKeys.add(k)));
  const merged = {};
  for (const k of allKeys) {
    let weighted = 0;
    for (const [src, dist] of Object.entries(raw || {})) {
      weighted += (Number(dist?.[k]) || 0) * (Number(totals?.[src]) || 0);
    }
    merged[k] = weighted / sumWeights;
  }
  return merged;
}

function fuseSingleAxis(existing, incoming, sourceTag, weight) {
  const raw = { ...(existing?._raw || {}) };
  raw[sourceTag] = _stripMeta(incoming);
  const totals = { ...(existing?._totals || {}) };
  totals[sourceTag] = Number(weight) || 0;
  const merged = mergeDistributionFromRaw(raw, totals);
  return {
    ...merged,
    _raw:        raw,
    _totals:     totals,
    _sources:    Object.keys(raw),
    _updated_at: new Date().toISOString(),
  };
}

function fuseLocationAxis(existing, incoming, sourceTag, weight) {
  // location_distribution tiene { countries, cities } — fusionamos cada una por separado
  const existingCountries = existing?.countries || {};
  const existingCities    = existing?.cities    || {};
  return {
    countries: fuseSingleAxis(existingCountries, incoming?.countries || {}, sourceTag, weight),
    cities:    fuseSingleAxis(existingCities,    incoming?.cities    || {}, sourceTag, weight),
  };
}

async function persistAudienceDemographics(brandContainerId, sourceTag, data) {
  if (!brandContainerId || !data) return 0;

  const { data: personas, error: readErr } = await supabase
    .from("audience_personas")
    .select("id, real_age_distribution, real_gender_distribution, real_location_distribution")
    .eq("brand_container_id", brandContainerId);

  if (readErr) {
    console.warn(`[audience-demographics] read personas failed: ${readErr.message}`);
    return 0;
  }
  if (!personas?.length) {
    console.warn(`[audience-demographics] brand ${brandContainerId} no tiene audience_personas — saltando persist`);
    return 0;
  }

  const weight = Number(data.total_audience) || 0;
  let updated = 0;

  for (const p of personas) {
    const fusedAge      = fuseSingleAxis(p.real_age_distribution,      data.age_distribution,      sourceTag, weight);
    const fusedGender   = fuseSingleAxis(p.real_gender_distribution,   data.gender_distribution,   sourceTag, weight);
    const fusedLocation = fuseLocationAxis(p.real_location_distribution, data.location_distribution, sourceTag, weight);

    const { error: updErr } = await supabase
      .from("audience_personas")
      .update({
        real_age_distribution:      fusedAge,
        real_gender_distribution:   fusedGender,
        real_location_distribution: fusedLocation,
        updated_at:                 new Date().toISOString(),
      })
      .eq("id", p.id);

    if (updErr) {
      console.warn(`[audience-demographics] update persona ${p.id} failed: ${updErr.message}`);
    } else {
      updated++;
    }
  }
  return updated;
}

// ── brand_audience_heatmap: agregación de engagement por hora/día ───────────
// Calcula engagement promedio por hora (0-23) y día (0-6) por network desde
// brand_posts propios de los últimos 90 días. Pobla brand_audience_heatmap.
// Sin LLM — pura agregación temporal de métricas.

async function runHeatmapCompute(brandContainerId, organizationId) {
  // Ventana primaria 365 días; si no hay posts recientes, fallback a TODOS
  // los posts disponibles (los patrones hour-of-day y day-of-week siguen
  // siendo válidos sin importar la fecha absoluta).
  const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString();

  let { data: posts } = await supabase
    .from("brand_posts")
    .select("network, captured_at, metrics")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", false)
    .gte("captured_at", cutoff);

  if (!posts?.length) {
    const fb = await supabase
      .from("brand_posts")
      .select("network, captured_at, metrics")
      .eq("brand_container_id", brandContainerId)
      .eq("is_competitor", false);
    posts = fb.data || [];
  }
  if (!posts?.length) return { networks: 0, posts: 0 };

  const byNetwork = {};
  for (const p of posts) {
    const net = p.network || "unknown";
    if (!byNetwork[net]) {
      byNetwork[net] = {
        hour:     Array(24).fill(0),
        day:      Array(7).fill(0),
        counts_h: Array(24).fill(0),
        counts_d: Array(7).fill(0),
      };
    }
    const eng  = (p.metrics?.likes || 0) + (p.metrics?.comments || 0) + (p.metrics?.shares || 0);
    const date = new Date(p.captured_at);
    const h = date.getUTCHours();
    const d = date.getUTCDay();
    byNetwork[net].hour[h] += eng;
    byNetwork[net].day[d]  += eng;
    byNetwork[net].counts_h[h]++;
    byNetwork[net].counts_d[d]++;
  }

  let networks = 0;
  for (const [net, data] of Object.entries(byNetwork)) {
    const hourEngagement = {};
    let bestHour = 0, bestHourEng = -1;
    for (let h = 0; h < 24; h++) {
      const avg = data.counts_h[h] > 0 ? data.hour[h] / data.counts_h[h] : 0;
      hourEngagement[String(h)] = Number(avg.toFixed(2));
      if (avg > bestHourEng) { bestHourEng = avg; bestHour = h; }
    }
    const dayEngagement = {};
    let bestDay = 0, bestDayEng = -1;
    for (let d = 0; d < 7; d++) {
      const avg = data.counts_d[d] > 0 ? data.day[d] / data.counts_d[d] : 0;
      dayEngagement[String(d)] = Number(avg.toFixed(2));
      if (avg > bestDayEng) { bestDayEng = avg; bestDay = d; }
    }

    const row = {
      brand_container_id: brandContainerId,
      organization_id:    organizationId,
      platform:           net,
      hour_engagement:    hourEngagement,
      day_engagement:     dayEngagement,
      best_hour:          bestHour,
      best_day:           bestDay,
      computed_at:        new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("brand_audience_heatmap")
      .select("id")
      .eq("brand_container_id", brandContainerId)
      .eq("platform", net)
      .maybeSingle();

    if (existing?.id) {
      await supabase.from("brand_audience_heatmap").update(row).eq("id", existing.id);
    } else {
      await supabase.from("brand_audience_heatmap").insert(row);
    }
    networks++;
  }
  return { networks, posts: posts.length };
}

// ── Meta Ad Library: sync de ads de competidores a competitor_ads ───────────
// Por cada intelligence_entity con domain='social' y is_competitor implícito,
// busca ads en Meta Ad Library y los UPSERTea en competitor_ads.
// Idempotente por ad_archive_id: ads previos solo actualizan last_seen_at + captured_at.

// Mapeo nombres comunes (ES + EN) → códigos ISO 2-letras de Meta Ad Library.
// Mantener corto: solo países LATAM + principales mercados que Arde y futuros
// usuarios típicos targetean. Si llega otro nombre, fallback a CO.
const COUNTRY_NAME_TO_ISO = {
  COLOMBIA: "CO", MEXICO: "MX", "MÉXICO": "MX",
  ARGENTINA: "AR", PERU: "PE", "PERÚ": "PE",
  CHILE: "CL", ECUADOR: "EC", VENEZUELA: "VE",
  "ESTADOS UNIDOS": "US", "UNITED STATES": "US", USA: "US",
  "ESPAÑA": "ES", ESPANA: "ES", SPAIN: "ES",
  BRASIL: "BR", BRAZIL: "BR",
  PANAMA: "PA", "PANAMÁ": "PA", "REPUBLICA DOMINICANA": "DO", "REPÚBLICA DOMINICANA": "DO",
  GUATEMALA: "GT", "COSTA RICA": "CR", URUGUAY: "UY", PARAGUAY: "PY",
  BOLIVIA: "BO", "PUERTO RICO": "PR", HONDURAS: "HN", "EL SALVADOR": "SV",
};

function _normalizeCountry(input) {
  const s = String(input || "").trim().toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) return s;
  return COUNTRY_NAME_TO_ISO[s] || "CO";
}

async function runMetaAdLibrarySync(brandContainerId, organizationId) {
  // Resolver país desde brand_containers.mercado_objetivo (default CO)
  const { data: bc } = await supabase
    .from("brand_containers")
    .select("mercado_objetivo")
    .eq("id", brandContainerId)
    .maybeSingle();
  const country = _normalizeCountry(bc?.mercado_objetivo?.[0]);

  // Competidores: intelligence_entities domain='social' active=true
  const { data: competitors } = await supabase
    .from("intelligence_entities")
    .select("id, name, target_identifier, metadata")
    .eq("brand_container_id", brandContainerId)
    .eq("domain", "social")
    .eq("is_active", true);

  if (!competitors?.length) {
    return { searched: 0, skipped_competitors: 0, inserted: 0, updated: 0, filtered_out: 0 };
  }

  let searched = 0, skippedComps = 0, inserted = 0, updated = 0, filteredOut = 0;
  for (const comp of competitors) {
    const fbPageId = comp.metadata?.fb_page_id || null;
    const params = fbPageId
      ? { searchPageIds: [String(fbPageId)] }
      : { searchTerms:   comp.name };

    let result;
    try {
      result = await getMetaAdLibrary({
        brandContainerId,
        organizationId,
        country,
        limit: 50,
        ...params,
      });
    } catch (e) {
      // Plan B: API bloqueada por permission o no disponible → Playwright public scraper
      const isPermErr = e.needsReauth || /permission|access|capability/i.test(e.message || "");
      if (!isPermErr) {
        console.warn(`[meta-ad-library] ${comp.name} API falló (no fallback): ${e.message}`);
        skippedComps++;
        continue;
      }
      // El fallback Playwright `scrapeAdLibraryPublic` fue removido en la
      // migración Apify del 2026-04-28. Cuando la API de Meta falla por
      // permission/access, no hay backup local — registrar el error y skip
      // hasta que se resuelva una de:
      //   - permiso `ads_read` aprobado en Meta App Review
      //   - actor de Apify para Meta Ad Library configurado
      // (tracked en docs/task/OPS-006).
      {
        console.warn(`[meta-ad-library] ${comp.name} skip — API permission denied y sin fallback (post-Apify): ${e.message}`);
        skippedComps++;
        continue;
      }
    }
    searched++;

    // Si usamos search_terms, filtrar por page_name que CONTENGA la entity.name
    // (case-insensitive, sin diacríticos). Captura "Red Bull Colombia",
    // "Red Bull LATAM", etc. sin perderlos por exactitud excesiva.
    let ads = result.ads;
    if (!fbPageId) {
      const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
      const want = norm(comp.name);
      ads = result.ads.filter((a) => norm(a.page_name).includes(want));
      filteredOut += result.ads.length - ads.length;
    }

    for (const ad of ads) {
      const r = await persistCompetitorAd(brandContainerId, organizationId, comp.id, ad, { source: "api" });
      if (r.action === "inserted") inserted++;
      else if (r.action === "updated") updated++;
    }

    await delay(jitter(800)); // pausa entre competidores
  }

  return { searched, skipped_competitors: skippedComps, inserted, updated, filtered_out: filteredOut };
}

async function persistCompetitorAd(brandContainerId, organizationId, entityId, ad, opts = {}) {
  const now = new Date().toISOString();
  const copyText = [...ad.creative_bodies, ...ad.creative_titles, ...ad.creative_descs]
    .filter(Boolean).join("\n").slice(0, 5000);

  const targeting = {
    publisher_platforms: ad.publisher_platforms,
    languages:           ad.languages,
    bylines:             ad.bylines,
    target_ages:         ad.target_ages,
    target_gender:       ad.target_gender,
    target_locations:    ad.target_locations,
    eu_total_reach:      ad.eu_total_reach,
  };

  const row = {
    brand_container_id: brandContainerId,
    organization_id:    organizationId,
    entity_id:          entityId,
    platform:           "meta",
    ad_archive_id:      ad.ad_archive_id,
    creative_url:       ad.snapshot_url,
    copy_text:          copyText || null,
    first_seen_at:      ad.delivery_start || ad.creation_time || now,
    last_seen_at:       ad.delivery_stop || now,
    targeting,
    captured_at:        now,
    scope:              "brand",
    metadata: {
      page_id:           ad.page_id,
      page_name:         ad.page_name,
      currency:          ad.currency,
      creative_captions: ad.creative_captions,
      source:            opts.source || "api",
      scraper_version:   "1.0",
    },
  };

  const { data: existing } = await supabase
    .from("competitor_ads")
    .select("id")
    .eq("brand_container_id", brandContainerId)
    .eq("ad_archive_id", ad.ad_archive_id)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supabase
      .from("competitor_ads")
      .update({ last_seen_at: row.last_seen_at, captured_at: now, targeting })
      .eq("id", existing.id);
    if (error) console.warn(`[meta-ad-library] update ${ad.ad_archive_id}: ${error.message}`);
    return { action: error ? "error" : "updated" };
  } else {
    const { error } = await supabase.from("competitor_ads").insert(row);
    if (error) {
      console.warn(`[meta-ad-library] insert ${ad.ad_archive_id}: ${error.message}`);
      return { action: "error" };
    }
    return { action: "inserted" };
  }
}

// ── Persistencia de audience_segments (Meta Ads custom + saved audiences) ──
// UPSERT manual por (brand_container_id, platform, external_audience_id) — no
// hay unique constraint en la tabla. Marca como source='imported'.

async function persistAudienceSegments(brandContainerId, organizationId, result) {
  if (!brandContainerId || !organizationId || !result) return 0;

  const allSegments = [
    ...(result.custom_audiences || []).map((s) => ({ ...s, _kind: "custom" })),
    ...(result.saved_audiences  || []).map((s) => ({ ...s, _kind: "saved"  })),
  ];

  if (!allSegments.length) return 0;

  let upserted = 0;
  for (const seg of allSegments) {
    const baseRow = {
      organization_id:        organizationId,
      brand_container_id:     brandContainerId,
      platform:               "meta",
      external_audience_id:   seg.external_audience_id,
      external_audience_name: seg.external_audience_name,
      external_audience_type: seg.external_audience_type,
      estimated_size:         seg.estimated_size,
      size_lower_bound:       seg.size_lower_bound,
      size_upper_bound:       seg.size_upper_bound,
      source:                 "imported",
      status:                 "active",
      last_synced_at:         new Date().toISOString(),
      sync_error:             null,
      // Campos propios de saved_audiences (custom no los tiene)
      age_range:              seg.age_range || {},
      genders:                seg.genders || [],
      locations:              seg.locations || [],
      interests:              seg.interests || [],
      behaviors:              seg.behaviors || [],
      languages:              seg.languages || [],
      custom_params:          seg.raw_targeting || {},
      updated_at:             new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("audience_segments")
      .select("id")
      .eq("brand_container_id", brandContainerId)
      .eq("platform",           "meta")
      .eq("external_audience_id", seg.external_audience_id)
      .maybeSingle();

    if (existing?.id) {
      const { error: updErr } = await supabase
        .from("audience_segments")
        .update(baseRow)
        .eq("id", existing.id);
      if (updErr) console.warn(`[ads-audiences] update ${seg.external_audience_id} falló: ${updErr.message}`);
      else upserted++;
    } else {
      const { error: insErr } = await supabase
        .from("audience_segments")
        .insert(baseRow);
      if (insErr) console.warn(`[ads-audiences] insert ${seg.external_audience_id} falló: ${insErr.message}`);
      else upserted++;
    }
  }
  return upserted;
}

/**
 * Posts PROPIOS ya guardados de este container, indexados por network|post_id.
 *
 * BLINDAJE: antes esto se resolvia con getKnownPostIds(entityId) y todos los
 * updates empataban por `.eq("entity_id", ...)`. Una fila con entity_id en NULL
 * -las que dejaron otros writers- no podia empatar NUNCA: el sensor pasaba por
 * encima de ella cada ciclo sin verla, y ni sus metricas ni su miniatura se
 * refrescaban jamas. El ancla correcta es la MARCA, no la entidad.
 *
 * Ademas consulta EXACTAMENTE los post_id del lote en vez del "ultimos 500":
 * en un container que acumula posts de competencia, los propios se salian de
 * esa ventana y volvian a intentarse como nuevos.
 */
async function getOwnPostsGuardados(brandContainerId, postIds) {
  const mapa = new Map();
  const ids = [...new Set(postIds.filter(Boolean).map(String))];
  if (!ids.length || !brandContainerId) return mapa;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("brand_posts")
      .select("id, post_id, network, media_assets, entity_id")
      .eq("brand_container_id", brandContainerId)
      .in("post_id", ids.slice(i, i + 200));
    if (error) { console.warn("scraper [own-posts pre-check]: " + error.message); continue; }
    for (const r of data || []) mapa.set(r.network + "|" + r.post_id, r);
  }
  return mapa;
}

// ── Persistencia de posts propios (Meta page) en brand_posts ────────────────
// Se ancla a la MARCA (brand_container_id + network + post_id), no a la
// entidad: ver getOwnPostsGuardados.
async function persistOwnPosts(posts, brandContainerId, entityId) {
  if (!posts.length) return 0;

  const guardados = await getOwnPostsGuardados(brandContainerId, posts.map((p) => p.id));
  const clave = (p) => p.platform + "|" + p.id;

  // Update silencioso de métricas en posts ya conocidos
  for (const post of posts) {
    const previo = guardados.get(clave(post));
    if (previo) {
      // Rescate de imagen: los posts propios de IG se guardaron sin foto porque
      // al Graph nunca se le pedía media_url. Ahora que llega, se archiva la que
      // siga viva en el CDN y se manda a describir — es la única ventana para
      // recuperarlas (las URLs firmadas expiran en días).
      const rescatado = await _rescueOwnThumb(previo, post, brandContainerId);
      await supabase.from("brand_posts")
        .update({
          metrics:    post.metrics || {},
          // hashtags: backfill de posts propios existentes en cada ciclo (DATA-002).
          // Deterministico desde el mismo texto -> idempotente.
          ...(Array.isArray(post.hashtags) ? { hashtags: post.hashtags } : {}),
          // followers_snapshot: backfill para que compute_penetration_proxy deje de dar 0 en IG/FB.
          ...(post.followers != null ? { followers_snapshot: post.followers } : {}),
          ...(rescatado ? { media_assets: rescatado.media_assets } : {}),
          updated_at: new Date().toISOString(),
          // Reanclaje: si la fila venia huerfana, queda visible tambien para
          // lo que siga consultando por entidad.
          ...(previo.entity_id ? {} : { entity_id: entityId }),
        })
        .eq("id", previo.id);
      if (rescatado) await triggerMediaAnalysis(rescatado.id);
    }
  }

  const newPosts = posts.filter((p) => !guardados.has(clave(p)));
  if (!newPosts.length) return 0;

  let inserted = 0;
  for (const post of newPosts) {
    const row = {
      brand_container_id: brandContainerId,
      entity_id:          entityId,
      network:            post.platform,
      profile_handle:     null,
      post_id:            post.id,
      content:            post.text || post.caption || "",
      hashtags:           Array.isArray(post.hashtags) ? post.hashtags : [],
      media_assets:       await _ownPostAssets(post, brandContainerId),
      metrics:            post.metrics || {},
      followers_snapshot: post.followers ?? null,   // penetración (IG/FB): antes quedaba NULL
      is_competitor:      false,
      post_source:        "own",
      captured_at:        post.created_at,
    };

    // Intento 1: upsert por constraint (si existe el unique index)
    let savedBrandPostId = null;
    const { data: upsertData, error: upsertErr } = await supabase
      .from("brand_posts")
      .upsert(row, { onConflict: "entity_id,post_id", ignoreDuplicates: false })
      .select("id")
      .maybeSingle();
    let err = upsertErr;
    savedBrandPostId = upsertData?.id;

    // Fallback: el unique index de brand_posts es parcial (WHERE post_id IS NOT NULL),
    // Postgres rechaza ON CONFLICT por inferencia. Hacemos INSERT simple — ya pre-filtramos
    // por knownIds, así que no habrá duplicados.
    if (err?.message?.includes("no unique or exclusion constraint")) {
      const { data: insertData, error: insertErr } = await supabase
        .from("brand_posts")
        .insert(row)
        .select("id")
        .maybeSingle();
      err = insertErr;
      savedBrandPostId = insertData?.id;
    }

    if (err) {
      console.warn(`scraper [own-posts]: insert ${post.id} — ${err.message}`);
      continue;
    }

    // ── trend_topics + content-analysis para posts propios (igual que competidores)
    const content = post.text || post.caption || "";
    if (content.length > 20) {
      await persistTrendTopics(content, brandContainerId, entityId, post.platform || "own", post.created_at)
        .catch((e) => console.warn(`scraper [own-posts]: trend_topics — ${e.message}`));
    }
    if (savedBrandPostId) {
      await triggerMediaAnalysis(savedBrandPostId);
    }

    inserted++;
  }

  return inserted;
}


// ── B2 — Enriquecer top posts con recent_comments (sólo IG) ──────────────────
// Budget: top 3 posts por engagement, max 20 comments cada uno, ~30s Playwright/post.
// Se ejecuta secuencial para no saturar el proxy Decodo.
async function _enrichTopPostsWithIgComments(posts, entity) {
  const top = posts
    .map(p => ({ ...p, _eng: (p.like_count || 0) + (p.comment_count || 0) * 3 }))
    .sort((a, b) => b._eng - a._eng)
    .slice(0, 2);   // top-2 por engagement (era 3 — reducido para amabilidad con proxy)

  for (const post of top) {
    const shortcode = post.url?.match(/\/p\/([\w-]+)\//)?.[1]
                   || post.url?.match(/\/reel\/([\w-]+)\//)?.[1];
    if (!shortcode) continue;

    try {
      const comments = await scrapeInstagramPostComments(shortcode, 20);
      if (!comments?.length) {
        console.log(`scraper [ig-comments]: ${entity?.name} post ${shortcode} — 0 comments capturados`);
        continue;
      }

      // Merge recent_comments en enrichment existente
      const { data: row } = await supabase
        .from("brand_posts")
        .select("id, enrichment")
        .eq("entity_id", entity.id)
        .eq("post_id", post.external_id)
        .maybeSingle();

      if (row?.id) {
        const newEnrichment = {
          ...(row.enrichment || {}),
          recent_comments: comments,
          recent_comments_fetched_at: new Date().toISOString(),
        };
        await supabase
          .from("brand_posts")
          .update({ enrichment: newEnrichment })
          .eq("id", row.id);

        console.log(
          `scraper [ig-comments]: ${entity?.name} post ${shortcode} — ${comments.length} comments guardados`
        );
      }
    } catch (e) {
      console.warn(`scraper [ig-comments]: ${entity?.name} post ${shortcode} — ${e.message}`);
    }

    // Pausa anti-flood entre posts (proxy residencial necesita respiro)
    await delay(jitter(8000));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APIFY INTEGRATION (sustituye scrapers Playwright locales)
// ════════════════════════════════════════════════════════════════════════════
import { runActor as _apifyRunActor, runActorBatch as _apifyRunActorBatch, detectPlatform as _apifyDetectPlatform } from "../lib/apify.client.js";

async function _scrapeViaApify(network, handle, organizationId) {
  if (!organizationId) {
    console.warn(`scraper [apify]: organizationId vacío para handle="${handle}", network="${network}" — skip`);
    return [];
  }
  try {
    const r = await _apifyRunActor({ organizationId, urlOrHandle: handle, platform: network });
    return (r.items || []).map(it => _apifyToLegacyPost(network, it)).filter(Boolean);
  } catch (e) {
    if (e.code === "INSUFFICIENT_CREDITS" || e.code === "DAILY_CAP_REACHED") {
      console.warn(`scraper [apify]: ${e.code} para org=${organizationId} (${e.message}) — skip`);
    } else {
      console.warn(`scraper [apify]: error en ${network}/${handle} — ${e.message}`);
    }
    return [];
  }
}

/**
 * Batch: ejecuta 1 run de Apify con N handles del mismo platform y organizationId.
 * Devuelve Map<handle, post[]> ya en formato legacy. Usado por runCompetitorScraper
 * para evitar N runs seriados cuando varios triggers comparten plataforma+org.
 */
/**
 * Pre-pass del ciclo: agrupa los triggers social por (organizationId, platform)
 * y ejecuta 1 batch de Apify por grupo, en paralelo entre grupos. Devuelve
 * Map<trigger_id, posts[]> que el loop principal consume sin re-scrapear.
 *
 * Resolución de platform por trigger:
 *   1) entity.metadata.platform (lo normal)
 *   2) detectPlatform(rawHandle) si es URL
 *   3) fallback 'instagram' (legacy, solo handles puros sin metadata)
 *
 * Resolución de handle: misma normalización que el loop legacy (URL → path).
 */
async function _runSocialBatchPass(socialTriggers) {
  const postsByTrigger = new Map();
  const batchOkTriggers = new Set();
  if (!socialTriggers || !socialTriggers.length) return { postsByTrigger, batchOkTriggers };

  // Agrupar triggers por (organization_id, platform). Cada grupo = 1 batch run.
  // groupKey -> { organizationId, platform, items: [{ trigger, entity, handle }] }
  const groups = new Map();

  for (const trigger of socialTriggers) {
    const entity = trigger.intelligence_entities;
    if (!entity) continue;
    const rawHandle = entity.target_identifier;
    if (!rawHandle) continue;

    // Normalizar handle (igual lógica que el loop legacy)
    let handle = rawHandle;
    try {
      if (rawHandle.startsWith("http://") || rawHandle.startsWith("https://")) {
        const url  = new URL(rawHandle);
        const path = url.pathname.replace(/^\/+|\/+$/g, "");
        handle = path.replace(/^@/, "");
      } else {
        handle = rawHandle.replace(/^@+/, "");
      }
    } catch { /* mantener rawHandle */ }

    // Resolver platform
    let platform = entity.metadata?.platform;
    const isUrl  = rawHandle.startsWith("http://") || rawHandle.startsWith("https://");
    if (!platform && isUrl) {
      try { platform = await _apifyDetectPlatform(rawHandle); }
      catch (e) { console.warn(`scraper [social/batch]: detectPlatform falló para "${rawHandle}" — ${e.message}`); }
    }
    if (!platform) platform = "instagram";

    const orgId = entity.organization_id;
    if (!orgId) {
      console.warn(`scraper [social/batch]: ${entity.name} sin organization_id — skip`);
      continue;
    }

    const key = `${orgId}::${platform}`;
    if (!groups.has(key)) groups.set(key, { organizationId: orgId, platform, items: [] });
    groups.get(key).items.push({ trigger, entity, handle });
  }

  if (!groups.size) return { postsByTrigger, batchOkTriggers };
  console.log(`scraper: batch pre-pass — ${groups.size} grupo(s) (org × platform)`);

  // Ejecutar todos los grupos en PARALELO. Cada grupo = 1 run Apify.
  await Promise.all(
    [...groups.values()].map(async (g) => {
      const handles = g.items.map(it => it.handle);
      let byHandle, ok = true;
      try {
        byHandle = await _scrapeViaApifyBatch(g.platform, handles, g.organizationId);
      } catch (e) {
        // _scrapeViaApifyBatch ya loguea; este catch es defensa extra.
        ok = false;
        byHandle = new Map();
      }
      // _scrapeViaApifyBatch devuelve Map vacío en error — distinguimos
      // entre "Map vacío por error" y "Map vacío porque no había posts" mirando
      // si HAY al menos 1 trigger con posts en este grupo.
      const totalItems = [...byHandle.values()].reduce((s, arr) => s + (arr?.length || 0), 0);
      if (totalItems === 0 && ok) {
        // Batch terminó OK pero 0 items totales — probable timeout silencioso o
        // todos los handles muertos. NO marcamos como ok para evitar auto-deact masivo.
        ok = false;
      }

      const byHandleLC = new Map();
      for (const [h, posts] of byHandle.entries()) {
        byHandleLC.set(String(h).toLowerCase(), posts);
      }
      for (const { trigger, handle } of g.items) {
        const posts = byHandleLC.get(String(handle).toLowerCase()) || [];
        postsByTrigger.set(trigger.id, posts);
        if (ok) batchOkTriggers.add(trigger.id);
      }
    })
  );

  return { postsByTrigger, batchOkTriggers };
}

// Alerta cuando Apify bloquea la cuenta (limite mensual excedido / 403).
// Antes esto fallaba en SILENCIO (marcaba success con 0 posts) -> Vera ciega sin avisar.
//
// DESTINO = developer_notifications (centro de notificaciones DEV in-app del portal
// /dev, por-usuario). NUNCA al feed org_notifications del CLIENTE, NUNCA a push de
// dispositivo (ntfy). Regla del usuario: los errores de sistema de AISC viven DENTRO
// de AISC (in-app); el push a dispositivos es solo para sensores de negocio, no para
// fallas del sistema. El hard-limit de Apify es infra/billing interno de ARDE.
//
// THROTTLE PERSISTENTE via external_api_cache: el throttle viejo era solo una var de
// modulo, asi que CADA restart/deploy lo reseteaba a 0 y re-disparaba al instante (por
// eso el spam pese al "limite 1/12h"). Ahora la ventana sobrevive reinicios. La var de
// modulo queda como fast-path para no tocar la DB en cada 403 del mismo proceso.
const APIFY_BLOCK_THROTTLE_MS = 12 * 3_600_000; // 1 alerta / 12h
const APIFY_BLOCK_CACHE_KEY = "ops_alert:apify_account_blocked";
let _lastApifyBlockAlert = 0;
async function _alertApifyAccountBlocked(organizationId, rawMsg) {
  const now = Date.now();
  // Fast-path en memoria (evita ir a la DB en cada 403 del mismo proceso).
  if (now - _lastApifyBlockAlert < APIFY_BLOCK_THROTTLE_MS) return;

  // Throttle persistente: sobrevive restarts/deploys.
  try {
    const { data: row } = await supabase
      .from("external_api_cache")
      .select("expires_at")
      .eq("cache_key", APIFY_BLOCK_CACHE_KEY)
      .maybeSingle();
    if (row?.expires_at && new Date(row.expires_at).getTime() > now) {
      _lastApifyBlockAlert = now; // resync memoria con la ventana persistida
      return;
    }
  } catch (e) {
    console.warn(`scraper: throttle-check apify-block fallo (sigo) - ${e.message}`);
  }

  _lastApifyBlockAlert = now;
  const msg = String(rawMsg || "").replace(/\s+/g, " ").slice(0, 200);

  // 1) Notificar a los DEVELOPERS in-app (portal /dev), 1 fila por dev. No cliente, no push.
  try {
    const { data: devs, error: devErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_developer", true);
    if (devErr) throw devErr;
    const rows = (devs || []).map((d) => ({
      recipient_user_id: d.id,
      severity: "alert",
      title: "Apify bloqueado (hard-limit mensual)",
      message: `Los scrapers estan bloqueados por el limite mensual de la cuenta Apify. Vera esta sin data fresca de redes/competencia hasta subir el limite en la cuenta de Apify. Detalle: ${msg}`,
    }));
    if (rows.length) {
      await supabase.from("developer_notifications").insert(rows);
      console.error(`scraper: developer_notifications creada (${rows.length} dev) — Apify hard-limit. Subir limite en la cuenta Apify.`);
    } else {
      console.error("scraper: Apify hard-limit pero no hay developers para notificar (subir limite en Apify).");
    }
  } catch (e) {
    console.warn(`scraper: no se pudo crear developer_notifications apify-block - ${e.message}`);
  }

  // 2) Persistir la ventana de throttle (12h) para sobrevivir restarts.
  try {
    await supabase.from("external_api_cache").upsert({
      cache_key: APIFY_BLOCK_CACHE_KEY,
      provider: "ops",
      payload: { source: "apify", code: "account_blocked", last_msg: msg, org: organizationId || null },
      expires_at: new Date(now + APIFY_BLOCK_THROTTLE_MS).toISOString(),
    }, { onConflict: "cache_key" });
  } catch (e) {
    console.warn(`scraper: persist throttle apify-block fallo - ${e.message}`);
  }
}

async function _scrapeViaApifyBatch(network, handles, organizationId) {
  if (!organizationId) {
    console.warn(`scraper [apify-batch]: organizationId vacío para network="${network}" — skip`);
    return new Map();
  }
  if (!Array.isArray(handles) || !handles.length) return new Map();
  try {
    const r = await _apifyRunActorBatch({ organizationId, platform: network, handles });
    const out = new Map();
    for (const [h, items] of Object.entries(r.itemsByHandle || {})) {
      out.set(h, (items || []).map(it => _apifyToLegacyPost(network, it)).filter(Boolean));
    }
    console.log(`scraper [apify-batch]: ${network} × ${handles.length} handles → ${r.totalItems} items, $${r.usdCost?.toFixed(4)} (${r.credits} cr)`);
    return out;
  } catch (e) {
    if (e.code === "INSUFFICIENT_CREDITS" || e.code === "DAILY_CAP_REACHED") {
      console.warn(`scraper [apify-batch]: ${e.code} para org=${organizationId} (${e.message}) — skip batch`);
    } else if (/platform-feature-disabled|usage hard limit|hard limit exceeded|\b403\b/i.test(e.message || "")) {
      console.error(`scraper [apify-batch]: APIFY ACCOUNT BLOQUEADO (${network}) — ${String(e.message).replace(/\s+/g, " ").slice(0, 160)}`);
      await _alertApifyAccountBlocked(organizationId, e.message);
    } else {
      console.warn(`scraper [apify-batch]: error en ${network} [${handles.join(",")}] — ${e.message}`);
    }
    return new Map();
  }
}

function _apifyToLegacyPost(network, it) {
  if (!it) return null;
  if (network === "tiktok") return {
    external_id: String(it.id), network: "tiktok",
    content: it.text || "",
    like_count: it.diggCount || 0, comment_count: it.commentCount || 0,
    share_count: it.shareCount || 0, play_count: it.playCount || 0, saved_count: it.collectCount || 0,
    hashtags: (it.hashtags || []).map(h => typeof h === "string" ? h : h.name).filter(Boolean),
    mentions: it.mentions || [],
    cover_image: it.videoMeta?.coverUrl, video_url: it.webVideoUrl,
    is_ad: !!it.isAd, is_sponsored: !!it.isSponsored, is_video: true,
    region: it.region || it.authorMeta?.region,
    music: it.musicMeta ? { title: it.musicMeta.title, author_name: it.musicMeta.authorName, is_original: !!it.musicMeta.original } : null,
    author: it.authorMeta ? { username: it.authorMeta.uniqueId, followers_count: it.authorMeta.fans, verified: !!it.authorMeta.verified } : null,
    timestamp: it.createTimeISO || new Date().toISOString(),
  };
  if (network === "instagram") return {
    external_id: String(it.id || it.shortCode), network: "instagram",
    content: it.caption || "",
    like_count: it.likesCount || 0, comment_count: it.commentsCount || 0,
    video_view_count: it.videoViewCount || 0, play_count: it.videoPlayCount || 0,
    hashtags: it.hashtags || [], mentions: it.mentions || [],
    tagged_users: (it.taggedUsers || []).map(u => typeof u === "string" ? u : (u.username || u.full_name)).filter(Boolean),
    display_url: it.displayUrl, video_url: it.videoUrl, images: it.images || [],
    accessibility_caption: it.alt, is_video: it.type === "Video",
    // Apify IG/FB scrapers no exponen followers count por post (solo en
    // endpoint /profile separado, requeriría otro run). TT/YT/X sí lo traen.
    // Por ahora author sin followers — engagement_rate quedará 0 en IG.
    author: { username: it.ownerUsername, verified: !!it.ownerVerified },
    // Pasamos latestComments adjunto al post para que persistNewPosts los persista en brand_post_comments
    _latest_comments: (it.latestComments || []).slice(0, 10),
    timestamp: it.timestamp || new Date().toISOString(),
  };
  if (network === "youtube") return {
    external_id: String(it.id), network: "youtube",
    content: it.title || "",
    like_count: it.likes || 0, comment_count: it.commentsCount || 0, play_count: it.viewCount || 0,
    thumbnail_url: it.thumbnailUrl, is_short: false,
    author: { username: it.channelUsername, followers_count: it.numberOfSubscribers, verified: !!it.isChannelVerified },
    timestamp: it.date || new Date().toISOString(),
  };
  if (network === "x") return {
    external_id: String(it.id), network: "x",
    content: it.text || "",
    like_count: it.likeCount || 0, comment_count: it.replyCount || 0,
    share_count: it.retweetCount || 0, play_count: it.viewCount || 0,
    saved_count: it.bookmarkCount || 0,
    hashtags: (it.entities?.hashtags || []).map(h => h.text),
    mentions: (it.entities?.user_mentions || []).map(m => m.screen_name),
    author: it.author ? { username: it.author.userName, followers_count: it.author.followers, verified: !!it.author.isVerified } : null,
    timestamp: it.createdAt || new Date().toISOString(),
  };
  if (network === "facebook") return {
    external_id: String(it.postId), network: "facebook",
    content: it.text || "",
    like_count: it.likes || 0, comment_count: it.comments || 0, share_count: it.shares || 0,
    is_video: !!it.isVideo,
    timestamp: it.time || new Date().toISOString(),
  };
  return null;
}

async function _persistInlineComments(posts, entity) {
  if (!posts || !posts.length) return 0;
  const rows = [];
  const externalIds = posts.map(p => p.external_id).filter(Boolean);
  if (!externalIds.length) return 0;
  const { data: bpRows } = await supabase
    .from("brand_posts")
    .select("id, post_id")
    .eq("entity_id", entity.id)
    .in("post_id", externalIds);
  const idMap = Object.fromEntries((bpRows || []).map(r => [r.post_id, r.id]));

  for (const p of posts) {
    const brandPostId = idMap[p.external_id];
    if (!brandPostId) continue;
    const comments = p._latest_comments || [];
    for (const c of comments) {
      if (!c.id || !c.text) continue;
      rows.push({
        brand_post_id: brandPostId,
        network: p.network,
        external_comment_id: String(c.id),
        author_handle: c.ownerUsername,
        author_pic_url: c.ownerProfilePicUrl,
        content: c.text,
        posted_at: c.timestamp ? (typeof c.timestamp === "number" ? new Date(c.timestamp * 1000).toISOString() : new Date(c.timestamp).toISOString()) : null,
        metrics: { likes: c.likesCount || 0, replies_count: c.repliesCount || 0 },
        brand_container_id: entity.brand_container_id,
        organization_id: entity.organization_id,
        source: "apify_inline:" + p.network,
      });
    }
  }
  if (!rows.length) return 0;
  const { error } = await supabase.from("brand_post_comments")
    .upsert(rows, { onConflict: "network,external_comment_id", ignoreDuplicates: true });
  if (error) console.warn("scraper [comments-upsert]: " + error.message);
  return rows.length;
}

/**
 * media_assets de un post PROPIO (Meta IG/FB), con la miniatura archivada.
 *
 * Antes se guardaba un array crudo `[{url,type,permalink}]` que ningun lector
 * consumia — el resolver de miniaturas solo busca claves de objeto, asi que
 * esas imagenes nunca se pintaban. Ahora es un objeto de la misma forma que el
 * resto del sistema, y la portada se copia a R2 al capturar (las URLs de Meta
 * tambien caducan). Fail-open: sin archivo, queda la original.
 */
async function _ownPostAssets(post, brandContainerId) {
  const assets = {};
  if (post.permalink) assets.permalink = post.permalink;
  if (post.media_type) assets.media_type = post.media_type;
  if (!post.image) return Object.keys(assets).length ? assets : null;
  assets.display_url = post.image;
  // Las piezas del carrusel: el describer las manda en UNA sola request.
  if (Array.isArray(post.images) && post.images.length > 1) assets.images = post.images;
  const archived = await archiveThumb({
    mediaAssets:      assets,
    brandContainerId,
    network:          post.platform,
    postId:           post.id,
  });
  if (archived) assets.archived_url = archived;
  return assets;
}

/**
 * Rescata la imagen de un post PROPIO ya guardado que no tiene copia en R2.
 * Recibe la fila ya leida (`previo`), no la busca: ver getOwnPostsGuardados.
 * Devuelve { id, media_assets } listo para el update, o null si no hay nada que
 * hacer (sin imagen fresca, post inexistente, ya archivado o R2 no respondió).
 * Se borra `image_extraction_error`: con copia permanente el fallo viejo deja de
 * aplicar y el describer puede reintentar.
 */
async function _rescueOwnThumb(previo, post, brandContainerId) {
  if (!post.image || !previo) return null;
  // La fila llega YA leida del pre-check: se ahorra una consulta por post y,
  // sobre todo, se deja de empatar por entity_id — que era lo que volvia
  // invisibles a las filas huerfanas.
  const data = previo;
  const cur = (data.media_assets && typeof data.media_assets === "object" && !Array.isArray(data.media_assets))
    ? data.media_assets : {};
  if (cur.archived_url) return null;                  // ya rescatado
  const archived = await archiveThumb({
    mediaAssets:      { display_url: post.image },
    brandContainerId,
    network:          post.platform,
    postId:           post.id,
  });
  if (!archived) return null;
  const next = { ...cur, display_url: post.image, archived_url: archived };
  if (post.permalink) next.permalink = post.permalink;
  if (post.media_type) next.media_type = post.media_type;
  if (Array.isArray(post.images) && post.images.length > 1) next.images = post.images;
  delete next.image_extraction_error;
  return { id: data.id, media_assets: next };
}

/**
 * Archiva la miniatura de un post YA GUARDADO al que le falta la copia en R2.
 * Devuelve el media_assets actualizado, o null si no hay nada que hacer.
 * Barato: una sola lectura, y solo intenta archivar cuando de verdad falta.
 */
async function rescueArchivedThumb(entity, post) {
  const fresh = post.display_url || post.cover_image || post.thumbnail_url || null;
  if (!fresh) return null;
  const { data } = await supabase.from("brand_posts")
    .select("media_assets")
    .eq("entity_id", entity.id)
    .eq("post_id", post.external_id)
    .maybeSingle();
  const current = (data?.media_assets && typeof data.media_assets === "object" && !Array.isArray(data.media_assets))
    ? data.media_assets : {};
  if (current.archived_url) return null;              // ya rescatado
  const archived = await archiveThumb({
    mediaAssets:      { display_url: fresh },
    brandContainerId: entity.brand_container_id,
    network:          post.network,
    postId:           post.external_id,
  });
  if (!archived) return null;
  // Se refresca también la URL viva del CDN: sirve de respaldo inmediato.
  return { ...current, display_url: fresh, archived_url: archived };
}
