/**
 * woocommerce.populator.js — STUB
 *
 * Pendiente: WooCommerce REST API (WP REST + Woo REST):
 *   GET /wp-json/wc/v3/products?per_page=100 → productos
 *   GET /wp-json/wc/v3/products/{id}/variations → variants
 *   product.images[] → descargar a bucket.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";

export class WooCommercePopulator extends BasePopulator {
  constructor() { super("woocommerce"); }

  subjobSequence() {
    return [
      "woocommerce_sync_store_metadata",
      "woocommerce_sync_products",
      "woocommerce_sync_orders",
      "woocommerce_sync_customers",
    ];
  }

  async bootstrap(job) {
    const { brand_integration_id } = job.payload || {};
    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:     "running",
        bootstrap_started_at: new Date().toISOString(),
        metadata:             { populator_status: "stub_phase_1", note: "WooCommerce integration TBD" },
      })
      .eq("id", brand_integration_id);
    return this.enqueueSubjobs(job);
  }

  dispatch(missionType) {
    if (missionType.startsWith("woocommerce_sync_")) return this.stubSync;
    return null;
  }

  async stubSync(job) {
    return { ok: true, status: "stub", platform: "woocommerce", mission_type: job?.payload?.mission_type };
  }
}
