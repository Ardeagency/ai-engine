/**
 * shopify-bootstrap.service.js — Orchestrator del bootstrap inicial Shopify.
 *
 * Llamado desde job-worker.service.js cuando ve un job con
 *   job_type='mission' AND payload.mission_type ∈ SHOPIFY_MISSION_TYPES
 *
 * Flow:
 *   1. shopify_initial_bootstrap (padre) → encola los 12 subjobs con run_after escalonado
 *   2. Subjobs en orden secuencial (30s spacing) → cada uno hace su trabajo
 *   3. vera_propose_priority_actions (último) → marca brand_integrations.bootstrap_status='completed'
 *
 * Estado actual (fase 2A):
 *   REAL implementados:
 *     · shopify_initial_bootstrap    (orchestrator)
 *     · shopify_sync_shop_metadata   (REST GET /shop.json)
 *     · shopify_sync_products        (REST paginado, mapea a external_resource_map)
 *     · vera_propose_priority_actions (marca completed + 1 acción placeholder)
 *
 *   STUB (placeholder hasta fase 2B):
 *     · shopify_sync_collections / pages_blogs / themes / orders / customers
 *     · vera_analysis_shopify_{seo_geo, brand_voice, imagery_arde, conversion_gaps}
 */
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { shopifyRestGet, shopifyRestGetAllPages } from "../lib/shopify-rest.js";

const SUBJOB_SEQUENCE = [
  "shopify_sync_shop_metadata",
  "shopify_sync_products",
  "shopify_sync_collections",
  "shopify_sync_pages_blogs",
  "shopify_sync_themes",
  "shopify_sync_orders",
  "shopify_sync_customers",
  "vera_analysis_shopify_seo_geo",
  "vera_analysis_shopify_brand_voice",
  "vera_analysis_shopify_imagery_arde",
  "vera_analysis_shopify_conversion_gaps",
  "vera_propose_priority_actions",
];

const STUB_SUBJOBS = new Set([
  "shopify_sync_collections",
  "shopify_sync_pages_blogs",
  "shopify_sync_themes",
  "shopify_sync_orders",
  "shopify_sync_customers",
  "vera_analysis_shopify_seo_geo",
  "vera_analysis_shopify_brand_voice",
  "vera_analysis_shopify_imagery_arde",
  "vera_analysis_shopify_conversion_gaps",
]);

const SUBJOB_SPACING_MS = 30_000; // 30s entre subjobs (rate-limit friendly)

// ── Router principal ────────────────────────────────────────────────────────

export async function processShopifyJob(job) {
  const missionType = job?.payload?.mission_type;
  if (!missionType) throw new Error("Missing mission_type in job payload");

  switch (missionType) {
    case "shopify_initial_bootstrap":
      return await processInitialBootstrap(job);
    case "shopify_sync_shop_metadata":
      return await syncShopMetadata(job);
    case "shopify_sync_products":
      return await syncProducts(job);
    case "vera_propose_priority_actions":
      return await proposeStarterActions(job);
    default:
      if (STUB_SUBJOBS.has(missionType)) return await stubSubjob(job);
      throw new Error(`Unknown shopify mission_type: ${missionType}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getIntegration(integrationId) {
  const { data, error } = await supabase
    .from("brand_integrations")
    .select("id, brand_container_id, shop_domain, access_token, metadata")
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Integration not found: ${integrationId}`);
  if (!data.access_token) throw new Error(`No access_token for integration ${integrationId}`);
  return data;
}

async function getOrgIdFromContainer(brandContainerId) {
  const { data } = await supabase
    .from("brand_containers")
    .select("organization_id")
    .eq("id", brandContainerId)
    .maybeSingle();
  return data?.organization_id || null;
}

// ── shopify_initial_bootstrap (job padre) ───────────────────────────────────

async function processInitialBootstrap(job) {
  const { brand_integration_id, brand_container_id, shop_domain } = job.payload || {};
  if (!brand_integration_id) throw new Error("Missing brand_integration_id");
  if (!brand_container_id)   throw new Error("Missing brand_container_id");

  // Marcar inicio
  await supabase
    .from("brand_integrations")
    .update({
      bootstrap_status:     "running",
      bootstrap_started_at: new Date().toISOString(),
    })
    .eq("id", brand_integration_id);

  const orgId = await getOrgIdFromContainer(brand_container_id);
  if (!orgId) throw new Error("Cannot resolve organization_id");

  // Encolar 12 subjobs con run_after escalonado para evitar concurrencia y rate limit
  const now = Date.now();
  const subjobRows = SUBJOB_SEQUENCE.map((mt, i) => ({
    organization_id: orgId,
    job_type:        "mission",
    priority:        4,
    payload: {
      mission_type:         mt,
      brand_integration_id,
      brand_container_id,
      shop_domain,
      parent_job_id:        job.id,
      bootstrap_step:       i + 1,
      bootstrap_total_steps: SUBJOB_SEQUENCE.length,
    },
    status:    "queued",
    run_after: new Date(now + i * SUBJOB_SPACING_MS).toISOString(),
  }));

  const { data: inserted, error } = await supabase
    .from("agent_queue_jobs")
    .insert(subjobRows)
    .select("id");
  if (error) throw error;

  return {
    ok:          true,
    encoladas:   inserted.length,
    spacing_ms:  SUBJOB_SPACING_MS,
    subjob_ids:  inserted.map(r => r.id),
  };
}

// ── shopify_sync_shop_metadata (REAL) ───────────────────────────────────────

async function syncShopMetadata(job) {
  const { brand_integration_id, shop_domain } = job.payload;
  const integ = await getIntegration(brand_integration_id);
  const useShop = shop_domain || integ.shop_domain;

  const { data } = await shopifyRestGet(useShop, integ.access_token, "/shop.json");
  const shop = data?.shop || {};

  const newMeta = {
    ...(integ.metadata || {}),
    shop_id:           shop.id != null ? String(shop.id) : null,
    shop_name:         shop.name || null,
    shop_email:        shop.email || null,
    shop_country:      shop.country_code || null,
    shop_currency:     shop.currency || null,
    shop_timezone:     shop.iana_timezone || null,
    shopify_plan_name: shop.plan_display_name || shop.plan_name || null,
    myshopify_domain:  shop.myshopify_domain || useShop,
    primary_locale:    shop.primary_locale || null,
    shop_metadata_synced_at: new Date().toISOString(),
  };

  await supabase
    .from("brand_integrations")
    .update({ metadata: newMeta, last_sync_at: new Date().toISOString() })
    .eq("id", brand_integration_id);

  return {
    ok:       true,
    plan:     newMeta.shopify_plan_name,
    country:  newMeta.shop_country,
    currency: newMeta.shop_currency,
  };
}

// ── shopify_sync_products (REAL básico, REST paginado) ─────────────────────

async function syncProducts(job) {
  const { brand_integration_id, brand_container_id, shop_domain } = job.payload;
  const integ = await getIntegration(brand_integration_id);
  const useShop = shop_domain || integ.shop_domain;

  const orgId = await getOrgIdFromContainer(brand_container_id);
  if (!orgId) throw new Error("Cannot resolve organization_id");

  const { items: products, pages, truncated } = await shopifyRestGetAllPages(
    useShop,
    integ.access_token,
    "/products.json",
    { limit: 250, maxPages: 50 }
  );

  // Mapear a external_resource_map.
  // NOTA: NO importamos a public.products todavía (eso requiere brand_entities como
  // parent + decisiones de mapping de variantes/imágenes). Solo persistimos referencia
  // + metadata mínima para que Vera pueda razonar después en fase 2B.
  const mapRows = products.map((p) => ({
    organization_id:      orgId,
    brand_integration_id,
    internal_table:       "shopify_product_pending_import",
    internal_id:          null,
    external_platform:    "shopify",
    external_id:          String(p.id),
    external_handle:      p.handle || null,
    external_url:         (useShop && p.handle) ? `https://${useShop}/products/${p.handle}` : null,
    sync_direction:       "bidirectional",
    metadata: {
      title:          p.title || null,
      vendor:         p.vendor || null,
      product_type:   p.product_type || null,
      tags:           p.tags || null,
      status:         p.status || null,
      images_count:   Array.isArray(p.images) ? p.images.length : 0,
      variants_count: Array.isArray(p.variants) ? p.variants.length : 0,
      first_variant_price: p.variants?.[0]?.price || null,
      created_at:     p.created_at || null,
      updated_at:     p.updated_at || null,
    },
    last_pulled_at: new Date().toISOString(),
  }));

  let upserted = 0;
  if (mapRows.length > 0) {
    const { error, count } = await supabase
      .from("external_resource_map")
      .upsert(mapRows, {
        onConflict: "brand_integration_id,external_platform,external_id",
        count:      "exact",
      });
    if (error) throw error;
    upserted = count ?? mapRows.length;
  }

  return {
    ok:                true,
    products_pulled:   products.length,
    products_upserted: upserted,
    pages_fetched:     pages,
    truncated_at_max:  truncated,
  };
}

// ── STUB: subjobs no implementados ──────────────────────────────────────────

async function stubSubjob(job) {
  const mt = job?.payload?.mission_type;
  console.log(`shopify-bootstrap: STUB subjob ${mt} (placeholder hasta fase 2B)`);
  return {
    ok:           true,
    status:       "stub",
    mission_type: mt,
    note:         "Implementación real pendiente — fase 2B",
  };
}

// ── REAL básico: vera_propose_priority_actions ──────────────────────────────
// Marca el bootstrap como completed + inserta 1 placeholder en vera_pending_actions
// para que el frontend pueda mostrar "Vera ya escaneó tu tienda".

async function proposeStarterActions(job) {
  const { brand_integration_id, brand_container_id } = job.payload;
  if (!brand_integration_id) throw new Error("Missing brand_integration_id");
  if (!brand_container_id)   throw new Error("Missing brand_container_id");

  const orgId = await getOrgIdFromContainer(brand_container_id);
  if (!orgId) throw new Error("Cannot resolve organization_id");

  // Contar productos pulled
  const { count: productCount } = await supabase
    .from("external_resource_map")
    .select("*", { count: "exact", head: true })
    .eq("brand_integration_id", brand_integration_id)
    .eq("external_platform",   "shopify")
    .eq("internal_table",      "shopify_product_pending_import");

  // Insertar 1 propuesta placeholder con batch_id común
  const batchId = crypto.randomUUID();
  await supabase.from("vera_pending_actions").insert({
    organization_id:    orgId,
    brand_container_id,
    proposed_by_agent_id: null,
    action_type:        "update_shopify_product_seo",
    target_table:       "products",
    target_id:          null,
    proposed_payload: {
      summary: "Bootstrap inicial completado. Vera escaneó tu tienda y propondrá optimizaciones SEO/GEO específicas en la próxima fase.",
      placeholder: true,
      batch_id:   batchId,
      products_indexed: productCount || 0,
    },
    current_state: { products_pulled: productCount || 0 },
    vera_reasoning: "Bootstrap stub: análisis profundo (SEO/voice/imagery/gaps) implementado en fase 2B.",
    vera_confidence: 0.5,
    impact_estimate: { engagement_lift_pct: null, revenue_impact_usd: null },
    status: "pending",
    priority: 5,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30d
  });

  // Marcar bootstrap como completed (este es el último subjob de la secuencia)
  await supabase
    .from("brand_integrations")
    .update({
      bootstrap_status:       "completed",
      bootstrap_completed_at: new Date().toISOString(),
    })
    .eq("id", brand_integration_id);

  return {
    ok:                  true,
    status:              "bootstrap_completed",
    products_indexed:    productCount || 0,
    placeholder_batch_id: batchId,
  };
}
