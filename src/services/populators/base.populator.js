/**
 * base.populator.js
 *
 * Contrato común para todos los populators de plataformas (Shopify, Amazon,
 * Mercado Libre, WooCommerce, etc.).
 *
 * El job-worker invoca al populator vía populator-registry.js, NO importa
 * cada concreto directamente. Esto permite añadir nuevas plataformas sin
 * tocar el worker.
 *
 * Cada populator concreto extiende esta clase e implementa al menos:
 *   - bootstrap(integration, jobPayload)         (encola subjobs propios)
 *   - syncProducts(integration, jobPayload)      (importa a `products` + dedupe + imágenes)
 *   - subjobSequence()                            (lista ordenada de mission_types propios)
 *
 * Opcionalmente:
 *   - syncOrders, syncCustomers, syncCollections, etc.
 *
 * Convención de mission_type:
 *   <platform>_initial_bootstrap
 *   <platform>_sync_<resource>
 *   vera_analysis_<platform>_<aspect>
 */
import { supabase } from "../../lib/supabase.js";
import { decryptIntegrationRow } from "../../lib/integration-token-vault.js";
import { findMatchingProduct, logDedupeDecision } from "./dedupe.service.js";
import { downloadAndStoreMany } from "./image-pipeline.service.js";

export class BasePopulator {
  /** @param {string} platform e.g. 'shopify' */
  constructor(platform) {
    if (!platform) throw new Error("BasePopulator: platform required");
    this.platform = platform;
  }

  /** Orden secuencial de subjobs que el bootstrap encolará. Override. */
  subjobSequence() { return []; }

  /** Mission_types que ESTE populator maneja. Override. */
  handles() {
    return [
      `${this.platform}_initial_bootstrap`,
      ...this.subjobSequence(),
    ];
  }

  /** Punto de entrada genérico desde el job-worker. */
  async process(job) {
    const mt = job?.payload?.mission_type;
    if (!mt) throw new Error(`${this.platform}: missing mission_type`);

    if (mt === `${this.platform}_initial_bootstrap`) return this.bootstrap(job);

    const handler = this.dispatch(mt);
    if (!handler) throw new Error(`${this.platform}: unknown mission_type ${mt}`);
    return handler.call(this, job);
  }

  /** Default dispatch: convierte mission_type → método. Override si quieres. */
  dispatch(missionType) {
    const map = {};
    map[`${this.platform}_sync_products`] = this.syncProducts;
    map[`${this.platform}_sync_orders`] = this.syncOrders;
    map[`${this.platform}_sync_customers`] = this.syncCustomers;
    return map[missionType] || null;
  }

  /** Override en cada populator. */
  async bootstrap(_job) {
    throw new Error(`${this.platform}: bootstrap() not implemented`);
  }

  // ── Defaults: stubs que se pueden sobrescribir ──────────────────────────
  async syncProducts(job) {
    return { ok: true, status: "stub", mission_type: job?.payload?.mission_type, platform: this.platform };
  }
  async syncOrders(job)    { return { ok: true, status: "stub", platform: this.platform }; }
  async syncCustomers(job) { return { ok: true, status: "stub", platform: this.platform }; }

  // ── Helpers compartidos ─────────────────────────────────────────────────

  async getIntegration(integrationId) {
    const { data, error } = await supabase
      .from("brand_integrations")
      .select("id, brand_container_id, platform, shop_domain, access_token, refresh_token, token_expires_at, metadata, scope")
      .eq("id", integrationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Integration not found: ${integrationId}`);
    decryptIntegrationRow(data);
    return data;
  }

  async getOrgIdFromContainer(brandContainerId) {
    const { data } = await supabase
      .from("brand_containers")
      .select("organization_id")
      .eq("id", brandContainerId)
      .maybeSingle();
    return data?.organization_id || null;
  }

  /**
   * Encola los subjobs del bootstrap con run_after escalonado para evitar
   * picos de rate limit. El último subjob es `vera_propose_priority_actions`,
   * que marca bootstrap_status='completed'.
   */
  async enqueueSubjobs(parentJob, { spacingMs = 30_000 } = {}) {
    const sequence = this.subjobSequence();
    if (!sequence.length) return { encoladas: 0 };

    const { brand_integration_id, brand_container_id } = parentJob.payload || {};
    const orgId = await this.getOrgIdFromContainer(brand_container_id);
    if (!orgId) throw new Error("Cannot resolve organization_id");

    const now = Date.now();
    const rows = sequence.map((mt, i) => ({
      organization_id: orgId,
      job_type:        "mission",
      priority:        4,
      payload: {
        mission_type:          mt,
        brand_integration_id,
        brand_container_id,
        platform:              this.platform,
        parent_job_id:         parentJob.id,
        bootstrap_step:        i + 1,
        bootstrap_total_steps: sequence.length,
      },
      status:    "queued",
      run_after: new Date(now + i * spacingMs).toISOString(),
    }));

    const { data: inserted, error } = await supabase
      .from("agent_queue_jobs")
      .insert(rows)
      .select("id");
    if (error) throw error;
    return { encoladas: inserted.length, subjob_ids: inserted.map(r => r.id), spacing_ms: spacingMs };
  }

  /**
   * Importa un producto externo a la tabla canónica `products` con dedupe +
   * imágenes descargadas al bucket. Es el corazón del autopoblador.
   *
   * @param {object} args
   *   - rawProduct: objeto bruto de la plataforma (forma específica del populator)
   *   - normalized: { name, description, price, currency, type_enum, url, images:[{url,alt}], variants:[...] }
   *   - integration: row de brand_integrations
   * @returns {object} { product_id, decision, similarity_score, images_stored, ... }
   */
  async upsertCanonicalProduct({ normalized, integration, rawProduct }) {
    const brandContainerId = integration.brand_container_id;
    const organizationId = await this.getOrgIdFromContainer(brandContainerId);
    if (!organizationId) throw new Error("Cannot resolve organization_id");

    // 1) ¿ya existe vía external_resource_map para ESTE platform+external_id?
    const externalId = String(normalized.external_id);
    const { data: existingMap } = await supabase
      .from("external_resource_map")
      .select("internal_id")
      .eq("brand_container_id", brandContainerId)
      .eq("external_platform",  this.platform)
      .eq("external_id",        externalId)
      .eq("internal_table",     "products")
      .maybeSingle();

    let productId = existingMap?.internal_id || null;
    let decision = productId ? "linked_existing" : null;
    let similarityScore = productId ? 1.0 : null;
    let matchReason = productId ? "exact_external_id_resync" : null;

    // 2) Si no había map, intenta dedupe por nombre / cross-platform
    if (!productId) {
      const match = await findMatchingProduct({
        brandContainerId,
        name:        normalized.name,
        externalId:  externalId,
        platform:    this.platform,
      });
      decision = match.decision;
      similarityScore = match.similarity_score;
      matchReason = match.match_reason;

      if (match.decision === "linked_existing" && match.matched_product_id) {
        productId = match.matched_product_id;
      }
    }

    // 3) Si NO hay match: crear producto
    if (!productId) {
      const { data: created, error } = await supabase
        .from("products")
        .insert({
          organization_id:      organizationId,
          brand_container_id:   brandContainerId,
          tipo_producto:        normalized.tipo_producto || "fisico",
          nombre_producto:      normalized.name,
          descripcion_producto: normalized.description || normalized.name,
          precio_producto:      normalized.price ?? null,
          moneda:               normalized.currency || null,
          url_producto:         normalized.url || null,
          primary_platform:     this.platform,
          primary_external_id:  externalId,
          created_via:          `${this.platform}_bootstrap`,
          metadata:             { source_raw_keys: Object.keys(rawProduct || {}) },
        })
        .select("id")
        .single();
      if (error) throw error;
      productId = created.id;
    }

    // 4) Persistir / refrescar el link en external_resource_map
    const { error: ermErr } = await supabase.from("external_resource_map").upsert({
      brand_container_id:    brandContainerId,
      organization_id:       organizationId,
      brand_integration_id:  integration.id,
      internal_table:        "products",
      internal_id:           productId,
      external_platform:     this.platform,
      external_id:           externalId,
      external_handle:       normalized.handle || null,
      external_url:          normalized.url || null,
      sync_direction:        "bidirectional",
      metadata:              normalized.metadata || {},
      last_synced_at:        new Date().toISOString(),
      last_pulled_at:        new Date().toISOString(),
    }, { onConflict: "brand_container_id,external_platform,external_id,internal_table" });
    if (ermErr) {
      console.error(`[populator/${this.platform}] ERM upsert error for product ${productId}:`, ermErr.message, ermErr.details || "");
    }

    // 5) Imágenes: descargar a bucket y registrar en product_images
    let imagesStored = 0;
    if (Array.isArray(normalized.images) && normalized.images.length > 0) {
      const downloads = normalized.images.map((img, i) => ({
        url:              img.url,
        brandContainerId: brandContainerId,
        productId:        productId,
        suffix:           `${this.platform}-${i + 1}`,
      }));
      const results = await downloadAndStoreMany(downloads, { concurrency: 3 });

      const rows = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const src = normalized.images[i];
        if (r.ok) {
          rows.push({
            product_id:        productId,
            image_url:         r.public_url,    // pública, generada del bucket — NO la URL externa
            storage_path:      r.storage_path,
            external_platform: this.platform,
            external_id:       src?.external_id || null,
            bytes:             r.bytes,
            mime_type:         r.mime_type,
            width:             r.width,
            height:             r.height,
            image_type:        "product",
            image_order:       i,
            download_status:   "stored",
          });
        } else {
          rows.push({
            product_id:        productId,
            image_url:         null,
            external_platform: this.platform,
            external_id:       src?.external_id || null,
            image_type:        "product",
            image_order:       i,
            download_status:   "failed",
          });
        }
      }
      // Upsert por (product_id, storage_path) para evitar duplicar al re-sync
      const storedRows = rows.filter(r => r.storage_path);
      const failedRows = rows.filter(r => !r.storage_path);
      if (storedRows.length > 0) {
        const { error: imgErr } = await supabase
          .from("product_images")
          .upsert(storedRows, { onConflict: "product_id,storage_path" });
        if (imgErr) console.error(`[populator/${this.platform}] image upsert error:`, imgErr.message);
      }
      if (failedRows.length > 0) {
        await supabase.from("product_images").insert(failedRows);
      }
      imagesStored = storedRows.length;
    }

    // 6) Audit log de la decisión
    await logDedupeDecision({
      brandContainerId,
      organizationId,
      productId,
      externalPlatform:        this.platform,
      externalId,
      externalName:            normalized.name,
      decision,
      matchedAgainstProductId: decision === "created" ? null : productId,
      similarityScore,
      matchReason,
      rawPayload:              { handle: normalized.handle || null, url: normalized.url || null },
    });

    return { product_id: productId, decision, similarity_score: similarityScore, images_stored: imagesStored };
  }

  // ── Campañas ────────────────────────────────────────────────────────────
  /**
   * Importa una campaña externa a `campaigns` (canónica). Upsert por
   * (integration_id, external_campaign_id) — la unique constraint existente
   * `campaigns_unique_external` garantiza que cada re-sync actualiza la misma fila.
   *
   * @param {object} args
   *   - normalized: {
   *       external_id, external_name, status, platform_objective, cta, cta_url,
   *       starts_at, ends_at, budget_daily, budget_total, budget_currency,
   *       cached: { impressions, clicks, spend, conversions, roas, ctr },
   *       external_adset_id, external_account_id, persona_id (optional),
   *       metadata
   *     }
   *   - integration: row de brand_integrations
   * @returns {object} { campaign_id, decision, similarity_score }
   */
  async upsertCanonicalCampaign({ normalized, integration }) {
    const brandContainerId = integration.brand_container_id;
    const organizationId = await this.getOrgIdFromContainer(brandContainerId);
    if (!organizationId) throw new Error("Cannot resolve organization_id");

    const externalId = String(normalized.external_id);
    const cached = normalized.cached || {};
    const platformValue = mapToCampaignsPlatform(this.platform, normalized);
    const statusValue   = mapCampaignStatus(normalized.status);

    const row = {
      organization_id:        organizationId,
      brand_container_id:     brandContainerId,
      integration_id:         integration.id,
      platform:               platformValue,
      external_campaign_id:   externalId,
      external_campaign_name: normalized.external_name || null,
      external_adset_id:      normalized.external_adset_id || null,
      external_account_id:    normalized.external_account_id || null,
      persona_id:             normalized.persona_id || null,
      brief_id:               normalized.brief_id || null,
      nombre_campana:         normalized.external_name || normalized.name || externalId,
      descripcion_interna:    normalized.descripcion_interna || null,
      platform_objective:     normalized.platform_objective || null,
      cta:                    normalized.cta || null,
      cta_url:                normalized.cta_url || null,
      budget_daily:           normalized.budget_daily ?? null,
      budget_total:           normalized.budget_total ?? null,
      budget_currency:        normalized.budget_currency || null,
      starts_at:              normalized.starts_at || null,
      ends_at:                normalized.ends_at || null,
      status:                 statusValue,
      cached_impressions:     cached.impressions ?? null,
      cached_clicks:          cached.clicks ?? null,
      cached_spend:           cached.spend ?? null,
      cached_conversions:     cached.conversions ?? null,
      cached_roas:            cached.roas ?? null,
      cached_ctr:             cached.ctr ?? null,
      metrics_cached_at:      Object.keys(cached).length ? new Date().toISOString() : null,
      last_synced_at:         new Date().toISOString(),
      source:                 "imported",
      created_via:            `${this.platform}_bootstrap`,
      metadata:               normalized.metadata || {},
    };

    const { data, error } = await supabase
      .from("campaigns")
      .upsert(row, { onConflict: "integration_id,external_campaign_id" })
      .select("id")
      .maybeSingle();
    if (error) throw error;

    const campaignId = data?.id;

    // Audit (decision: created si la fila es nueva)
    await this.logDedupe({
      brandContainerId, organizationId,
      entityTable: "campaigns", entityId: campaignId,
      externalPlatform: this.platform, externalId, externalName: normalized.external_name || null,
      decision: "linked_existing",  // No hacemos fuzzy match en campaigns por ahora; upsert por unique key
      matchedAgainstId: campaignId,
      similarityScore: 1.0,
      matchReason: "exact_external_id_per_integration",
      rawPayload: { status: normalized.status, objective: normalized.platform_objective },
    });

    return { campaign_id: campaignId, decision: "upserted", similarity_score: 1.0 };
  }

  // ── Audience Segments ──────────────────────────────────────────────────
  /**
   * Importa un segmento de audiencia (Custom Audience Meta, Audience Google Ads,
   * etc.) a `audience_segments`. Upsert por unique constraint
   * `audience_segments_unique_external` (integration_id, external_audience_id).
   *
   * NO intenta fuzzy match contra otros segments. SÍ intenta linkear a una
   * persona conceptual existente vía heurística simple (nombre contiene → match).
   * El AI enrichment posterior (`vera_link_segment_to_persona`) refina.
   *
   * @param {object} args
   *   - normalized: {
   *       external_id, external_name, external_type, status,
   *       age_range, genders, locations, interests, behaviors, income_tiers,
   *       languages, custom_params, estimated_size, size_lower_bound,
   *       size_upper_bound, persona_id (optional)
   *     }
   *   - integration
   * @returns { segment_id, decision }
   */
  async upsertCanonicalAudienceSegment({ normalized, integration }) {
    const brandContainerId = integration.brand_container_id;
    const organizationId = await this.getOrgIdFromContainer(brandContainerId);
    if (!organizationId) throw new Error("Cannot resolve organization_id");

    const externalId = String(normalized.external_id);

    // Intenta linkear a una persona existente por nombre (heurística leve)
    let personaId = normalized.persona_id || null;
    if (!personaId && normalized.external_name) {
      const lcName = String(normalized.external_name).toLowerCase();
      const { data: personas } = await supabase
        .from("audience_personas")
        .select("id, name")
        .eq("brand_container_id", brandContainerId)
        .limit(50);
      const match = (personas || []).find(p => {
        const pn = String(p.name || "").toLowerCase();
        return pn && (lcName.includes(pn) || pn.includes(lcName));
      });
      if (match) personaId = match.id;
    }

    const row = {
      organization_id:        organizationId,
      brand_container_id:     brandContainerId,
      integration_id:         integration.id,
      persona_id:             personaId,
      campaign_id:            normalized.campaign_id || null,
      platform:               mapToSegmentsPlatform(this.platform),
      external_audience_id:   externalId,
      external_audience_name: normalized.external_name || null,
      external_audience_type: normalized.external_type || null,
      age_range:              normalized.age_range || null,
      genders:                normalized.genders || null,
      locations:              normalized.locations || null,
      interests:              normalized.interests || null,
      behaviors:              normalized.behaviors || null,
      income_tiers:           normalized.income_tiers || null,
      languages:              normalized.languages || null,
      custom_params:          normalized.custom_params || null,
      estimated_size:         normalized.estimated_size ?? null,
      size_lower_bound:       normalized.size_lower_bound ?? null,
      size_upper_bound:       normalized.size_upper_bound ?? null,
      status:                 mapSegmentStatus(normalized.status),
      last_synced_at:         new Date().toISOString(),
      source:                 "imported",
      created_via:            `${this.platform}_bootstrap`,
    };

    const { data, error } = await supabase
      .from("audience_segments")
      .upsert(row, { onConflict: "integration_id,external_audience_id" })
      .select("id")
      .maybeSingle();
    if (error) throw error;

    const segmentId = data?.id;

    await this.logDedupe({
      brandContainerId, organizationId,
      entityTable: "audience_segments", entityId: segmentId,
      externalPlatform: this.platform, externalId, externalName: normalized.external_name || null,
      decision: personaId ? "linked_existing" : "created",
      matchedAgainstId: personaId,
      similarityScore: personaId ? 0.8 : 0,
      matchReason: personaId ? "heuristic_name_contains" : "no_persona_match_yet",
      rawPayload: { status: normalized.status, type: normalized.external_type },
    });

    return { segment_id: segmentId, persona_linked: !!personaId };
  }

  // ── Helper: log unificado de decisiones de dedupe ───────────────────────
  async logDedupe({ brandContainerId, organizationId, entityTable, entityId, externalPlatform, externalId, externalName, decision, matchedAgainstId, similarityScore, matchReason, rawPayload }) {
    try {
      await supabase.from("populator_dedupe_log").insert({
        brand_container_id: brandContainerId,
        organization_id:    organizationId,
        entity_table:       entityTable,
        entity_id:          entityId,
        external_platform:  externalPlatform,
        external_id:        String(externalId),
        external_name:      externalName,
        decision,
        matched_against_id: matchedAgainstId,
        similarity_score:   similarityScore,
        match_reason:       matchReason,
        raw_payload:        rawPayload || null,
      });
    } catch (e) {
      console.warn(`[populator/${this.platform}] dedupe log skipped:`, e?.message || e);
    }
  }
}

// ── Mappers: alinear values del populator con los CHECK constraints de DB ───

// campaigns.platform CHECK ⊇ {meta_facebook, meta_instagram, google_ads, tiktok_ads, linkedin_ads, pinterest_ads, organic, internal}
function mapToCampaignsPlatform(populatorPlatform, normalized) {
  const obj = String(normalized?.platform_objective || "").toUpperCase();
  // Heurística: si el objective menciona Instagram, usar meta_instagram
  if (populatorPlatform === "facebook" && /INSTAGRAM/.test(obj)) return "meta_instagram";
  const map = {
    facebook:    "meta_facebook",
    instagram:   "meta_instagram",
    google:      "google_ads",
    google_ads:  "google_ads",
    tiktok:      "tiktok_ads",
    tiktok_ads:  "tiktok_ads",
    linkedin:    "linkedin_ads",
    pinterest:   "pinterest_ads",
  };
  return map[populatorPlatform] || populatorPlatform;
}

// audience_segments.platform CHECK ⊇ {meta, google_ads, tiktok_ads, linkedin_ads, pinterest_ads}
function mapToSegmentsPlatform(populatorPlatform) {
  const map = {
    facebook:    "meta",
    instagram:   "meta",
    google:      "google_ads",
    google_ads:  "google_ads",
    tiktok:      "tiktok_ads",
    tiktok_ads:  "tiktok_ads",
    linkedin:    "linkedin_ads",
    pinterest:   "pinterest_ads",
  };
  return map[populatorPlatform] || populatorPlatform;
}

// campaigns.status CHECK ⊇ {draft, conceptual, active, paused, ended, archived}
function mapCampaignStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "draft";
  if (s.includes("active"))   return "active";
  if (s.includes("paused"))   return "paused";
  if (s.includes("complete") || s.includes("ended") || s.includes("finished")) return "ended";
  if (s.includes("delete")    || s.includes("archive")) return "archived";
  if (s.includes("draft"))    return "draft";
  if (s.includes("review")    || s.includes("pending"))  return "draft";
  return "draft";
}

// audience_segments.status CHECK ⊇ {draft, active, paused, deleted, error}
function mapSegmentStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "active";
  if (s.includes("active"))  return "active";
  if (s.includes("paused"))  return "paused";
  if (s.includes("delete"))  return "deleted";
  if (s.includes("error"))   return "error";
  if (s.includes("draft"))   return "draft";
  return "active";
}
