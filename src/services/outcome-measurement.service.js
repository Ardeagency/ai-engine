/**
 * outcome-measurement.service.js — Loop de retroalimentación post-ejecución.
 *
 * Cierra la deuda docs/task/loop-retroalimentacion.md: hasta ahora el ciclo era
 * abierto (Vera propone → usuario aprueba → executor ejecuta → fin). Este job
 * mide si la acción funcionó COMO DECISIÓN (no solo como ejecución técnica) y
 * persiste el resultado en vera_action_outcomes, que Vera lee vía las tools
 * getActionOutcomes / getActionOutcomeDetail / getOutcomeSummary.
 *
 * Reglas de diseño:
 *   - Reglas + math, NUNCA LLM (feedback_no_llm_in_background). El reasoning
 *     es template con interpolación.
 *   - Acciones internas no medibles (link_*, update_monitoring_trigger, etc.)
 *     se EXCLUYEN del job — no se insertan filas "inconclusive" de relleno.
 *   - Ventanas por tipo: uso (create_brief) = 7d + 30d; contenido (publish_*)
 *     = 24h + 7d. Una fila por (acción, ventana) — UNIQUE en DB.
 *   - Sin backfill: solo mide acciones ejecutadas DESPUÉS del release
 *     (controlable con OUTCOME_MEASUREMENT_SINCE, default 2026-06-12).
 *
 * El loop completo: Vera propone → ejecuta → este job mide → Vera consulta
 * outcomes en el próximo ciclo → calibra confianza y replica/evita patrones.
 */
import { supabase } from "../lib/supabase.js";

const POLL_INTERVAL_MS = parseInt(process.env.OUTCOME_MEASUREMENT_INTERVAL_MS || "3600000", 10); // 1h
const RELEASE_DATE = process.env.OUTCOME_MEASUREMENT_SINCE || "2026-06-12T00:00:00Z"; // sin backfill
const BATCH_LIMIT = 50;

const WINDOW_MS = {
  "24h": 24 * 3600 * 1000,
  "7d":  7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
};

// ── Mapa de medición por action_type ─────────────────────────────────────────
// usage    → la acción creó un recurso; outcome = ¿el recurso se adoptó/usó?
// content  → la acción publicó contenido; outcome = engagement vs baseline.
// (Todo lo demás queda excluido: configuración interna sin métrica externa.)
const MEASURABLE = {
  create_brief:            { kind: "usage",   windows: ["7d", "30d"] },
  publish_instagram_post:  { kind: "content", windows: ["24h", "7d"] },
  publish_facebook_post:   { kind: "content", windows: ["24h", "7d"] },
  schedule_instagram_post: { kind: "content", windows: ["24h", "7d"] },
  schedule_facebook_post:  { kind: "content", windows: ["24h", "7d"] },
};

// ── Mapper: USO (create_brief) ───────────────────────────────────────────────
// Un brief "funcionó" si el pipeline lo adoptó: una campaña lo referencia
// (campaigns.brief_id) o su status avanzó más allá de draft. Si tras 30 días
// sigue draft y sin campaña, la propuesta no aterrizó → negative.
async function _measureBriefUsage(action, windowKey) {
  const briefId = action.execution_result?.row_id || action.target_id;
  if (!briefId) {
    return { verdict: "inconclusive", score: null, baseline: null, outcome: null, delta: null,
             reasoning: "Sin referencia al brief creado (execution_result.row_id vacío)." };
  }

  const { data: brief } = await supabase
    .from("campaign_briefs")
    .select("id, status, updated_at, nombre")
    .eq("id", briefId)
    .maybeSingle();

  if (!brief) {
    return { verdict: "negative", score: -0.4, baseline: null,
             outcome: { brief_exists: false }, delta: null,
             reasoning: "El brief fue eliminado sin llegar a usarse." };
  }

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, nombre_campana, status, cached_impressions, cached_ctr, cached_roas")
    .eq("brief_id", briefId);

  const outcome = {
    brief_status: brief.status,
    campaigns_linked: campaigns?.length || 0,
    campaign_names: (campaigns || []).map((c) => c.nombre_campana).slice(0, 5),
  };

  if (campaigns?.length) {
    return { verdict: "positive", score: 0.6, baseline: { brief_status: "draft", campaigns_linked: 0 },
             outcome, delta: { campaigns_linked: campaigns.length },
             reasoning: `El brief "${brief.nombre}" fue adoptado por ${campaigns.length} campaña(s): ${outcome.campaign_names.join(", ")}.` };
  }
  if (brief.status && brief.status !== "draft") {
    return { verdict: "positive", score: 0.4, baseline: { brief_status: "draft" },
             outcome, delta: { status_change: `draft → ${brief.status}` },
             reasoning: `El brief "${brief.nombre}" avanzó de draft a ${brief.status} (en uso, sin campaña vinculada aún).` };
  }
  if (windowKey === "30d") {
    return { verdict: "negative", score: -0.3, baseline: { brief_status: "draft" },
             outcome, delta: null,
             reasoning: `El brief "${brief.nombre}" lleva 30 días en draft sin adopción — la propuesta no aterrizó en producción.` };
  }
  return { verdict: "neutral", score: 0, baseline: { brief_status: "draft" },
           outcome, delta: null,
           reasoning: `El brief "${brief.nombre}" sigue en draft a los 7 días — sin señal de adopción todavía.` };
}

// ── Mapper: CONTENIDO (publish_* / schedule_*) ───────────────────────────────
// Baseline = mediana de engagement_total de los últimos 10 posts propios de la
// misma red capturados ANTES de la ejecución. Outcome = engagement del post
// publicado. Los datos ya viven en brand_posts (sensores) — cero llamadas Meta.
function _median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function _measurePublishedContent(action) {
  // Resolución del post: target apuntando a brand_posts, o execution_result.
  let postId = null;
  if (action.target_table === "brand_posts" && action.target_id) postId = action.target_id;
  else if (action.execution_result?.table === "brand_posts" && action.execution_result?.row_id) {
    postId = action.execution_result.row_id;
  }
  if (!postId) {
    return { verdict: "inconclusive", score: null, baseline: null, outcome: null, delta: null,
             reasoning: "No hay vínculo acción→brand_post (la publicación fue externa o el executor no registró el post)." };
  }

  const { data: post } = await supabase
    .from("brand_posts")
    .select("id, network, engagement_total, metrics, captured_at, content")
    .eq("id", postId)
    .maybeSingle();

  if (!post || post.engagement_total == null) {
    return { verdict: "inconclusive", score: null, baseline: null, outcome: null, delta: null,
             reasoning: "El post vinculado no existe o aún no tiene métricas capturadas." };
  }

  const { data: priorPosts } = await supabase
    .from("brand_posts")
    .select("engagement_total")
    .eq("brand_container_id", action.brand_container_id)
    .eq("post_source", "own")
    .eq("network", post.network)
    .lt("captured_at", action.executed_at)
    .not("engagement_total", "is", null)
    .order("captured_at", { ascending: false })
    .limit(10);

  const baselineMedian = _median((priorPosts || []).map((p) => p.engagement_total));
  if (baselineMedian == null || baselineMedian === 0) {
    return { verdict: "inconclusive", score: null,
             baseline: { median_engagement_last10: baselineMedian },
             outcome: { engagement_total: post.engagement_total }, delta: null,
             reasoning: "Sin baseline confiable (menos de 1 post previo con engagement en esa red)." };
  }

  const deltaPct = ((post.engagement_total - baselineMedian) / baselineMedian) * 100;
  // Score acotado: ±100% de delta mapea a ±0.8; cap en ±1.0
  const score = Math.max(-1, Math.min(1, (deltaPct / 100) * 0.8));
  const verdict = deltaPct >= 20 ? "positive" : deltaPct <= -20 ? "negative" : "neutral";

  return {
    verdict, score: Math.round(score * 1000) / 1000,
    baseline: { median_engagement_last10: baselineMedian, sample: priorPosts.length },
    outcome:  { engagement_total: post.engagement_total, network: post.network },
    delta:    { engagement_delta_pct: Math.round(deltaPct * 10) / 10 },
    reasoning: `Engagement ${post.engagement_total} vs mediana ${baselineMedian} de los últimos ${priorPosts.length} posts de ${post.network}: ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%.`,
  };
}

// ── Core del job ─────────────────────────────────────────────────────────────

async function _measureAction(action, windowKey) {
  const spec = MEASURABLE[action.action_type];
  const m = spec.kind === "usage"
    ? await _measureBriefUsage(action, windowKey)
    : await _measurePublishedContent(action);

  const row = {
    pending_action_id:  action.id,
    organization_id:    action.organization_id,
    brand_container_id: action.brand_container_id,
    action_type:        action.action_type,
    measurement_window: windowKey,
    baseline_metrics:   m.baseline,
    outcome_metrics:    m.outcome,
    delta:              m.delta,
    outcome_verdict:    m.verdict,
    outcome_score:      m.score,
    reasoning:          m.reasoning,
  };

  const { error } = await supabase.from("vera_action_outcomes").insert(row);
  if (error) {
    // UNIQUE violation = otra corrida ya la midió; cualquier otra cosa se loguea.
    if (!String(error.message).includes("duplicate")) {
      console.warn(`[outcome-measurement] insert falló action=${action.id} window=${windowKey}: ${error.message}`);
    }
    return null;
  }

  if (m.score != null && m.score < -0.3) {
    console.warn(`[outcome-measurement] outcome NEGATIVO ${action.action_type} (${action.id}) ${windowKey}: ${m.reasoning}`);
  }
  return row;
}

export async function runOutcomeMeasurementCycle() {
  const measurableTypes = Object.keys(MEASURABLE);
  const now = Date.now();

  // Acciones ejecutadas medibles dentro del horizonte (release → ahora).
  const { data: actions, error } = await supabase
    .from("vera_pending_actions")
    .select("id, organization_id, brand_container_id, action_type, status, executed_at, execution_result, target_table, target_id, vera_confidence")
    .eq("status", "executed")
    .in("action_type", measurableTypes)
    .gte("executed_at", RELEASE_DATE)
    .order("executed_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.warn(`[outcome-measurement] query falló: ${error.message}`);
    return { measured: 0, error: error.message };
  }
  if (!actions?.length) return { measured: 0 };

  // Ventanas ya medidas (para no re-medir)
  const { data: existing } = await supabase
    .from("vera_action_outcomes")
    .select("pending_action_id, measurement_window")
    .in("pending_action_id", actions.map((a) => a.id));
  const done = new Set((existing || []).map((e) => `${e.pending_action_id}:${e.measurement_window}`));

  let measured = 0;
  for (const action of actions) {
    const executedMs = new Date(action.executed_at).getTime();
    for (const windowKey of MEASURABLE[action.action_type].windows) {
      if (done.has(`${action.id}:${windowKey}`)) continue;
      if (now - executedMs < WINDOW_MS[windowKey]) continue; // ventana aún no cierra
      try {
        const r = await _measureAction(action, windowKey);
        if (r) measured++;
      } catch (e) {
        console.warn(`[outcome-measurement] medición falló action=${action.id} window=${windowKey}: ${e.message}`);
      }
    }
  }

  if (measured > 0) console.log(`[outcome-measurement] ciclo: ${measured} outcomes medidos`);
  return { measured };
}

let _timer = null;

export function startOutcomeMeasurement() {
  if (_timer) return;
  console.log(`[outcome-measurement] iniciado — intervalo ${POLL_INTERVAL_MS / 60000}min, midiendo desde ${RELEASE_DATE}`);
  // Primera pasada 2min después del boot para no competir con el arranque.
  setTimeout(() => {
    runOutcomeMeasurementCycle().catch((e) => console.warn(`[outcome-measurement] ${e.message}`));
  }, 120_000);
  _timer = setInterval(() => {
    runOutcomeMeasurementCycle().catch((e) => console.warn(`[outcome-measurement] ${e.message}`));
  }, POLL_INTERVAL_MS);
}

export function stopOutcomeMeasurement() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
