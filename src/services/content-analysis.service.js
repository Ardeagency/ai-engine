/**
 * Content Analysis Service — análisis semántico de posts SIN LLM.
 *
 * Reemplaza el pipeline anterior basado en OpenAI por un motor lexicon-based
 * (tone, emotion, narrative_pillar, clarity, fatigue_risk). Cero llamadas a
 * LLM — todo cómputo determinista basado en diccionarios y heurísticas.
 *
 * Pobla:
 *   brand_content_analysis  → tono, emoción, pilar narrativo, claridad, fatigue
 *   brand_narrative_pillars → agregación de pilares por brand_container
 *   brand_posts.sentiment   → score sentiment + magnitud (campo enrichment)
 *
 * Se llama desde el scraper en cada post nuevo (propio o competidor) y desde
 * runContentAnalysisBackfill() para procesar posts existentes.
 */

import { createClient } from "@supabase/supabase-js";
import {
  TONE_LEXICON,
  EMOTION_LEXICON,
  PILLAR_LEXICON,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
  STOPWORDS,
  CTA_PATTERNS,
} from "../lib/content-lexicon.js";

// Pre-normalizar sets de sentiment SIN diacríticos (tokens vienen normalizados)
const _POSITIVE_NORM = new Set([...POSITIVE_WORDS].map((w) =>
  String(w).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
));
const _NEGATIVE_NORM = new Set([...NEGATIVE_WORDS].map((w) =>
  String(w).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function _stripDiacritics(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function _tokenize(text) {
  return _stripDiacritics(text)
    .split(/[^a-záéíóúüñ0-9]+/iu)
    .filter((w) => w.length > 1);
}

function _countMatches(textLower, keywords) {
  let count = 0;
  for (const kw of keywords) {
    const norm = _stripDiacritics(kw);
    // matches por substring + word boundary aproximada
    if (textLower.includes(norm)) count++;
  }
  return count;
}

function _emojiCount(text, emojis) {
  let count = 0;
  for (const e of emojis) {
    let idx = -1;
    while ((idx = text.indexOf(e, idx + 1)) !== -1) count++;
  }
  return count;
}

function _topByScore(scores) {
  let topKey = null, topScore = -Infinity;
  for (const [k, v] of Object.entries(scores)) {
    if (v > topScore) { topKey = k; topScore = v; }
  }
  return { key: topKey, score: topScore };
}

// ── Detección por categoría ─────────────────────────────────────────────────

function detectTone(content) {
  const lower = _stripDiacritics(content);
  const tokenCount = Math.max(1, _tokenize(content).length);
  const scores = {};
  let totalHits = 0;
  for (const [tone, keywords] of Object.entries(TONE_LEXICON)) {
    const hits = _countMatches(lower, keywords);
    scores[tone] = hits;
    totalHits += hits;
  }
  const top = _topByScore(scores);
  if (top.score === 0) return { tone: "informativo", coherence: 0.3 };
  // coherence = qué tan dominante es vs los demás (0..1)
  const dominance = top.score / Math.max(1, totalHits);
  const density   = Math.min(1, top.score / Math.max(5, tokenCount / 8));
  return { tone: top.key, coherence: Number((0.5 * dominance + 0.5 * density).toFixed(3)) };
}

function detectEmotion(content) {
  const lower = _stripDiacritics(content);
  const scores = {};
  for (const [emo, lex] of Object.entries(EMOTION_LEXICON)) {
    const kwHits    = _countMatches(lower, lex.keywords);
    const emojiHits = _emojiCount(content, lex.emojis);
    scores[emo] = kwHits + emojiHits * 2;
  }
  const top = _topByScore(scores);
  if (top.score === 0) return null;
  return top.key;
}

function detectNarrativePillar(content) {
  const lower = _stripDiacritics(content);
  const scores = {};
  for (const [pillar, keywords] of Object.entries(PILLAR_LEXICON)) {
    scores[pillar] = _countMatches(lower, keywords);
  }
  const top = _topByScore(scores);
  if (top.score === 0) return "Producto"; // default conservador
  return top.key;
}

function detectCtaImplicit(content) {
  for (const p of CTA_PATTERNS) {
    if (p.regex.test(content)) return p.label;
  }
  return null;
}

function computeClarityScore(content) {
  const sentences = content.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const words     = _tokenize(content);
  if (!words.length || !sentences.length) return 0.5;

  const avgSentenceLen = words.length / sentences.length;
  const longWords      = words.filter((w) => w.length > 11).length;
  const longRatio      = longWords / words.length;

  let score = 1.0;
  if (avgSentenceLen > 25) score -= 0.3;
  else if (avgSentenceLen > 18) score -= 0.15;
  if (longRatio > 0.25) score -= 0.3;
  else if (longRatio > 0.15) score -= 0.15;
  if (words.length < 8) score -= 0.2; // muy corto = poca claridad de mensaje
  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
}

function computeSentiment(content) {
  const tokens = _tokenize(content);
  let pos = 0, neg = 0;
  for (const t of tokens) {
    if (_POSITIVE_NORM.has(t)) pos++;
    else if (_NEGATIVE_NORM.has(t)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return { score: 0, magnitude: 0, positive: 0, negative: 0 };
  const score = (pos - neg) / total;       // [-1, 1]
  const magnitude = total / Math.max(8, tokens.length); // densidad emocional
  return {
    score:     Number(score.toFixed(3)),
    magnitude: Number(magnitude.toFixed(3)),
    positive:  pos,
    negative:  neg,
  };
}

function extractHook(content) {
  const firstSentence = content.split(/[.!?\n]+/)[0]?.trim();
  return (firstSentence || content.slice(0, 120)).slice(0, 120);
}

// ── Fatigue risk: ¿el brand está usando el mismo pillar repetidamente? ────────

async function computeFatigueRisk(brandContainerId, pillar) {
  if (!pillar) return false;
  const { data: recent } = await supabase
    .from("brand_content_analysis")
    .select("narrative_pillar")
    .eq("brand_container_id", brandContainerId)
    .order("analyzed_at", { ascending: false })
    .limit(15);
  if (!recent || recent.length < 5) return false;
  const sameCount = recent.filter((r) => r.narrative_pillar === pillar).length;
  return sameCount / recent.length >= 0.7; // 70%+ del mismo pilar = fatiga
}

// ── Análisis completo de un post (sin LLM) ───────────────────────────────────

export function analyzePostRules(post) {
  const content = (post.content || "").trim();
  if (content.length < 10) return null;

  const tone   = detectTone(content);
  const emo    = detectEmotion(content);
  const pillar = detectNarrativePillar(content);
  const cta    = detectCtaImplicit(content);
  const clarity   = computeClarityScore(content);
  const sentiment = computeSentiment(content);
  const hook      = extractHook(content);

  return {
    tone_detected:        tone.tone,
    tone_coherence_score: tone.coherence,
    dominant_emotion:     emo,
    narrative_pillar:     pillar,
    why_it_worked: {
      hook,
      emotional_trigger: emo,
      cta_implicit:      cta,
    },
    clarity_score: clarity,
    sentiment,                         // se persiste en brand_posts.sentiment también
  };
}

// ── Persistencia: brand_content_analysis ─────────────────────────────────────

async function saveContentAnalysis(postId, brandContainerId, organizationId, analysis, fatigueRisk) {
  const { error } = await supabase.from("brand_content_analysis").upsert(
    {
      brand_post_id:        postId,
      brand_container_id:   brandContainerId,
      organization_id:      organizationId,
      tone_detected:        analysis.tone_detected,
      tone_coherence_score: analysis.tone_coherence_score,
      dominant_emotion:     analysis.dominant_emotion,
      narrative_pillar:     analysis.narrative_pillar,
      why_it_worked:        analysis.why_it_worked || {},
      clarity_score:        analysis.clarity_score,
      fatigue_risk:         !!fatigueRisk,
      analyzed_at:          new Date().toISOString(),
    },
    { onConflict: "brand_post_id" },
  );
  return !error;
}

// ── Persistencia: brand_posts.sentiment (para análisis de impacto social) ────

async function updatePostSentiment(postId, sentiment) {
  if (!sentiment) return;
  const { error } = await supabase
    .from("brand_posts")
    .update({ sentiment })
    .eq("id", postId);
  if (error) console.warn(`content-analysis: update sentiment ${postId} — ${error.message}`);
}

// ── brand_narrative_pillars (agregación) ────────────────────────────────────

async function updateNarrativePillar(brandContainerId, organizationId, pillarName, post) {
  try {
    const { data: existing } = await supabase
      .from("brand_narrative_pillars")
      .select("id, post_count, avg_engagement, avg_reach")
      .eq("brand_container_id", brandContainerId)
      .eq("pillar_name", pillarName)
      .maybeSingle();

    const engagement = (post.metrics?.likes || 0) + (post.metrics?.comments || 0) + (post.metrics?.shares || 0);
    const reach      = post.metrics?.plays || post.metrics?.reach || 0;

    if (existing) {
      const newCount  = existing.post_count + 1;
      const newAvgEng = ((existing.avg_engagement * existing.post_count) + engagement) / newCount;
      const newAvgRch = ((existing.avg_reach * existing.post_count) + reach) / newCount;

      await supabase.from("brand_narrative_pillars").update({
        post_count:     newCount,
        avg_engagement: parseFloat(newAvgEng.toFixed(2)),
        avg_reach:      parseFloat(newAvgRch.toFixed(2)),
        last_post_at:   post.captured_at || new Date().toISOString(),
        analyzed_at:    new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      await supabase.from("brand_narrative_pillars").insert({
        brand_container_id: brandContainerId,
        organization_id:    organizationId,
        pillar_name:        pillarName,
        pillar_type:        "active",
        post_count:         1,
        avg_engagement:     engagement,
        avg_reach:          reach,
        description:        `Pilar detectado por analyzer rule-based (red: ${post.network || "social"})`,
        last_post_at:       post.captured_at || new Date().toISOString(),
        analyzed_at:        new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn(`content-analysis: updateNarrativePillar error — ${e.message}`);
  }
}

// ── Pipeline público: analizar y persistir un post ───────────────────────────

export async function analyzeAndPersistPost(brandPostId) {
  if (process.env.POST_SCRAPE_ANALYSIS_ENABLED === "false") return false;
  try {
    const { data: post, error } = await supabase
      .from("brand_posts")
      .select("id, network, content, metrics, brand_container_id, captured_at, brand_containers!inner(organization_id)")
      .eq("id", brandPostId)
      .single();

    if (error || !post) return false;
    if (!post.content || post.content.trim().length < 10) return false;

    const organizationId = post.brand_containers?.organization_id;

    // Idempotencia
    const { data: existing } = await supabase
      .from("brand_content_analysis")
      .select("id")
      .eq("brand_post_id", brandPostId)
      .maybeSingle();
    if (existing) return true;

    const analysis = analyzePostRules(post);
    if (!analysis) return false;

    const fatigue = await computeFatigueRisk(post.brand_container_id, analysis.narrative_pillar);

    const saved = await saveContentAnalysis(post.id, post.brand_container_id, organizationId, analysis, fatigue);
    if (!saved) return false;

    await updatePostSentiment(post.id, analysis.sentiment);
    await updateNarrativePillar(post.brand_container_id, organizationId, analysis.narrative_pillar, post);

    return true;
  } catch (e) {
    console.warn(`content-analysis: analyzeAndPersistPost(${brandPostId}) — ${e.message}`);
    return false;
  }
}

// ── Backfill: procesar posts existentes ─────────────────────────────────────

export async function runContentAnalysisBackfill(brandContainerId = null, batchSize = 200) {
  if (process.env.POST_SCRAPE_ANALYSIS_ENABLED === "false") return { analyzed: 0, processed: 0, disabled: true };
  console.log("content-analysis: iniciando backfill (rule-based, sin LLM)...");

  let query = supabase
    .from("brand_posts")
    .select("id, network, content, brand_container_id, captured_at")
    .not("content", "is", null)
    .order("captured_at", { ascending: false })
    .limit(batchSize);
  if (brandContainerId) query = query.eq("brand_container_id", brandContainerId);

  const { data: posts } = await query;
  if (!posts?.length) {
    console.log("content-analysis: no hay posts en brand_posts para procesar");
    return { processed: 0, analyzed: 0 };
  }

  const postIds = posts.map((p) => p.id);
  const { data: analyzed } = await supabase
    .from("brand_content_analysis")
    .select("brand_post_id")
    .in("brand_post_id", postIds);
  const analyzedSet = new Set((analyzed || []).map((a) => a.brand_post_id));
  const pending     = posts.filter((p) => !analyzedSet.has(p.id));

  console.log(`content-analysis: ${posts.length} posts encontrados, ${pending.length} pendientes`);

  let analyzedCount = 0;
  for (const p of pending) {
    const ok = await analyzeAndPersistPost(p.id);
    if (ok) analyzedCount++;
  }
  console.log(`content-analysis: backfill completo — ${analyzedCount}/${pending.length} analizados`);
  return { processed: pending.length, analyzed: analyzedCount };
}

// ── Rebuild de pilares narrativos (recompute desde brand_content_analysis) ───

export async function rebuildNarrativePillars(brandContainerId) {
  await supabase.from("brand_narrative_pillars").delete().eq("brand_container_id", brandContainerId);
  const { data: analyses } = await supabase
    .from("brand_content_analysis")
    .select("brand_post_id, narrative_pillar, brand_posts(metrics, captured_at, network, brand_container_id), brand_container_id, organization_id")
    .eq("brand_container_id", brandContainerId);
  if (!analyses?.length) return;
  for (const a of analyses) {
    if (!a.narrative_pillar || !a.brand_posts) continue;
    await updateNarrativePillar(brandContainerId, a.organization_id, a.narrative_pillar, a.brand_posts);
  }
}
