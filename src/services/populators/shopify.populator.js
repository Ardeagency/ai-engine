/**
 * shopify.populator.js
 *
 * Reemplaza la lógica de phase 2A (`shopify-bootstrap.service.js`) con phase 2B:
 * importa productos REALES a `products` (no solo a `external_resource_map` staging),
 * descarga imágenes al bucket y deduplica vía base.populator.
 *
 * Mantiene compatibilidad con los mission_types ya encolados.
 */
import crypto from "node:crypto";
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import { shopifyRestGet, shopifyRestGetAllPages } from "../../lib/shopify-rest.js";

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

export class ShopifyPopulator extends BasePopulator {
  constructor() { super("shopify"); }

  subjobSequence() {
    return [
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
  }

  dispatch(missionType) {
    const map = super.dispatch(missionType) || null;
    if (map) return map;
    if (missionType === "shopify_sync_shop_metadata")    return this.syncShopMetadata;
    if (missionType === "shopify_sync_products")         return this.syncProducts;
    if (missionType === "vera_propose_priority_actions") return this.proposeStarterActions;
    if (STUB_SUBJOBS.has(missionType))                   return this.stubSubjob;
    return null;
  }

  async bootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload || {};
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    await supabase
      .from("brand_integrations")
      .update({ bootstrap_status: "running", bootstrap_started_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return this.enqueueSubjobs(job);
  }

  async syncShopMetadata(job) {
    const { brand_integration_id, shop_domain } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);
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

    return { ok: true, plan: newMeta.shopify_plan_name, country: newMeta.shop_country, currency: newMeta.shop_currency };
  }

  async syncProducts(job) {
    const { brand_integration_id, shop_domain } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);
    const useShop = shop_domain || integ.shop_domain;

    const { items: products, pages, truncated } = await shopifyRestGetAllPages(
      useShop, integ.access_token, "/products.json",
      { limit: 250, maxPages: 50 }
    );

    const stats = { products_pulled: products.length, products_created: 0, products_linked: 0, manual_review: 0, images_stored: 0, enrichment_enqueued: 0, errors: 0 };
    const enrichmentJobs = [];
    const orgId = await this.getOrgIdFromContainer(integ.brand_container_id);

    for (const p of products) {
      try {
        const normalized = {
          external_id:   String(p.id),
          name:          p.title || "Sin título",
          description:   p.body_html ? stripHtml(p.body_html) : (p.title || ""),
          price:         p.variants?.[0]?.price ? Number(p.variants[0].price) : null,
          currency:      integ.metadata?.shop_currency || null,
          handle:        p.handle || null,
          url:           (useShop && p.handle) ? `https://${useShop}/products/${p.handle}` : null,
          tipo_producto: mapShopifyProductType(p.product_type, p.tags),
          images: (p.images || []).map((img) => ({
            url: img.src, alt: img.alt || null, external_id: img.id != null ? String(img.id) : null,
          })),
          metadata: {
            shopify_vendor:       p.vendor || null,
            shopify_product_type: p.product_type || null,
            shopify_tags:         p.tags || null,
            shopify_status:       p.status || null,
            variants_count:       Array.isArray(p.variants) ? p.variants.length : 0,
          },
        };

        const result = await this.upsertCanonicalProduct({ normalized, integration: integ, rawProduct: p });
        if (result.decision === "created") stats.products_created++;
        else if (result.decision === "linked_existing") stats.products_linked++;
        else if (result.decision === "manual_review") stats.manual_review++;
        stats.images_stored += result.images_stored || 0;

        // Encolar enrichment AI por cada producto (idempotente — el populator
        // skipea si ya tiene benefits + diff + use_cases). Spacing 2s para
        // suavizar carga al provider Anthropic.
        if (result.product_id && orgId) {
          enrichmentJobs.push({
            organization_id: orgId,
            job_type:        "mission",
            priority:        6,
            payload: {
              mission_type: "vera_enrich_product",
              product_id:    result.product_id,
              source_platform: this.platform,
              parent_job_id: job.id,
            },
            status:    "queued",
            run_after: new Date(Date.now() + (enrichmentJobs.length * 2000)).toISOString(),
          });
        }
      } catch (e) {
        stats.errors++;
        console.error(`shopify-populator: product ${p?.id} failed:`, e?.message);
      }
    }

    if (enrichmentJobs.length > 0) {
      const { data: enq, error } = await supabase
        .from("agent_queue_jobs")
        .insert(enrichmentJobs)
        .select("id");
      if (error) console.error("shopify-populator: enrichment enqueue:", error.message);
      else stats.enrichment_enqueued = enq.length;
    }

    return { ok: true, ...stats, pages_fetched: pages, truncated_at_max: truncated };
  }

  async stubSubjob(job) {
    const mt = job?.payload?.mission_type;
    return { ok: true, status: "stub", mission_type: mt, note: "Implementación real pendiente — fase 2C" };
  }

  async proposeStarterActions(job) {
    // Solo marca el bootstrap como completado. NO insertamos pending_action
    // placeholder: ensucian la bandeja de Optimización con texto stub que no
    // es análisis real. Las recomendaciones reales las generan los sensores
    // (vera_analysis_shopify_*, campaign-performance, etc) cuando hay data.
    const { brand_integration_id, brand_container_id } = job.payload;
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    const { count: productCount } = await supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .eq("brand_container_id", brand_container_id)
      .eq("primary_platform",   "shopify");

    await supabase
      .from("brand_integrations")
      .update({ bootstrap_status: "completed", bootstrap_completed_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return { ok: true, status: "bootstrap_completed", products_indexed: productCount || 0 };
  }
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
}

// Heurística leve Shopify product_type / tags → tipo_producto_enum.
// Si nada matchea, cae en 'otro' (Vera puede refinar después con AI).
function mapShopifyProductType(productType, tags) {
  const txt = `${productType || ""} ${tags || ""}`.toLowerCase();
  const rules = [
    [/bebid|drink|beverage|jugo|juice|cafe|coffee|te |tea/i, "bebida"],
    [/agua|water/i, "agua"],
    [/aliment|food|comida/i, "alimento"],
    [/snack/i, "snack"],
    [/suplement|supplement/i, "suplemento"],
    [/vitamina|vitamin/i, "vitamina"],
    [/skincare|cremas/i, "skincare"],
    [/maquillaj|makeup/i, "maquillaje"],
    [/perfum|fragranc/i, "perfume"],
    [/cabell|hair/i, "cuidado_cabello"],
    [/cosmetic/i, "cosmetico"],
    [/higien|hygien/i, "higiene"],
    [/cuidado.*personal|personal.*care/i, "cuidado_personal"],
    [/smartphone|telefono|iphone|android/i, "smartphone"],
    [/tablet|ipad/i, "tablet"],
    [/electronico|electronic|tech/i, "electronico"],
    [/gadget/i, "gadget"],
    [/ropa|clothing|apparel|shirt|pants/i, "ropa"],
    [/calzado|shoes|sneaker|zapato/i, "calzado"],
    [/accesori.*mod|fashion.*access/i, "accesorio_moda"],
    [/reloj|watch/i, "reloj"],
    [/joyer|jewelry/i, "joyeria"],
    [/fitness|workout|gym/i, "fitness"],
    [/bienestar|wellness/i, "bienestar"],
    [/salud|health/i, "salud"],
    [/decoracion|decor/i, "decoracion"],
    [/muebl|furniture/i, "mueble"],
    [/electrodomestic/i, "electrodomestico"],
    [/hogar|home/i, "hogar"],
    [/educacion|course/i, "educacion"],
    [/financ|finance/i, "financiero"],
    [/entretenimiento|entertainment/i, "entretenimiento"],
    [/libro|book/i, "libro"],
    [/juguete|toy/i, "juguete"],
    [/juego|game/i, "juego"],
    [/automotri|automotive|\bcar\b|veh[ií]cul/i, "automotriz"],
    [/deportiv|sport/i, "deportivo"],
    [/servic|service/i, "servicio"],
  ];
  for (const [re, label] of rules) {
    if (re.test(txt)) return label;
  }
  return "otro";
}
