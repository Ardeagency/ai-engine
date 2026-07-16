/**
 * recommendation-cadence.service.js — cadencia de recomendaciones DISPARADA POR
 * EVIDENCIA, no solo por reloj (fila 28 del roadmap CMO).
 *
 * Contexto: la generacion de recomendaciones (generateStrategyReviewForBrand) corre
 * como sensor `strategic_review` con cadencia DIARIA (brand-sensor-sync) + tras cada
 * scrape, y el contention_guard ya la SALTA si no hay evidencia nueva suficiente.
 * Lo que faltaba: PRONTITUD — que una señal fuerte (crisis/amenaza, spike de menciones,
 * gap confirmado) dispare la revision YA, sin esperar al tick diario.
 *
 * Enfoque aditivo y de bajo riesgo: NO reescribimos el scheduler. Adelantamos el
 * sensor poniendo su `next_run_at = now()` para que el proximo poll (cada pocos min)
 * lo levante. Debounce por `last_run_at` para no thrashear (el contention_guard
 * igual gatea la calidad; el debounce ahorra el costo LLM de revisiones repetidas).
 *
 * El reloj diario queda como PISO de seguridad; la evidencia solo acelera.
 */
import { supabase } from "../lib/supabase.js";

const DEFAULT_MIN_GAP_MIN = parseInt(process.env.STRATEGIC_REVIEW_MIN_GAP_MIN || "60", 10);

/**
 * Adelanta el sensor `strategic_review` de una marca ante evidencia real.
 * @param {string} brandContainerId
 * @param {string} reason  — por que se dispara (crisis, spike, gap...). Se loguea.
 * @param {object} [opts]
 * @param {number} [opts.minGapMinutes]  — no re-disparar si corrio hace menos de esto.
 * @returns {Promise<{bumped:boolean, reason:string, skipped?:string}>}
 */
export async function bumpStrategicReviewOnEvidence(brandContainerId, reason, opts = {}) {
  if (!brandContainerId) return { bumped: false, reason, skipped: "sin brandContainerId" };
  const minGap = Number.isFinite(opts.minGapMinutes) ? opts.minGapMinutes : DEFAULT_MIN_GAP_MIN;

  try {
    const { data: trig, error } = await supabase
      .from("monitoring_triggers")
      .select("id, last_run_at, next_run_at, status")
      .eq("brand_container_id", brandContainerId)
      .eq("sensor_type", "strategic_review")
      .is("entity_id", null)
      .maybeSingle();

    if (error) { console.warn(`[rec-cadence] lookup falló brand=${brandContainerId}: ${error.message}`); return { bumped: false, reason, skipped: "lookup_error" }; }
    if (!trig) return { bumped: false, reason, skipped: "sin sensor strategic_review" };
    if (trig.status && !["active", "trial", "past_due"].includes(trig.status)) {
      return { bumped: false, reason, skipped: `sensor ${trig.status}` };
    }

    // Debounce: si corrio hace poco, no re-disparar (evita treadmill de revisiones).
    if (trig.last_run_at) {
      const ageMin = (Date.now() - new Date(trig.last_run_at).getTime()) / 60000;
      if (ageMin < minGap) return { bumped: false, reason, skipped: `corrio hace ${Math.round(ageMin)}min (<${minGap})` };
    }
    // Si ya esta vencido (next_run_at <= now), no hace falta adelantarlo.
    if (trig.next_run_at && new Date(trig.next_run_at).getTime() <= Date.now()) {
      return { bumped: false, reason, skipped: "ya estaba due" };
    }

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("monitoring_triggers")
      .update({ next_run_at: now, updated_at: now })
      .eq("id", trig.id);
    if (upErr) { console.warn(`[rec-cadence] bump falló brand=${brandContainerId}: ${upErr.message}`); return { bumped: false, reason, skipped: "update_error" }; }

    console.log(`[rec-cadence] strategic_review ADELANTADO brand=${brandContainerId} por evidencia: ${reason}`);
    return { bumped: true, reason };
  } catch (e) {
    console.warn(`[rec-cadence] excepción brand=${brandContainerId}: ${e.message}`);
    return { bumped: false, reason, skipped: "exception" };
  }
}
