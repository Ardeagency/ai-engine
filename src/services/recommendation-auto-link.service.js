/**
 * recommendation-auto-link.service.js
 *
 * Cierra el loop de aprendizaje cuando Vera propone → humano aprueba → humano
 * publica el post FUERA del sistema (porque action-executor aún no implementa
 * publish_*_post). Sin esto la RPC measure_recommendation_outcomes nunca tiene
 * material que medir y el sistema no aprende de sus propias predicciones.
 *
 * Loop:
 *   1. Toma strategic_recommendations con status='approved' o 'iterated' sin
 *      published_brand_post_id, donde reviewed_at fue hace ≤ 30 días.
 *   2. Para cada una, busca brand_posts propios (is_competitor=false) de la
 *      misma brand_container_id capturados después de reviewed_at.
 *   3. Calcula similitud entre recommendation.copy_seed y brand_post.content
 *      usando Jaccard de tokens normalizados + bonus por anchor_product_name.
 *   4. Si similitud >= 0.35 y es el mejor candidato → linkea: status='published',
 *      published_at = brand_post.captured_at, published_brand_post_id = bp.id.
 *
 * Diseño:
 *   - Sin LLM, sin embeddings (memoria dice OpenAI quotas agotadas + regla de
 *     no LLM en background). Solo léxico: Jaccard + heurísticas.
 *   - Idempotente: una recommendation con published_brand_post_id no se toca.
 *   - Defensa: si una recommendation matchea múltiples posts, gana el de mayor
 *     similitud; ties resueltos por proximidad temporal a reviewed_at.
 */

import { supabase } from "../lib/supabase.js";

const LINK_INTERVAL_MS = parseInt(process.env.RECOMMENDATION_AUTO_LINK_INTERVAL_MS || "1800000", 10); // 30 min
const SIMILARITY_THRESHOLD = parseFloat(process.env.RECOMMENDATION_AUTO_LINK_THRESHOLD || "0.35");
const MAX_DAYS_BACK = 30;

// Stopwords ES+EN que aportan nada a la similitud
const STOPWORDS = new Set([
  "the","and","or","of","to","a","in","on","at","is","it","this","that",
  "for","with","by","be","are","was","were","as","an","but","not","they",
  "we","you","i","my","your","our","their","his","her","its","de","la","el",
  "los","las","y","o","en","un","una","unos","unas","es","del","al","con",
  "para","por","se","lo","que","como","esta","este","esto","esa","ese","eso",
  "yo","tu","tú","él","ella","nosotros","ustedes","ellos","ellas","mi","mis",
  "su","sus","te","me","le","les",
]);

function _tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // sin acentos
    .replace(/https?:\/\/\S+/g, "")  // URLs
    .replace(/[@#]\w+/g, "")          // @mentions y #hashtags
    .replace(/[^a-z0-9\s]/g, " ")     // puntuación
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function _jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

function _similarity(rec, post) {
  const recTokens = new Set(_tokenize(`${rec.copy_seed || ""} ${rec.title || ""} ${rec.description || ""}`));
  const postTokens = new Set(_tokenize(post.content));
  const jac = _jaccard(recTokens, postTokens);

  // Bonus si el anchor_product_name aparece literal en el post
  let bonus = 0;
  if (rec.anchor_product_name) {
    const anchor = rec.anchor_product_name.toLowerCase();
    if (post.content && post.content.toLowerCase().includes(anchor)) {
      bonus += 0.15;
    }
  }
  // Bonus si el campaign_link_name aparece en el post
  if (rec.campaign_link_name) {
    const camp = rec.campaign_link_name.toLowerCase();
    if (post.content && post.content.toLowerCase().includes(camp)) {
      bonus += 0.10;
    }
  }
  return Math.min(1.0, jac + bonus);
}

async function _fetchPendingRecommendations() {
  const since = new Date(Date.now() - MAX_DAYS_BACK * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("strategic_recommendations")
    .select("id, brand_container_id, organization_id, title, description, copy_seed, anchor_product_name, campaign_link_name, recommended_network, status, reviewed_at, generated_at, predicted_engagement, predicted_reach")
    .in("status", ["approved", "iterated"])
    .is("published_brand_post_id", null)
    .gte("reviewed_at", since)
    .limit(100);
  if (error) throw new Error(`fetchPendingRecommendations: ${error.message}`);
  return data || [];
}

// Backfill window: si el reviewed_at fue hace X días, buscamos posts propios
// publicados en (reviewed_at - BACKFILL_DAYS_BEFORE) ... (reviewed_at + Inf).
// Razón: en la práctica los usuarios suelen publicar PRIMERO y marcar approved
// DESPUÉS (orden inverso al ideal), o publican el mismo día. Sin backfill, el
// loop solo capturaría el caso "approved → publicar después" que es minoritario.
const BACKFILL_DAYS_BEFORE = parseInt(process.env.RECOMMENDATION_BACKFILL_DAYS_BEFORE || "14", 10);

async function _fetchCandidatePosts(brandContainerId, anchorISO) {
  // Ventana [anchor - BACKFILL_DAYS_BEFORE, ahora].
  const anchorDate = new Date(anchorISO);
  const fromDate = new Date(anchorDate.getTime() - BACKFILL_DAYS_BEFORE * 86_400_000);
  const fromISO = fromDate.toISOString();

  const { data, error } = await supabase
    .from("brand_posts")
    .select("id, network, content, captured_at, engagement_total, metrics")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", false)
    .gte("captured_at", fromISO)
    .not("content", "is", null)
    .order("captured_at", { ascending: true })
    .limit(200);
  if (error) {
    console.warn(`auto-link: fetchCandidatePosts(${brandContainerId}) — ${error.message}`);
    return [];
  }
  return data || [];
}

async function _linkRecommendation(rec, post, similarity) {
  const update = {
    status: "published",
    published_at: post.captured_at,
    published_brand_post_id: post.id,
    metadata: {
      auto_linked: true,
      linked_at: new Date().toISOString(),
      similarity_score: Number(similarity.toFixed(3)),
      link_method: "jaccard+anchor",
    },
  };
  const { error } = await supabase
    .from("strategic_recommendations")
    .update(update)
    .eq("id", rec.id);
  if (error) {
    console.warn(`auto-link: update ${rec.id} — ${error.message}`);
    return false;
  }
  console.log(`auto-link: rec="${(rec.title || rec.id).slice(0,50)}" → post=${post.id} (sim=${similarity.toFixed(3)}, network=${post.network})`);
  return true;
}

// Link DETERMINISTA (Loop V1, 2026-07-02): las recomendaciones producidas y
// publicadas por el puente (recommendation-producer) traen metadata.remote_post_id
// (el ID nativo de la plataforma, seteado al publicar). Cuando el scraper ingiere
// ese post propio a brand_posts, aquí lo matcheamos por post_id EXACTO — sin
// Jaccard, sin ambigüedad — y seteamos published_brand_post_id para que
// measure_recommendation_outcomes tenga material. El Jaccard queda como respaldo
// para publicaciones hechas fuera del sistema.
async function runDeterministicLinkCycle() {
  let linked = 0;
  const { data: recs } = await supabase
    .from("strategic_recommendations")
    .select("id, brand_container_id, metadata")
    .eq("status", "published")
    .is("published_brand_post_id", null)
    .limit(50);
  for (const rec of recs || []) {
    const remoteId = rec.metadata?.remote_post_id;
    if (!remoteId) continue;
    const { data: bp } = await supabase
      .from("brand_posts")
      .select("id, captured_at")
      .eq("brand_container_id", rec.brand_container_id)
      .eq("post_id", String(remoteId))
      .maybeSingle();
    if (!bp) continue; // el scraper aún no lo ingiere — reintenta el próximo ciclo
    const { error } = await supabase
      .from("strategic_recommendations")
      .update({
        published_brand_post_id: bp.id,
        metadata: { ...(rec.metadata || {}), link_method: "deterministic_remote_post_id" },
      })
      .eq("id", rec.id);
    if (!error) {
      linked++;
      console.log(`auto-link[det]: rec=${rec.id} → brand_post=${bp.id} (remote_post_id=${remoteId})`);
    }
  }
  return linked;
}

async function runAutoLinkCycle() {
  let linked = 0, skipped = 0, scanned = 0;
  try {
    linked += await runDeterministicLinkCycle();
    const recs = await _fetchPendingRecommendations();
    if (!recs.length) {
      return { linked: 0, scanned: 0, message: "no pending recommendations" };
    }

    // Agrupar por brand_container para fetcher candidatos 1 vez por brand
    const byBrand = new Map();
    for (const r of recs) {
      if (!byBrand.has(r.brand_container_id)) byBrand.set(r.brand_container_id, []);
      byBrand.get(r.brand_container_id).push(r);
    }

    for (const [brandId, brandRecs] of byBrand) {
      // Posts candidatos: posteriores al reviewed_at más temprano del grupo
      const earliest = brandRecs
        .map(r => r.reviewed_at || r.generated_at)
        .filter(Boolean)
        .sort()[0];
      if (!earliest) continue;

      const candidates = await _fetchCandidatePosts(brandId, earliest);
      scanned += candidates.length;

      for (const rec of brandRecs) {
        const recAnchor = rec.reviewed_at || rec.generated_at;
        if (!recAnchor) continue;
        // Ventana [anchor - 14d, ...] — soporta el caso "publiqué primero y
        // luego marqué approved". Anchor = reviewed_at (preferido) o generated_at.
        const anchorDate = new Date(recAnchor);
        const minDate = new Date(anchorDate.getTime() - BACKFILL_DAYS_BEFORE * 86_400_000);
        const elegibles = candidates.filter(p => new Date(p.captured_at) >= minDate);
        if (!elegibles.length) continue;

        // Scoring: encontrar el mejor match
        let best = null;
        for (const p of elegibles) {
          const s = _similarity(rec, p);
          if (s >= SIMILARITY_THRESHOLD && (!best || s > best.score)) {
            best = { post: p, score: s };
          }
        }

        if (best) {
          const ok = await _linkRecommendation(rec, best.post, best.score);
          if (ok) linked++;
        } else {
          skipped++;
        }
      }
    }

    return { linked, skipped, scanned, recommendations: recs.length };
  } catch (e) {
    console.warn(`auto-link: cycle error — ${e.message}`);
    return { linked, skipped, scanned, error: e.message };
  }
}

// Mide outcomes de recomendaciones publicadas+linkeadas cuyo window ya cerro.
// Llena actual_engagement/prediction_error_pct/learning_signal via RPC (sin LLM).
async function runMeasureCycle() {
  try {
    const { data, error } = await supabase.rpc("measure_recommendation_outcomes", { p_window_days: 7 });
    if (error) { console.warn(`measure-outcomes: ${error.message}`); return { error: error.message }; }
    if (data && data.processed) console.log(`measure-outcomes: ${JSON.stringify(data)}`);
    return data || {};
  } catch (e) {
    console.warn(`measure-outcomes: ${e.message}`);
    return { error: e.message };
  }
}

let _timer = null;

export function startRecommendationAutoLink(intervalMs = LINK_INTERVAL_MS) {
  if (_timer) return;
  console.log(`recommendation-auto-link: scheduler iniciado (cada ${intervalMs/60000} min, primera corrida en 120s)`);
  setTimeout(async () => {
    const r = await runAutoLinkCycle();
    console.log(`auto-link: ciclo inicial — linked=${r.linked}, skipped=${r.skipped||0}, scanned=${r.scanned||0}`);
    await runMeasureCycle();
  }, 120_000);
  _timer = setInterval(async () => {
    const r = await runAutoLinkCycle();
    if (r.linked > 0 || r.error) {
      console.log(`auto-link: ciclo — linked=${r.linked}, skipped=${r.skipped||0}, scanned=${r.scanned||0}${r.error ? ` ERR=${r.error}` : ""}`);
    }
    await runMeasureCycle();
  }, intervalMs);
}

export function stopRecommendationAutoLink() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Export para uso manual / endpoint admin
export { runAutoLinkCycle };
