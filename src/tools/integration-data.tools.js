/**
 * integration-data.tools.js — Tools de Vera para DATA EN VIVO de las APIs.
 *
 * Vera (OpenClaw) las llama con [[TOOL:...]]; ai-engine (que tiene los tokens)
 * pega a la API real y devuelve data fresca. Read-only, scope por org/marca.
 * Pulls LIGEROS (1 pagina, limites bajos) para caber en el timeout de 8s del
 * dispatcher. Errores se devuelven como { error } (no rompen a Vera).
 *
 * El razonamiento lo hace Vera en chat (LLM cara al usuario) — aqui solo fetch.
 */
import { supabase } from "../lib/supabase.js";
import { decryptIntegrationRow } from "../lib/integration-token-vault.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { analyzeCatalog } from "../services/catalog-analysis.service.js";
import { listAccessibleCustomers, searchStream } from "../lib/googleads-rest.js";
import { getMe, getRecentTweets } from "../lib/x-rest.js";
import { meliGetAllItemIds, meliMultiGetItems } from "../lib/mercadolibre-rest.js";

async function loadIntegration(brandContainerId, platform) {
  const { data } = await supabase
    .from("brand_integrations")
    .select("id, brand_container_id, platform, shop_domain, access_token, refresh_token, token_expires_at, metadata, scope, external_account_id")
    .eq("brand_container_id", brandContainerId)
    .eq("platform", platform)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  decryptIntegrationRow(data);
  return data;
}

/** Diagnóstico de catálogo e-commerce (score de fichas + gaps + qué optimizar). */
export async function getCatalogDiagnosis(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!bc?.id) return { error: "no_brand" };
  return analyzeCatalog(bc.id);
}

/** Productos en vivo del marketplace (Mercado Libre). Snapshot ligero. */
export async function getLiveProducts(brandContainerId, organizationId, params = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!bc?.id) return { error: "no_brand" };
  const integ = await loadIntegration(bc.id, "mercadolibre");
  if (!integ) return { error: "sin_integracion_mercadolibre" };
  try {
    const sellerId = integ.metadata?.meli_user_id || integ.external_account_id;
    const { ids } = await meliGetAllItemIds(integ, sellerId, { maxItems: 20, limit: 20 });
    if (!ids.length) return { source: "mercadolibre", products: [] };
    const items = await meliMultiGetItems(integ, ids.slice(0, 20));
    return {
      source: "mercadolibre", count: items.length,
      products: items.map((it) => ({
        id: it.id, title: it.title, price: it.price, currency: it.currency_id,
        status: it.status, available: it.available_quantity, sold: it.sold_quantity,
        permalink: it.permalink,
      })),
    };
  } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; }
}

/** Posts recientes EN VIVO de X (Twitter). Snapshot ligero (1 pagina). */
export async function getLivePosts(brandContainerId, organizationId, params = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!bc?.id) return { error: "no_brand" };
  const integ = await loadIntegration(bc.id, "x");
  if (!integ) return { error: "sin_integracion_x" };
  try {
    const me = await getMe(integ);
    const userId = me?.data?.id || integ.metadata?.x_user_id || integ.external_account_id;
    const { tweets } = await getRecentTweets(integ, userId, { maxPages: 1, perPage: 25 });
    return {
      source: "x", handle: me?.data?.username || null, count: tweets.length,
      posts: tweets.map((t) => ({
        id: t.id, text: t.text, created_at: t.created_at, metrics: t.public_metrics,
      })),
    };
  } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; }
}

/** Métricas de campañas de Google Ads EN VIVO (cuenta primaria, últimos 7 días). */
export async function getLiveAdsMetrics(brandContainerId, organizationId, params = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!bc?.id) return { error: "no_brand" };
  const integ = await loadIntegration(bc.id, "google");
  if (!integ) return { error: "sin_integracion_google" };
  try {
    const tops = await listAccessibleCustomers(integ);
    if (!tops.length) return { source: "google_ads", campaigns: [] };
    // Snapshot ligero: primera cuenta accesible, ultimos 7d
    const top = tops[0];
    const clients = await searchStream(integ, top,
      "SELECT customer_client.id, customer_client.manager FROM customer_client", { loginCustomerId: top });
    const leaf = (clients.find((r) => r.customerClient?.manager === false)?.customerClient?.id) || top;
    const rows = await searchStream(integ, leaf,
      "SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      { loginCustomerId: top });
    return {
      source: "google_ads", account: leaf, window: "LAST_7_DAYS", count: rows.length,
      campaigns: rows.map((r) => ({
        name: r.campaign?.name, status: r.campaign?.status,
        spend: Number(r.metrics?.costMicros || 0) / 1e6,
        clicks: Number(r.metrics?.clicks || 0), impressions: Number(r.metrics?.impressions || 0),
        conversions: Number(r.metrics?.conversions || 0),
      })),
    };
  } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; }
}
