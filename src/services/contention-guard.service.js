/**
 * Contention Guard — la contención del CMO: no fabricar novedad sin evidencia.
 *
 * Doctrina (cmo-mindset): saber cuándo NO actuar es ventaja. Default a la
 * consistencia y al always-on; exige umbral alto de evidencia antes de cambiar
 * lo que ya rinde. Contrarresta la cadencia determinista que manufactura ruido
 * (recommendation-producer corre en reloj, no por causa).
 *
 * `contentionGate(brandContainerId)` decide act/no-act según la evidencia NUEVA
 * capturada desde el último review estratégico de la marca. Fail-OPEN: si el
 * guard falla, deja pasar (nunca bloquea el pipeline por un error del guard).
 *
 * Reusable: lo consume strategy-review.service.js (y luego proposeAction).
 */
import { supabase } from "../lib/supabase.js";

const EVIDENCE_DAYS = parseInt(process.env.CONTENTION_EVIDENCE_DAYS || "14", 10);
const MIN_EVIDENCE  = parseInt(process.env.CONTENTION_MIN_EVIDENCE || "3", 10);

export async function contentionGate(brandContainerId) {
  if (!brandContainerId) return { act: true, reason: "sin brand — fail-open" };
  try {
    // Piso de ventana + techo en el último review: solo cuenta evidencia NUEVA.
    const floorIso = new Date(Date.now() - EVIDENCE_DAYS * 86400_000).toISOString();
    const { data: lastRec } = await supabase
      .from("strategic_recommendations")
      .select("generated_at")
      .eq("brand_container_id", brandContainerId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const sinceIso =
      lastRec?.generated_at && lastRec.generated_at > floorIso ? lastRec.generated_at : floorIso;

    // Evidencia = actividad capturada (propia + competencia) desde entonces.
    const { count } = await supabase
      .from("brand_posts")
      .select("*", { count: "exact", head: true })
      .eq("brand_container_id", brandContainerId)
      .gte("captured_at", sinceIso);
    const evidence = count || 0;

    if (evidence < MIN_EVIDENCE) {
      return {
        act: false,
        evidence,
        since: sinceIso,
        reason: `contención: ${evidence} señales nuevas desde el último review (umbral ${MIN_EVIDENCE} en ${EVIDENCE_DAYS}d) — default a consistencia, no se fabrica novedad`,
      };
    }
    return { act: true, evidence, since: sinceIso };
  } catch (e) {
    return { act: true, guard_error: e.message }; // fail-open
  }
}
