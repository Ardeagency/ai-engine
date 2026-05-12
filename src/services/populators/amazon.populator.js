/**
 * amazon.populator.js — STUB
 *
 * Pendiente: Selling Partner API (SP-API) requiere registro como developer +
 * LWA refresh token. Cuando se implemente, mapear:
 *   GET /catalog/2022-04-01/items?marketplaceIds=...&keywords=... → products.
 *   GET /listings/2021-08-01/items/{sellerId}/{sku} → variants.
 *   GET /aplus/2020-11-01/contentDocuments/... → product_images (descargar a bucket).
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";

export class AmazonPopulator extends BasePopulator {
  constructor() { super("amazon"); }

  subjobSequence() {
    return [
      "amazon_sync_seller_metadata",
      "amazon_sync_products",
      "amazon_sync_orders",
    ];
  }

  async bootstrap(job) {
    const { brand_integration_id } = job.payload || {};
    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:      "running",
        bootstrap_started_at:  new Date().toISOString(),
        metadata:              { populator_status: "stub_phase_1", note: "Amazon SP-API integration TBD" },
      })
      .eq("id", brand_integration_id);
    return this.enqueueSubjobs(job);
  }

  dispatch(missionType) {
    if (missionType.startsWith("amazon_sync_")) return this.stubSync;
    return null;
  }

  async stubSync(job) {
    return { ok: true, status: "stub", platform: "amazon", mission_type: job?.payload?.mission_type };
  }
}
