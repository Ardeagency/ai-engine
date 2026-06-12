/**
 * mercadolibre.populator.js — Fase 2 (reemplaza el stub).
 *
 * Importa el catálogo REAL del vendedor de Mercado Libre a `products`:
 *   GET /users/me                       → metadata del vendedor (merge, no clobber)
 *   GET /users/{id}/items/search (scan) → ids de publicaciones
 *   GET /items?ids=...                  → items + pictures
 *   GET /items/{id}/description         → descripción (clave para SEO/análisis)
 * y delega en base.upsertCanonicalProduct (dedupe + imágenes al bucket + ERM).
 *
 * El token de 6h lo refresca mercadolibre-rest de forma transparente.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import {
  meliGet,
  meliGetAllItemIds,
  meliMultiGetItems,
  meliGetDescription,
} from "../../lib/mercadolibre-rest.js";

export class MercadoLibrePopulator extends BasePopulator {
  constructor() { super("mercadolibre"); }

  subjobSequence() {
    return [
      "mercadolibre_sync_user_metadata",
      "mercadolibre_sync_products",
      "vera_propose_priority_actions", // marca bootstrap_status='completed'
    ];
  }

  dispatch(missionType) {
    if (missionType === "mercadolibre_sync_user_metadata") return this.syncUserMetadata;
    if (missionType === "mercadolibre_sync_products")      return this.syncProducts;
    if (missionType === "vera_propose_priority_actions")   return this.finishBootstrap;
    return null;
  }

  async bootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload || {};
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    // MERGE de metadata (no reemplazar) — corrige el clobber del stub anterior.
    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();

    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:     "running",
        bootstrap_started_at: new Date().toISOString(),
        metadata:             { ...(cur?.metadata || {}), populator_status: "running" },
      })
      .eq("id", brand_integration_id);

    return this.enqueueSubjobs(job);
  }

  async syncUserMetadata(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    const me = await meliGet(integ, "/users/me");
    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();

    const newMeta = {
      ...(cur?.metadata || {}),
      meli_user_id:            me?.id != null ? String(me.id) : null,
      nickname:                me?.nickname || null,
      site_id:                 me?.site_id || null,
      country_id:              me?.country_id || null,
      permalink:               me?.permalink || null,
      user_type:               me?.user_type || null,
      points:                  me?.points ?? null,
      seller_reputation_level: me?.seller_reputation?.level_id || null,
      power_seller_status:     me?.seller_reputation?.power_seller_status || null,
      user_metadata_synced_at: new Date().toISOString(),
    };

    await supabase
      .from("brand_integrations")
      .update({ metadata: newMeta, last_sync_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return { ok: true, nickname: newMeta.nickname, site: newMeta.site_id, reputation: newMeta.seller_reputation_level };
  }

  async syncProducts(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    // user_id del vendedor (robusto: lo confirmamos vía /users/me)
    const me = await meliGet(integ, "/users/me");
    const sellerId = me?.id || integ.metadata?.meli_user_id || integ.external_account_id;
    if (!sellerId) throw new Error("meli-populator: cannot resolve seller user_id");

    const { ids, total, truncated } = await meliGetAllItemIds(integ, sellerId, { maxItems: 5000 });

    const stats = {
      items_listed: ids.length, total_reported: total, products_created: 0,
      products_linked: 0, manual_review: 0, images_stored: 0, enrichment_enqueued: 0, errors: 0,
    };
    const enrichmentJobs = [];
    const orgId = await this.getOrgIdFromContainer(integ.brand_container_id);

    // Multiget en lotes de 20
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      let items = [];
      try {
        items = await meliMultiGetItems(integ, batch);
      } catch (e) {
        stats.errors += batch.length;
        console.error(`meli-populator: multiget batch failed:`, e?.message);
        continue;
      }

      for (const item of items) {
        try {
          const description = (await meliGetDescription(integ, item.id)) || item.title || "";
          const pics = Array.isArray(item.pictures) ? item.pictures : [];

          const normalized = {
            external_id:   String(item.id),
            name:          item.title || "Sin título",
            description:   String(description).slice(0, 4000),
            price:         item.price != null ? Number(item.price) : null,
            currency:      item.currency_id || null,
            handle:        null,
            url:           item.permalink || null,
            tipo_producto: mapMeliTipoProducto(item.title, item.category_id),
            images: pics.map((p) => ({
              url:         p.secure_url || p.url,
              alt:         item.title || null,
              external_id: p.id != null ? String(p.id) : null,
            })),
            metadata: {
              meli_status:           item.status || null,
              meli_category_id:      item.category_id || null,
              meli_listing_type:     item.listing_type_id || null,
              meli_condition:        item.condition || null,
              available_quantity:    item.available_quantity ?? null,
              sold_quantity:         item.sold_quantity ?? null,
              meli_permalink:        item.permalink || null,
              health:                item.health ?? null,
            },
          };

          const result = await this.upsertCanonicalProduct({ normalized, integration: integ, rawProduct: item });
          if (result.decision === "created")               stats.products_created++;
          else if (result.decision === "linked_existing")  stats.products_linked++;
          else if (result.decision === "manual_review")    stats.manual_review++;
          stats.images_stored += result.images_stored || 0;

          // Enrichment AI por producto (idempotente), espaciado 2s.
          if (result.product_id && orgId) {
            enrichmentJobs.push({
              organization_id: orgId,
              job_type:        "mission",
              priority:        6,
              payload: {
                mission_type:    "vera_enrich_product",
                product_id:      result.product_id,
                source_platform: this.platform,
                parent_job_id:   job.id,
              },
              status:    "queued",
              run_after: new Date(Date.now() + enrichmentJobs.length * 2000).toISOString(),
            });
          }
        } catch (e) {
          stats.errors++;
          console.error(`meli-populator: item ${item?.id} failed:`, e?.message);
        }
      }
    }

    if (enrichmentJobs.length > 0) {
      const { data: enq, error } = await supabase
        .from("agent_queue_jobs").insert(enrichmentJobs).select("id");
      if (error) console.error("meli-populator: enrichment enqueue:", error.message);
      else stats.enrichment_enqueued = enq.length;
    }

    await supabase
      .from("brand_integrations")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return { ok: true, ...stats, truncated_at_max: truncated };
  }

  async finishBootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload;
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    const { count } = await supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .eq("brand_container_id", brand_container_id)
      .eq("primary_platform",   "mercadolibre");

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();

    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:       "completed",
        bootstrap_completed_at: new Date().toISOString(),
        metadata:               { ...(cur?.metadata || {}), populator_status: "completed" },
      })
      .eq("id", brand_integration_id);

    return { ok: true, status: "bootstrap_completed", products_indexed: count || 0 };
  }
}

// Heurística leve título/categoría → tipo_producto_enum. Default 'otro' (Vera
// refina después). ML category_id es un código (MLMxxxx) no legible, así que
// nos apoyamos en el título.
function mapMeliTipoProducto(title, categoryId) {
  const txt = `${title || ""} ${categoryId || ""}`.toLowerCase();
  const rules = [
    [/bebid|drink|jugo|cafe|coffee|\bte\b|tea/i, "bebida"],
    [/agua|water/i, "agua"],
    [/aliment|food|comida/i, "alimento"],
    [/snack/i, "snack"],
    [/suplement|supplement|protein/i, "suplemento"],
    [/vitamina|vitamin/i, "vitamina"],
    [/skincare|crema facial|serum/i, "skincare"],
    [/maquillaj|makeup|labial|rimel/i, "maquillaje"],
    [/perfum|fragranc|colonia/i, "perfume"],
    [/cabell|shampoo|hair/i, "cuidado_cabello"],
    [/cosmetic/i, "cosmetico"],
    [/higien|jabon|desodorante/i, "higiene"],
    [/smartphone|celular|telefono|iphone|android/i, "smartphone"],
    [/tablet|ipad/i, "tablet"],
    [/laptop|computador|notebook|electronic|tech/i, "electronico"],
    [/audifono|parlante|gadget/i, "gadget"],
    [/camis|pantalon|vestido|ropa|clothing|jean/i, "ropa"],
    [/zapato|tenis|calzado|sneaker|bota/i, "calzado"],
    [/reloj|watch/i, "reloj"],
    [/joyer|jewelry|anillo|collar|arete/i, "joyeria"],
    [/fitness|mancuerna|gym|entrenamiento/i, "fitness"],
    [/bienestar|wellness/i, "bienestar"],
    [/salud|health|medic/i, "salud"],
    [/decoracion|decor|cuadro/i, "decoracion"],
    [/muebl|silla|mesa|sofa|furniture/i, "mueble"],
    [/electrodomestic|licuadora|nevera|lavadora/i, "electrodomestico"],
    [/hogar|home|cocina/i, "hogar"],
    [/libro|book/i, "libro"],
    [/juguete|toy|peluche/i, "juguete"],
    [/juego|game|consola/i, "juego"],
    [/auto|moto|vehicul|repuesto|llanta/i, "automotriz"],
    [/deportiv|sport|balon|bicicleta/i, "deportivo"],
  ];
  for (const [re, label] of rules) {
    if (re.test(txt)) return label;
  }
  return "otro";
}
