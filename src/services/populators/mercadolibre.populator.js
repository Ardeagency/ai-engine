/**
 * mercadolibre.populator.js — STUB
 *
 * Pendiente: API ML usa OAuth2 + items REST.
 *   GET /users/{userId}/items/search → ids
 *   GET /items/{id} → producto + pictures (descargar a bucket).
 *   GET /orders/search?seller=... → órdenes.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";

export class MercadoLibrePopulator extends BasePopulator {
  constructor() { super("mercadolibre"); }

  subjobSequence() {
    return [
      "mercadolibre_sync_user_metadata",
      "mercadolibre_sync_products",
      "mercadolibre_sync_orders",
    ];
  }

  async bootstrap(job) {
    const { brand_integration_id } = job.payload || {};
    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:     "running",
        bootstrap_started_at: new Date().toISOString(),
        metadata:             { populator_status: "stub_phase_1", note: "ML API integration TBD" },
      })
      .eq("id", brand_integration_id);
    return this.enqueueSubjobs(job);
  }

  dispatch(missionType) {
    if (missionType.startsWith("mercadolibre_sync_")) return this.stubSync;
    return null;
  }

  async stubSync(job) {
    return { ok: true, status: "stub", platform: "mercadolibre", mission_type: job?.payload?.mission_type };
  }
}
