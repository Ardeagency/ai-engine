/**
 * sync-meta-ad-insights.service.js
 *
 * FEAT-023 — sincroniza performance ad-level de Meta Marketing API a
 * `ad_insights_daily` (time-series). Hermano de campaign-performance.service.js:
 * mismo patrón de auth/iteración/upsert, pero:
 *   - level=ad (vs level=campaign del hermano)
 *   - time_increment=1 → 1 fila por ad por día
 *   - sin breakdowns demográficos (eso es trabajo del hermano)
 *   - sin filtro persona_id NOT NULL → todas las campañas Meta importadas
 *   - persiste a ad_insights_daily (UNIQUE upsert) + rollup a campaigns.cached_*
 *
 * Trigger: cron diario por tier (Creator=1x, Team=2x, Agency=4x). Sin LLM.
 *
 * Idempotente: el UNIQUE constraint (campaign_id, external_ad_id, date, platform)
 * garantiza que rerunning sobre la misma ventana sólo updatea valores.
 */
import { supabase } from "../lib/supabase.js";
import { decryptToken } from "../lib/integration-token-vault.js";

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const APP_SECRET = () => process.env.META_APP_SECRET || "";
const REQUIRE_PROOF = String(process.env.META_REQUIRE_APPSECRET_PROOF || "").toLowerCase() === "true";

// Action types de Meta que cuentan como "conversión" para el rollup.
// Mismo criterio que campaign-performance: purchase + lead + complete_registration.
const CONVERSION_ACTION_RX = /purchase|complete_registration|lead/i;

// ── Meta fetch helper (clonado de campaign-performance) ────────────────────

async function metaFetch(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${path}`);
  url.searchParams.set("access_token", token);
  if (REQUIRE_PROOF && APP_SECRET()) {
    const crypto = await import("node:crypto");
    const proof = crypto.createHmac("sha256", APP_SECRET()).update(token).digest("hex");
    url.searchParams.set("appsecret_proof", proof);
  }
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`Meta Graph ${res.status}: ${json?.error?.message || JSON.stringify(json?.error || json).slice(0, 200)}`);
  }
  return json;
}

// Pagination helper — Meta entrega `paging.next` con URL completa que ya
// incluye token. La seguimos hasta agotar. Cap defensivo a 50 páginas para
// evitar loops infinitos si Meta nos engaña.
async function metaFetchAllPages(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${path}`);
  url.searchParams.set("access_token", token);
  if (REQUIRE_PROOF && APP_SECRET()) {
    const crypto = await import("node:crypto");
    const proof = crypto.createHmac("sha256", APP_SECRET()).update(token).digest("hex");
    url.searchParams.set("appsecret_proof", proof);
  }
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));

  const out = [];
  let nextUrl = url.toString();
  let pages = 0;
  while (nextUrl && pages < 50) {
    const res = await fetch(nextUrl);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      throw new Error(`Meta Graph ${res.status}: ${json?.error?.message || JSON.stringify(json?.error || json).slice(0, 200)}`);
    }
    if (Array.isArray(json.data)) out.push(...json.data);
    nextUrl = json?.paging?.next || null;
    pages++;
  }
  return out;
}

// ── Fetch ad-level insights con time_increment=1 ───────────────────────────
//
// Meta acepta /{campaign_id}/insights?level=ad&time_increment=1 → devuelve
// un row por (ad_id, date). Fields elegidos para cubrir todas las métricas
// que vamos a persistir en ad_insights_daily.
async function fetchCampaignAdInsights(token, externalCampaignId, datePreset = "last_30d") {
  const fields = [
    "ad_id", "adset_id", "campaign_id", "account_id",
    "date_start", "date_stop",
    "impressions", "reach", "clicks", "unique_clicks", "spend",
    "ctr", "cpc", "cpm",
    "actions", "action_values",
  ].join(",");

  return metaFetchAllPages(`/${externalCampaignId}/insights`, token, {
    level: "ad",
    fields,
    date_preset: datePreset,
    time_increment: 1,
  });
}

// ── Row mapping: Meta payload → ad_insights_daily row ──────────────────────

function sumActions(actions, regex) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter(a => regex.test(a.action_type || ""))
    .reduce((s, a) => s + (Number(a.value) || 0), 0);
}

function mapInsightRow(row, ctx) {
  const impressions  = Number(row.impressions) || 0;
  const reach        = Number(row.reach) || 0;
  const clicks       = Number(row.clicks) || 0;
  const uniqueClicks = Number(row.unique_clicks) || 0;
  const spend        = Number(row.spend) || 0;

  const conversions      = sumActions(row.actions, CONVERSION_ACTION_RX);
  const conversionValue  = sumActions(row.action_values, CONVERSION_ACTION_RX);

  // Métricas derivadas: usar las que Meta entrega; fallback compute si vienen vacías.
  const ctr = row.ctr != null ? Number(row.ctr) : (impressions > 0 ? (clicks / impressions) * 100 : null);
  const cpc = row.cpc != null ? Number(row.cpc) : (clicks > 0 ? spend / clicks : null);
  const cpm = row.cpm != null ? Number(row.cpm) : (impressions > 0 ? (spend / impressions) * 1000 : null);
  const roas = spend > 0 && conversionValue > 0 ? conversionValue / spend : null;

  return {
    organization_id:     ctx.organizationId,
    brand_container_id:  ctx.brandContainerId,
    campaign_id:         ctx.campaignId,
    integration_id:      ctx.integrationId,

    external_ad_id:      String(row.ad_id),
    external_adset_id:   row.adset_id ? String(row.adset_id) : null,
    external_account_id: row.account_id ? String(row.account_id) : null,
    platform:            ctx.platform,

    date:                row.date_start,

    impressions, reach, clicks, unique_clicks: uniqueClicks, spend,
    conversions, conversion_value: conversionValue,
    ctr, cpc, cpm, roas,

    raw_payload:         row,
    synced_at:           new Date().toISOString(),
  };
}

// ── Upsert batch a ad_insights_daily ───────────────────────────────────────

async function upsertInsightsBatch(rows) {
  if (!rows.length) return { inserted: 0, errors: 0 };
  // Supabase JS no expone ON CONFLICT con todas las columnas únicas en una
  // sola llamada; pero el .upsert() acepta `onConflict` string de columnas.
  const { error, data } = await supabase
    .from("ad_insights_daily")
    .upsert(rows, {
      onConflict: "campaign_id,external_ad_id,date,platform",
      ignoreDuplicates: false, // queremos UPDATE en conflicto
    })
    .select("id");
  if (error) {
    console.error("sync-meta-ad-insights: upsert error:", error.message);
    return { inserted: 0, errors: rows.length };
  }
  return { inserted: data?.length || rows.length, errors: 0 };
}

// ── Rollup a campaigns.cached_* ────────────────────────────────────────────
//
// Después de upsertear todos los ad-day rows de una campaña, agregamos los
// totales y los escribimos en campaigns.cached_*. Esto es lo que verá el
// dashboard si no quiere consultar la time-series completa.
async function rolloutCampaignCached(campaignId) {
  const { data, error } = await supabase
    .from("ad_insights_daily")
    .select("impressions, reach, clicks, spend, conversions, conversion_value")
    .eq("campaign_id", campaignId);

  if (error || !data) return null;

  const tot = data.reduce((acc, r) => ({
    impressions:      acc.impressions      + (Number(r.impressions) || 0),
    clicks:           acc.clicks           + (Number(r.clicks) || 0),
    spend:            acc.spend            + (Number(r.spend) || 0),
    conversions:      acc.conversions      + (Number(r.conversions) || 0),
    conversion_value: acc.conversion_value + (Number(r.conversion_value) || 0),
  }), { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 });

  const ctr  = tot.impressions > 0 ? (tot.clicks / tot.impressions) * 100 : null;
  const roas = tot.spend > 0 && tot.conversion_value > 0 ? tot.conversion_value / tot.spend : null;

  await supabase
    .from("campaigns")
    .update({
      cached_impressions: tot.impressions,
      cached_clicks:      tot.clicks,
      cached_spend:       tot.spend,
      cached_conversions: tot.conversions,
      cached_ctr:         ctr,
      cached_roas:        roas,
      metrics_cached_at:  new Date().toISOString(),
      last_synced_at:     new Date().toISOString(),
    })
    .eq("id", campaignId);

  return tot;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Sync ad insights para un brand container. Recorre todas sus campañas Meta
 * con external_campaign_id + integration_id activa y trae /insights ad-level.
 *
 * @param {string} brandContainerId
 * @param {string} organizationId
 * @param {Object} [options]
 * @param {string} [options.datePreset='last_30d'] - Meta date_preset
 * @returns {Promise<{ campaigns_processed, ads_upserted, errors, skipped_no_token, skipped_no_data }>}
 */
export async function syncMetaAdInsightsForBrand(brandContainerId, organizationId, options = {}) {
  const datePreset = options.datePreset || "last_30d";
  const stats = {
    campaigns_processed: 0,
    ads_upserted: 0,
    errors: 0,
    skipped_no_token: 0,
    skipped_no_data: 0,
  };

  if (!brandContainerId || !organizationId) return stats;

  // 1. Campaigns Meta del brand con external_campaign_id e integration activa
  const { data: campaigns, error: cErr } = await supabase
    .from("campaigns")
    .select("id, nombre_campana, external_campaign_id, external_account_id, integration_id, platform")
    .eq("brand_container_id", brandContainerId)
    .in("platform", ["meta_facebook", "meta_instagram"])
    .not("external_campaign_id", "is", null)
    .not("integration_id", "is", null);
  if (cErr) throw cErr;
  if (!campaigns || campaigns.length === 0) return { ...stats, status: "no_meta_campaigns" };

  // 2. Decrypt tokens de las integraciones referenciadas
  const integIds = [...new Set(campaigns.map(c => c.integration_id))];
  const { data: integs } = await supabase
    .from("brand_integrations")
    .select("id, access_token, is_active")
    .in("id", integIds)
    .eq("is_active", true);
  const tokenById = {};
  for (const it of (integs || [])) {
    try { tokenById[it.id] = decryptToken(it.access_token); } catch (_) { /* skip */ }
  }

  // 3. Por campaña: fetch insights → batch upsert → rollup
  for (const c of campaigns) {
    const token = tokenById[c.integration_id];
    if (!token) { stats.skipped_no_token++; continue; }

    try {
      const rows = await fetchCampaignAdInsights(token, c.external_campaign_id, datePreset);
      if (!rows.length) { stats.skipped_no_data++; continue; }

      const mapped = rows.map(r => mapInsightRow(r, {
        organizationId,
        brandContainerId,
        campaignId:    c.id,
        integrationId: c.integration_id,
        platform:      c.platform,
      }));

      const { inserted, errors } = await upsertInsightsBatch(mapped);
      stats.ads_upserted += inserted;
      stats.errors       += errors;

      await rolloutCampaignCached(c.id);
      stats.campaigns_processed++;
    } catch (e) {
      stats.errors++;
      console.error(`sync-meta-ad-insights: campaign ${c.id} (${c.external_campaign_id}) failed:`, e.message?.slice(0, 200));
    }
  }

  return stats;
}

/**
 * Wrapper: sync para todos los brand_containers de una organización.
 * Útil para backfill manual o cron-por-org.
 */
export async function syncMetaAdInsightsForOrg(organizationId, options = {}) {
  const { data: containers } = await supabase
    .from("brand_containers")
    .select("id")
    .eq("organization_id", organizationId);

  const totals = {
    brand_containers: containers?.length || 0,
    campaigns_processed: 0,
    ads_upserted: 0,
    errors: 0,
    skipped_no_token: 0,
    skipped_no_data: 0,
  };

  for (const bc of (containers || [])) {
    const s = await syncMetaAdInsightsForBrand(bc.id, organizationId, options);
    for (const k of Object.keys(totals)) {
      if (typeof s[k] === "number") totals[k] += s[k];
    }
  }
  return totals;
}
