/**
 * platform-insights-sensors.service.js
 *
 * Sensores de METRICAS OFICIALES (insights) por plataforma no-Meta. A diferencia
 * de los posts scrapeados via Apify, estos leen las APIs autorizadas por la marca
 * (OAuth en brand_integrations) y REFRESCAN las metricas que solo la plataforma
 * conoce (views, watch, reputacion de vendedor, visitas, ordenes...).
 *
 * Se invocan desde runOwnedAnalyticsSensor() (social-scraper.service.js) cuando un
 * monitoring_trigger con sensor_type = 'tiktok_video_insights' | 'mercadolibre_metrics'
 * vence. Cada uno resuelve su brand_integration desde brand_container_id, tolera
 * fallos parciales (una sub-metrica que falle no tumba el snapshot) y escribe:
 *   - brand_posts.metrics   (TikTok: refresco por-video de views/likes/etc)
 *   - brand_analytics_snapshots (snapshot agregado por plataforma)
 *
 * SIN LLM: puro fetch + DB (disciplina de costo). Idempotente por ciclo.
 */
import { supabase } from "../lib/supabase.js";
import { decryptIntegrationRow } from "../lib/integration-token-vault.js";
import { normalizeMetrics } from "../lib/platform-metrics.js";
import { getMe, getRecentVideos } from "../lib/tiktok-rest.js";
import { meliGet } from "../lib/mercadolibre-rest.js";
import { getMetaPageInsights, getInstagramInsights } from "../tools/social.tools.js";
import { searchStream } from "../lib/googleads-rest.js";
import { shopifyRestGet, shopifyRestGetAllPages } from "../lib/shopify-rest.js";

const INTEG_COLS =
  "id, brand_container_id, platform, shop_domain, access_token, refresh_token, token_expires_at, metadata, scope, is_active";

/** Resuelve la integracion ACTIVA (desencriptada) de una plataforma para una marca. */
async function resolveIntegration(brandContainerId, platform) {
  const { data, error } = await supabase
    .from("brand_integrations")
    .select(INTEG_COLS)
    .eq("brand_container_id", brandContainerId)
    .eq("platform", platform)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`resolveIntegration(${platform}): ${error.message}`);
  if (!data) return null;
  decryptIntegrationRow(data);
  return data;
}

/** Upsert de snapshot agregado (mismo contrato que persistAnalyticsSnapshot del scraper). */
async function upsertSnapshot(brandContainerId, platform, periodType, payload) {
  const now = new Date();
  const days = periodType === "weekly" ? 7 : periodType === "daily" ? 1 : 30;
  const periodEnd = now.toISOString().slice(0, 10);
  const periodStart = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const { error } = await supabase.from("brand_analytics_snapshots").upsert(
    {
      brand_container_id: brandContainerId,
      platform,
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      metrics: payload,
      computed_at: now.toISOString(),
    },
    { onConflict: "brand_container_id,platform,period_type,period_start" }
  );
  if (error) console.warn(`[insights-sensor] snapshot ${platform}: ${error.message}`);
}

/** Fecha de hoy (UTC) YYYY-MM-DD para el grano diario de la serie historica. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append historico: 1 fila por (marca, plataforma, scope, entity_ref, dia).
 * Upsert por fecha -> re-correr el mismo dia es idempotente (actualiza el punto),
 * pero cada dia nuevo deja su propio punto = serie temporal real. Esto es lo que
 * evita que Vera quede ciega a la EVOLUCION (followers, views por video, ventas).
 */
async function upsertDaily(rows) {
  if (!rows || !rows.length) return 0;
  const stamped = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await supabase
    .from("platform_insights_daily")
    .upsert(stamped, { onConflict: "brand_container_id,platform,scope,entity_ref,metric_date" });
  if (error) {
    console.warn(`[insights-sensor] daily upsert (${rows[0]?.platform}): ${error.message}`);
    return 0;
  }
  return rows.length;
}

// ────────────────────────────────────────────────────────────────────────────
// TikTok — insights por video (view/like/comment/share) + stats de cuenta.
// ────────────────────────────────────────────────────────────────────────────
export async function runTikTokVideoInsights({ brandContainerId, organizationId }) {
  const integ = await resolveIntegration(brandContainerId, "tiktok");
  if (!integ) return { skipped: true, reason: "no_tiktok_integration" };
  const metricDate = today();
  const videoDaily = [];

  const me = await getMe(integ).catch((e) => {
    console.warn(`[tiktok-insights] getMe: ${e.message}`);
    return null;
  });
  const user = me?.data?.user || {};
  const username = user.username || integ.metadata?.username || null;

  // Ventana amplia: refresca metricas de los ultimos ~60 videos.
  const { videos } = await getRecentVideos(integ, { maxPages: 3, perPage: 20 }).catch((e) => {
    console.warn(`[tiktok-insights] getRecentVideos: ${e.message}`);
    return { videos: [] };
  });

  const stats = { handle: username, videos_pulled: videos.length, updated: 0, inserted: 0, errors: 0 };
  const agg = { plays: 0, likes: 0, comments: 0, shares: 0 };

  if (videos.length) {
    const ids = videos.map((v) => String(v.id));
    const { data: existing } = await supabase
      .from("brand_posts")
      .select("post_id")
      .eq("brand_container_id", brandContainerId)
      .eq("network", "tiktok")
      .in("post_id", ids);
    const seen = new Set((existing || []).map((r) => String(r.post_id)));

    for (const v of videos) {
      try {
        const metrics = normalizeMetrics("tiktok", {
          like_count: v.like_count,
          comment_count: v.comment_count,
          share_count: v.share_count,
          view_count: v.view_count,
        });
        agg.plays += Number(v.view_count) || 0;
        agg.likes += Number(v.like_count) || 0;
        agg.comments += Number(v.comment_count) || 0;
        agg.shares += Number(v.share_count) || 0;

        // Punto historico POR VIDEO del dia (la curva de crecimiento que el
        // overwrite de brand_posts.metrics estaba borrando).
        videoDaily.push({
          organization_id: organizationId,
          brand_container_id: brandContainerId,
          platform: "tiktok",
          scope: "post",
          entity_ref: String(v.id),
          metric_date: metricDate,
          label: (v.video_description || v.title || "").slice(0, 120) || null,
          metrics: {
            plays: Number(v.view_count) || 0,
            likes: Number(v.like_count) || 0,
            comments: Number(v.comment_count) || 0,
            shares: Number(v.share_count) || 0,
          },
        });

        if (seen.has(String(v.id))) {
          // REFRESCO: metricas de un video ya conocido (esto es lo que faltaba).
          const { error } = await supabase
            .from("brand_posts")
            .update({
              metrics,
              ...(user.follower_count != null ? { followers_snapshot: user.follower_count } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("brand_container_id", brandContainerId)
            .eq("network", "tiktok")
            .eq("post_id", String(v.id));
          if (error) throw error;
          stats.updated++;
        } else {
          const desc = v.video_description || v.title || "";
          const capturedAt = v.create_time
            ? new Date(Number(v.create_time) * 1000).toISOString()
            : new Date().toISOString();
          const { error } = await supabase.from("brand_posts").insert({
            brand_container_id: brandContainerId,
            network: "tiktok",
            post_source: "own",
            profile_handle: username,
            author_display_name: user.display_name || null,
            post_id: String(v.id),
            content: desc,
            permalink: v.share_url || null,
            media_assets: v.cover_image_url ? [{ type: "image", url: v.cover_image_url }] : null,
            metrics,
            followers_snapshot: user.follower_count ?? null,
            hashtags: extractHashtags(desc),
            captured_at: capturedAt,
            is_competitor: false,
            ai_analyzed_at: null,
          });
          if (error) throw error;
          stats.inserted++;
        }
      } catch (e) {
        stats.errors++;
        console.warn(`[tiktok-insights] video ${v?.id}: ${e.message}`);
      }
    }
  }

  const engagement = agg.likes + agg.comments + agg.shares;

  // ── Historia diaria: punto de CUENTA + puntos por VIDEO ──────────────────
  const accountDaily = {
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    platform: "tiktok",
    scope: "account",
    entity_ref: username || String(user.open_id || integ.id),
    metric_date: metricDate,
    label: username ? `@${username}` : null,
    metrics: {
      followers: user.follower_count ?? null,
      likes_total: user.likes_count ?? null,
      videos_total: user.video_count ?? null,
      videos_tracked: videos.length,
      plays: agg.plays,
      likes: agg.likes,
      comments: agg.comments,
      shares: agg.shares,
      engagement,
      engagement_rate: agg.plays > 0 ? +(engagement / agg.plays).toFixed(5) : null,
    },
  };
  await upsertDaily([accountDaily, ...videoDaily]);

  await upsertSnapshot(brandContainerId, "tiktok", "monthly", {
    source: "tiktok_api",
    handle: username,
    account: {
      followers: user.follower_count ?? null,
      likes_total: user.likes_count ?? null,
      videos_total: user.video_count ?? null,
      is_verified: user.is_verified ?? null,
    },
    videos_tracked: videos.length,
    totals: { plays: agg.plays, likes: agg.likes, comments: agg.comments, shares: agg.shares, engagement },
    engagement_rate: agg.plays > 0 ? +(engagement / agg.plays).toFixed(5) : null,
  });

  await supabase
    .from("brand_integrations")
    .update({
      last_sync_at: new Date().toISOString(),
      metadata: {
        ...(integ.metadata || {}),
        followers: user.follower_count ?? integ.metadata?.followers,
        likes: user.likes_count ?? integ.metadata?.likes,
        video_count: user.video_count ?? integ.metadata?.video_count,
        insights_synced_at: new Date().toISOString(),
      },
    })
    .eq("id", integ.id);

  return { ...stats, followers: user.follower_count ?? null, engagement };
}

// ────────────────────────────────────────────────────────────────────────────
// MercadoLibre — performance de vendedor: reputacion + visitas + ordenes +
// preguntas. Cada sub-fetch es tolerante a fallo (scope/permiso faltante).
// ────────────────────────────────────────────────────────────────────────────
export async function runMercadoLibreMetrics({ brandContainerId, organizationId }) {
  const integ = await resolveIntegration(brandContainerId, "mercadolibre");
  if (!integ) return { skipped: true, reason: "no_mercadolibre_integration" };
  const metricDate = today();

  const sellerId = integ.metadata?.meli_user_id;
  if (!sellerId) return { skipped: true, reason: "no_seller_id_in_metadata" };

  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const isoDate = (d) => d.toISOString().slice(0, 10);

  const out = { seller_id: sellerId, errors: [] };

  // 1) Reputacion / usuario
  try {
    const u = await meliGet(integ, `/users/${sellerId}`);
    const rep = u?.seller_reputation || {};
    out.reputation = {
      level_id: rep.level_id ?? null,
      power_seller_status: rep.power_seller_status ?? null,
      transactions_total: rep.transactions?.total ?? null,
      transactions_completed: rep.transactions?.completed ?? null,
      transactions_canceled: rep.transactions?.canceled ?? null,
      ratings: rep.transactions?.ratings ?? null,
      claims_rate: rep.metrics?.claims?.rate ?? null,
      cancellations_rate: rep.metrics?.cancellations?.rate ?? null,
      delayed_handling_rate: rep.metrics?.delayed_handling_time?.rate ?? null,
      points: u?.points ?? null,
    };
  } catch (e) {
    out.errors.push(`reputation: ${e.message}`);
  }

  // 2) Visitas a items (ultimos 30d)
  try {
    const v = await meliGet(integ, `/users/${sellerId}/items_visits`, {
      date_from: isoDate(from),
      date_to: isoDate(now),
    });
    out.visits_30d = v?.total_visits ?? null;
  } catch (e) {
    out.errors.push(`visits: ${e.message}`);
  }

  // 3) Ordenes (ultimos 30d) — paginado acotado para revenue.
  try {
    let offset = 0;
    const limit = 50;
    let total = null;
    let revenue = 0;
    let counted = 0;
    let currency = null;
    let pages = 0;
    const MAX_PAGES = 5;
    do {
      const o = await meliGet(integ, `/orders/search`, {
        seller: sellerId,
        "order.date_created.from": from.toISOString(),
        "order.date_created.to": now.toISOString(),
        sort: "date_desc",
        offset,
        limit,
      });
      if (total == null) total = o?.paging?.total ?? 0;
      const results = Array.isArray(o?.results) ? o.results : [];
      for (const ord of results) {
        revenue += Number(ord.total_amount) || 0;
        counted++;
        if (!currency) currency = ord.currency_id || null;
      }
      offset += limit;
      pages++;
      if (!results.length) break;
    } while (offset < (total || 0) && pages < MAX_PAGES);
    out.orders_30d = total;
    out.revenue_30d_sampled = +revenue.toFixed(2);
    out.revenue_orders_sampled = counted;
    out.revenue_truncated = total != null && counted < total;
    out.currency = currency;
  } catch (e) {
    out.errors.push(`orders: ${e.message}`);
  }

  // 4) Preguntas (total + sin responder)
  try {
    const qAll = await meliGet(integ, `/questions/search`, { seller_id: sellerId, limit: 1 });
    out.questions_total = qAll?.total ?? null;
    const qUn = await meliGet(integ, `/questions/search`, {
      seller_id: sellerId,
      status: "UNANSWERED",
      limit: 1,
    });
    out.questions_unanswered = qUn?.total ?? null;
  } catch (e) {
    out.errors.push(`questions: ${e.message}`);
  }

  await upsertSnapshot(brandContainerId, "mercadolibre", "daily", { source: "mercadolibre_api", ...out });

  // ── Historia diaria: punto de VENDEDOR ───────────────────────────────────
  await upsertDaily([{
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    platform: "mercadolibre",
    scope: "seller",
    entity_ref: String(sellerId),
    metric_date: metricDate,
    label: integ.metadata?.nickname || null,
    metrics: {
      reputation_level: out.reputation?.level_id ?? null,
      power_seller_status: out.reputation?.power_seller_status ?? null,
      transactions_total: out.reputation?.transactions_total ?? null,
      transactions_completed: out.reputation?.transactions_completed ?? null,
      claims_rate: out.reputation?.claims_rate ?? null,
      visits_30d: out.visits_30d ?? null,
      orders_30d: out.orders_30d ?? null,
      revenue_30d_sampled: out.revenue_30d_sampled ?? null,
      currency: out.currency ?? null,
      questions_total: out.questions_total ?? null,
      questions_unanswered: out.questions_unanswered ?? null,
    },
  }]);

  await supabase
    .from("brand_integrations")
    .update({
      last_sync_at: new Date().toISOString(),
      metadata: { ...(integ.metadata || {}), metrics_synced_at: new Date().toISOString() },
    })
    .eq("id", integ.id);

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Meta — insights de CUENTA de Facebook Page + Instagram Business, con historia
// diaria. Reemplaza el branch viejo que solo guardaba snapshot de FB (e ignoraba
// Instagram por completo a nivel cuenta). Ambas resuelven el mismo OAuth 'facebook'.
// ────────────────────────────────────────────────────────────────────────────
export async function runMetaAccountInsights({ brandContainerId, organizationId }) {
  const metricDate = today();
  const dailyRows = [];
  const stats = { facebook: null, instagram: null, errors: [] };

  // ── Facebook Page ──
  try {
    const fb = await getMetaPageInsights({ brandContainerId, organizationId, range: "30d" });
    await upsertSnapshot(brandContainerId, "facebook", "monthly", fb);
    const er = parseFloat(String(fb.metrics?.engagement_rate || "0")) || null;
    dailyRows.push({
      organization_id: organizationId,
      brand_container_id: brandContainerId,
      platform: "facebook",
      scope: "account",
      entity_ref: String(fb.page?.id || "page"),
      metric_date: metricDate,
      label: fb.page?.name || null,
      metrics: {
        fans: fb.page?.total_fans ?? null,
        followers: fb.page?.total_followers ?? null,
        talking_about: fb.page?.talking_about_count ?? null,
        page_views_30d: fb.metrics?.page_views ?? null,
        post_engagements_30d: fb.metrics?.post_engagements ?? null,
        new_followers_30d: fb.metrics?.new_followers ?? null,
        unfollows_30d: fb.metrics?.unfollows ?? null,
        cta_clicks_30d: fb.metrics?.cta_clicks ?? null,
        engagement_rate: er,
      },
    });
    stats.facebook = { fans: fb.page?.total_fans, engagements: fb.metrics?.post_engagements };
  } catch (e) {
    stats.errors.push(`facebook: ${e.message}`);
  }

  // ── Instagram Business (vinculada a la misma page). Puede no existir. ──
  try {
    const ig = await getInstagramInsights({ brandContainerId, organizationId, range: "30d" });
    await upsertSnapshot(brandContainerId, "instagram", "monthly", ig);
    dailyRows.push({
      organization_id: organizationId,
      brand_container_id: brandContainerId,
      platform: "instagram",
      scope: "account",
      entity_ref: String(ig.account?.id || "ig"),
      metric_date: metricDate,
      label: ig.account?.username || null,
      metrics: {
        followers: ig.account?.followers ?? null,
        media_count: ig.account?.media_count ?? null,
        reach_30d: ig.metrics?.reach ?? null,
        total_interactions_30d: ig.metrics?.total_interactions ?? null,
        accounts_engaged_30d: ig.metrics?.accounts_engaged ?? null,
        follows_net_30d: ig.metrics?.follows_and_unfollows_net ?? null,
        avg_daily_reach: ig.metrics?.avg_daily_reach ?? null,
      },
    });
    stats.instagram = { followers: ig.account?.followers, reach: ig.metrics?.reach };
  } catch (e) {
    // Sin IG vinculada u otro fallo: no rompe el sensor (FB ya se guardo).
    stats.errors.push(`instagram: ${(e.message || "").slice(0, 160)}`);
  }

  if (dailyRows.length) await upsertDaily(dailyRows);

  // ── Historia POR-POST (IG/FB propios) ────────────────────────────────────
  // Snapshot diario de las metricas que meta_posts ya refresco en brand_posts.
  // Sin llamadas Graph extra: leemos lo ingerido y lo fijamos como punto del dia,
  // recuperando la CURVA por post que el overwrite de brand_posts.metrics borraba.
  try {
    const { data: ownPosts } = await supabase
      .from("brand_posts")
      .select("post_id, network, metrics, engagement_total, reach_total, captured_at")
      .eq("brand_container_id", brandContainerId)
      .eq("is_competitor", false)
      .eq("post_source", "own")
      .in("network", ["facebook", "instagram"])
      .not("post_id", "is", null)
      .order("captured_at", { ascending: false })
      .limit(80);
    const postRows = (ownPosts || []).map((p) => ({
      organization_id: organizationId,
      brand_container_id: brandContainerId,
      platform: p.network,
      scope: "post",
      entity_ref: String(p.post_id),
      metric_date: metricDate,
      metrics: {
        ...(p.metrics || {}),
        engagement_total: p.engagement_total ?? null,
        reach_total: p.reach_total ?? null,
      },
    }));
    if (postRows.length) {
      await upsertDaily(postRows);
      stats.own_posts_tracked = postRows.length;
    }
  } catch (e) {
    stats.errors.push(`meta_posts_history: ${(e.message || "").slice(0, 160)}`);
  }

  return stats;
}

// ────────────────────────────────────────────────────────────────────────────
// Google Ads — insights diarios REALES (segments.date da el desglose por dia, asi
// que un solo run BACKFILLEA los ultimos N dias). Por campana + agregado de cuenta.
// Escribe platform='google_ads' en platform_insights_daily. Idempotente por fecha.
// ────────────────────────────────────────────────────────────────────────────
const GADS_GAQL = `
  SELECT campaign.id, campaign.name, campaign.status,
         metrics.impressions, metrics.clicks, metrics.cost_micros,
         metrics.conversions, metrics.conversions_value,
         metrics.ctr, metrics.average_cpc, segments.date
  FROM campaign
  WHERE segments.date DURING LAST_14_DAYS
`;

export async function runGoogleAdsInsights({ brandContainerId, organizationId }) {
  const integ = await resolveIntegration(brandContainerId, "google");
  if (!integ) return { skipped: true, reason: "no_google_integration" };

  const customerIds =
    (integ.metadata?.selected_customer_ids && integ.metadata.selected_customer_ids.length
      ? integ.metadata.selected_customer_ids
      : (integ.metadata?.available_accounts || [])
          .filter((a) => a.customer_id && a.login_customer_id === a.customer_id)
          .map((a) => a.customer_id)) || [];
  if (!customerIds.length) return { skipped: true, reason: "no_customer_ids" };

  const stats = { customers: customerIds.length, campaign_days: 0, account_days: 0, errors: [] };
  const rows = [];

  for (const cust of customerIds) {
    const acc = (integ.metadata?.available_accounts || []).find((a) => a.customer_id === cust) || {};
    const loginId = acc.login_customer_id || cust;
    try {
      const grows = await searchStream(integ, cust, GADS_GAQL, { loginCustomerId: loginId });
      const acctByDate = {}; // date -> agregado de cuenta
      for (const r of grows) {
        const date = r.segments?.date;
        const m = r.metrics || {};
        const c = r.campaign || {};
        if (!date) continue;
        const cost = m.costMicros != null ? Number(m.costMicros) / 1e6 : (m.cost_micros != null ? Number(m.cost_micros) / 1e6 : 0);
        const met = {
          impressions: Number(m.impressions) || 0,
          clicks: Number(m.clicks) || 0,
          cost: +cost.toFixed(2),
          conversions: Number(m.conversions) || 0,
          conversions_value: Number(m.conversionsValue ?? m.conversions_value) || 0,
          ctr: Number(m.ctr) || 0,
          avg_cpc: (m.averageCpc ?? m.average_cpc) != null ? +(Number(m.averageCpc ?? m.average_cpc) / 1e6).toFixed(2) : null,
        };
        rows.push({
          organization_id: organizationId,
          brand_container_id: brandContainerId,
          platform: "google_ads",
          scope: "campaign",
          entity_ref: `${cust}:${c.id}`,
          metric_date: date,
          label: c.name || null,
          metrics: { ...met, currency: acc.currency || null, status: c.status || null },
        });
        stats.campaign_days++;
        const a = (acctByDate[date] = acctByDate[date] || { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversions_value: 0 });
        a.impressions += met.impressions; a.clicks += met.clicks; a.cost += met.cost;
        a.conversions += met.conversions; a.conversions_value += met.conversions_value;
      }
      for (const [date, a] of Object.entries(acctByDate)) {
        rows.push({
          organization_id: organizationId,
          brand_container_id: brandContainerId,
          platform: "google_ads",
          scope: "account",
          entity_ref: String(cust),
          metric_date: date,
          label: acc.name || null,
          metrics: {
            impressions: a.impressions, clicks: a.clicks, cost: +a.cost.toFixed(2),
            conversions: a.conversions, conversions_value: +a.conversions_value.toFixed(2),
            ctr: a.impressions > 0 ? +((a.clicks / a.impressions) * 100).toFixed(2) : 0,
            cpa: a.conversions > 0 ? +(a.cost / a.conversions).toFixed(2) : null,
            currency: acc.currency || null,
          },
        });
        stats.account_days++;
      }
    } catch (e) {
      stats.errors.push(`${cust}: ${(e.message || "").slice(0, 160)}`);
    }
  }

  if (rows.length) await upsertDaily(rows);
  await supabase
    .from("brand_integrations")
    .update({
      last_sync_at: new Date().toISOString(),
      metadata: { ...(integ.metadata || {}), ads_insights_synced_at: new Date().toISOString() },
    })
    .eq("id", integ.id);

  return stats;
}

// ────────────────────────────────────────────────────────────────────────────
// Shopify — metricas de tienda: ventas 30d, ticket promedio, ordenes/clientes.
// Requiere scope read_orders (+ read_all_orders para >60d) y un token VIVO.
// Escribe snapshot + historia diaria scope='store'. Tolerante a fallo/401.
// ────────────────────────────────────────────────────────────────────────────
export async function runShopifyMetrics({ brandContainerId, organizationId }) {
  const integ = await resolveIntegration(brandContainerId, "shopify");
  if (!integ) return { skipped: true, reason: "no_shopify_integration" };
  const shop = integ.shop_domain;
  const tok = integ.access_token;
  if (!shop || !tok) return { skipped: true, reason: "no_shop_or_token" };

  const metricDate = today();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const out = { shop, errors: [] };

  try {
    const r = await shopifyRestGet(shop, tok, "/orders/count.json?status=any");
    out.orders_total = r.data?.count ?? null;
  } catch (e) { out.errors.push(`orders_count: ${(e.message || "").slice(0, 120)}`); }

  try {
    const r = await shopifyRestGet(shop, tok, "/customers/count.json");
    out.customers_total = r.data?.count ?? null;
  } catch (e) { out.errors.push(`customers_count: ${(e.message || "").slice(0, 120)}`); }

  try {
    const { items } = await shopifyRestGetAllPages(
      shop, tok,
      `/orders.json?status=any&created_at_min=${since}&fields=id,current_total_price,total_price,currency,financial_status`,
      { maxPages: 10 }
    );
    let revenue = 0, currency = null, paid = 0;
    for (const o of items) {
      const amt = Number(o.current_total_price ?? o.total_price) || 0;
      revenue += amt;
      if (!currency) currency = o.currency || null;
      if (o.financial_status === "paid") paid++;
    }
    out.orders_30d = items.length;
    out.revenue_30d = +revenue.toFixed(2);
    out.paid_orders_30d = paid;
    out.aov_30d = items.length ? +(revenue / items.length).toFixed(2) : null;
    out.currency = currency;
  } catch (e) { out.errors.push(`orders: ${(e.message || "").slice(0, 120)}`); }

  await upsertSnapshot(brandContainerId, "shopify", "daily", { source: "shopify_api", ...out });
  await upsertDaily([{
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    platform: "shopify",
    scope: "store",
    entity_ref: String(integ.metadata?.shop_id || shop),
    metric_date: metricDate,
    label: integ.metadata?.shop_name || shop,
    metrics: {
      orders_total: out.orders_total ?? null,
      customers_total: out.customers_total ?? null,
      orders_30d: out.orders_30d ?? null,
      revenue_30d: out.revenue_30d ?? null,
      aov_30d: out.aov_30d ?? null,
      paid_orders_30d: out.paid_orders_30d ?? null,
      currency: out.currency ?? null,
    },
  }]);

  await supabase.from("brand_integrations").update({
    last_sync_at: new Date().toISOString(),
    metadata: { ...(integ.metadata || {}), metrics_synced_at: new Date().toISOString() },
  }).eq("id", integ.id);

  return out;
}

function extractHashtags(text) {
  if (!text) return [];
  const out = [];
  let m;
  const re = /#([\p{L}\p{N}_]+)/gu;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return [...new Set(out)];
}
