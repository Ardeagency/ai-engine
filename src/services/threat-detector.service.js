/**
 * Threat Detector Service — detecta threats estadísticos sin LLM.
 *
 * Complementa al signal-webhook.controller (que detecta keywords promo/urgencia
 * en signals individuales en tiempo real). Este servicio corre periódicamente
 * y detecta anomalías que requieren mirar AGREGACIONES y BASELINES:
 *
 *   1. competitor_virality       — post de competidor con engagement > 2.5x su
 *                                  baseline rolling de 14 días
 *   2. own_engagement_drop       — caída de engagement promedio propio (7d vs 30d previos)
 *   3. negative_sentiment_spike  — % de posts propios con sentiment < -0.1 supera threshold
 *
 * Outputs:
 *   • intelligence_signals  con signal_type='threat:{tipo}' y ai_analysis estructurado
 *   • brand_vulnerabilities con detected_signal_id, severity, metadata.threat_type
 *
 * Idempotencia: usa metadata.triggering_post_id (virality) o claves naturales
 * (drop/sentiment usa flagged_window_start) para no duplicar threats abiertos.
 *
 * NO usa LLM. Cero tokens.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function _engagement(metrics) {
  return (metrics?.likes || 0) + (metrics?.comments || 0) + (metrics?.shares || 0);
}

function _median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function _avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

async function _existingVulnerabilityFor(brandContainerId, threatType, key) {
  const { data } = await supabase
    .from("brand_vulnerabilities")
    .select("id")
    .eq("brand_container_id", brandContainerId)
    .eq("status", "open")
    .contains("metadata", { threat_type: threatType, _key: key })
    .maybeSingle();
  return data?.id || null;
}

async function _persistThreat({ brandContainerId, organizationId, entityId, threatType, severity, title, description, metadata }) {
  // 1. intelligence_signals
  const { data: sig } = await supabase
    .from("intelligence_signals")
    .insert({
      entity_id:      entityId,
      signal_type:    `threat:${threatType}`,
      content_text:   title,
      content_numeric: metadata?.severity_score ?? 0,
      ai_analysis: {
        threat_type:  threatType,
        severity,
        detector:     "threat-detector",
        detected_at:  new Date().toISOString(),
        ...metadata,
      },
      captured_at:    new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  // 2. brand_vulnerabilities
  const { error: vErr } = await supabase
    .from("brand_vulnerabilities")
    .insert({
      brand_container_id:  brandContainerId,
      organization_id:     organizationId,
      entity_id:           entityId,
      title,
      description:         description?.slice(0, 500) || null,
      severity,
      status:              "open",
      detected_signal_id:  sig?.id || null,
      metadata:            { ...metadata, threat_type: threatType, detector: "threat-detector" },
    });
  if (vErr) console.warn(`[threat-detector] brand_vulnerabilities insert: ${vErr.message}`);

  return { signal_id: sig?.id, threat_type: threatType, severity };
}

// ── Rule 1: competitor_virality ──────────────────────────────────────────────

// Comportamiento por ROL en virality: un competidor DIRECTO dispara antes
// (umbral más bajo) y con más severidad; un referente/aliado es INFO, no amenaza
// (umbral alto, severidad rebajada); lo propio no aplica.
const VIRALITY_BY_ROLE = {
  competidor_directo:   { minRatio: 2.0, sevBoost:  1 },
  competidor_indirecto: { minRatio: 2.5, sevBoost:  0 },
  referencia_cultural:  { minRatio: 4.0, sevBoost: -1 },
  aliado:               { minRatio: 4.0, sevBoost: -1 },
  owned_media:          { minRatio: Infinity, sevBoost: 0 },
};
const VIRALITY_DEFAULT = { minRatio: 2.5, sevBoost: 0 };
const SEV_ORDER = ["low", "medium", "high"];
function _bumpSeverity(sev, boost) {
  const i = Math.max(0, Math.min(SEV_ORDER.length - 1, SEV_ORDER.indexOf(sev) + boost));
  return SEV_ORDER[i];
}

async function detectCompetitorVirality(brandContainerId, organizationId) {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const { data: posts } = await supabase
    .from("brand_posts")
    .select("id, entity_id, network, content, captured_at, metrics, intelligence_entities!inner(name, brand_container_id, metadata, relevance)")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", true)
    .gte("captured_at", cutoff);

  if (!posts?.length) return { detected: 0, skipped_existing: 0 };

  // Agrupar por entity para baseline
  const byEntity = new Map();
  for (const p of posts) {
    if (!byEntity.has(p.entity_id)) byEntity.set(p.entity_id, []);
    byEntity.get(p.entity_id).push(p);
  }

  let detected = 0, skipped = 0;
  for (const [entityId, entityPosts] of byEntity) {
    if (entityPosts.length < 4) continue; // necesitamos baseline mínima
    const engagements = entityPosts.map((p) => _engagement(p.metrics));
    const median = _median(engagements);
    if (median <= 0) continue;
    // Rol + relevancia de esta entidad → gradúa umbral y severidad.
    const _ie = entityPosts[0].intelligence_entities || {};
    const role = _ie.metadata?.tipo || null;
    const relevance = _ie.relevance || null;
    const cfg = VIRALITY_BY_ROLE[role] || VIRALITY_DEFAULT;

    for (const post of entityPosts) {
      const eng   = _engagement(post.metrics);
      const ratio = eng / Math.max(1, median);
      if (ratio < cfg.minRatio) continue;

      const existing = await _existingVulnerabilityFor(brandContainerId, "competitor_virality", post.id);
      if (existing) { skipped++; continue; }

      let severity = "low";
      if (ratio >= 7) severity      = "high";
      else if (ratio >= 4) severity = "medium";
      severity = _bumpSeverity(severity, cfg.sevBoost);

      const entityName = post.intelligence_entities?.name || "competidor";
      await _persistThreat({
        brandContainerId,
        organizationId,
        entityId,
        threatType:  "competitor_virality",
        severity,
        title:       `${entityName}${role ? ` [${role}]` : ""} — engagement ${ratio.toFixed(1)}x sobre baseline`,
        description: post.content?.slice(0, 200) || null,
        metadata: {
          _key:                post.id,
          triggering_post_id:  post.id,
          network:             post.network,
          engagement:          eng,
          median_baseline:     median,
          ratio:               Number(ratio.toFixed(2)),
          severity_score:      Math.min(1, ratio / 10),
          window_days:         14,
          competitor_role:     role,
          relevance:           relevance,
        },
      });
      detected++;
    }
  }
  return { detected, skipped_existing: skipped };
}

// ── Rule 2: own_engagement_drop ──────────────────────────────────────────────

async function detectOwnEngagementDrop(brandContainerId, organizationId) {
  const now = Date.now();
  const last7Cutoff   = new Date(now - 7 * 86_400_000).toISOString();
  const prior30Start  = new Date(now - 37 * 86_400_000).toISOString();
  const prior30End    = new Date(now - 7 * 86_400_000).toISOString();

  const { data: recent } = await supabase
    .from("brand_posts")
    .select("metrics")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", false)
    .gte("captured_at", last7Cutoff);

  const { data: baseline } = await supabase
    .from("brand_posts")
    .select("metrics")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", false)
    .gte("captured_at", prior30Start)
    .lt("captured_at", prior30End);

  if ((recent?.length || 0) < 3 || (baseline?.length || 0) < 5) {
    return { detected: 0, skipped_existing: 0, reason: "data insuficiente" };
  }

  const avgRecent   = _avg((recent || []).map((p) => _engagement(p.metrics)));
  const avgBaseline = _avg((baseline || []).map((p) => _engagement(p.metrics)));
  if (avgBaseline <= 0) return { detected: 0, skipped_existing: 0 };

  const ratio = avgRecent / avgBaseline;
  if (ratio >= 0.5) return { detected: 0, skipped_existing: 0 }; // no es drop

  // Ventana key — semana ISO actual (idempotente por semana)
  const windowKey = last7Cutoff.slice(0, 10);
  const existing = await _existingVulnerabilityFor(brandContainerId, "own_engagement_drop", windowKey);
  if (existing) return { detected: 0, skipped_existing: 1 };

  const dropPct = Math.round((1 - ratio) * 100);
  let severity = "medium";
  if (ratio < 0.25) severity = "high";
  if (ratio < 0.10) severity = "critical";

  await _persistThreat({
    brandContainerId,
    organizationId,
    entityId:    null,
    threatType:  "own_engagement_drop",
    severity,
    title:       `Caída de engagement propio — ${dropPct}% bajo baseline`,
    description: `Promedio últimos 7 días: ${Math.round(avgRecent)} | baseline 30 días previos: ${Math.round(avgBaseline)}`,
    metadata: {
      _key:               windowKey,
      avg_recent:         Math.round(avgRecent),
      avg_baseline:       Math.round(avgBaseline),
      ratio:              Number(ratio.toFixed(3)),
      drop_pct:           dropPct,
      recent_post_count:  recent.length,
      baseline_post_count: baseline.length,
      severity_score:     Math.min(1, 1 - ratio),
    },
  });
  return { detected: 1, skipped_existing: 0 };
}

// ── Rule 3: negative_sentiment_spike ─────────────────────────────────────────

async function detectNegativeSentimentSpike(brandContainerId, organizationId) {
  const last7 = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: posts } = await supabase
    .from("brand_posts")
    .select("id, content, sentiment")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", false)
    .gte("captured_at", last7);

  if ((posts?.length || 0) < 5) {
    return { detected: 0, skipped_existing: 0, reason: "menos de 5 posts en 7d" };
  }

  let neg = 0;
  const samples = [];
  for (const p of posts) {
    const score = p.sentiment?.score;
    if (typeof score === "number" && score <= -0.1) {
      neg++;
      if (samples.length < 5) samples.push({ post_id: p.id, score, snippet: (p.content || "").slice(0, 80) });
    }
  }
  const negPct = Math.round((neg / posts.length) * 100);
  if (negPct < 30) return { detected: 0, skipped_existing: 0 };

  const windowKey = last7.slice(0, 10);
  const existing = await _existingVulnerabilityFor(brandContainerId, "negative_sentiment_spike", windowKey);
  if (existing) return { detected: 0, skipped_existing: 1 };

  let severity = "medium";
  if (negPct >= 50) severity = "high";
  if (negPct >= 70) severity = "critical";

  await _persistThreat({
    brandContainerId,
    organizationId,
    entityId:    null,
    threatType:  "negative_sentiment_spike",
    severity,
    title:       `Alza de sentimiento negativo — ${negPct}% en posts propios (7d)`,
    description: `${neg} de ${posts.length} posts con score <= -0.1 en últimos 7 días`,
    metadata: {
      _key:               windowKey,
      neg_count:          neg,
      total_posts:        posts.length,
      neg_pct:            negPct,
      sample_posts:       samples,
      severity_score:     negPct / 100,
    },
  });
  return { detected: 1, skipped_existing: 0 };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runThreatDetection(brandContainerId, organizationId) {
  if (!brandContainerId || !organizationId) {
    return { error: "missing ids", total_detected: 0 };
  }

  const r1 = await detectCompetitorVirality(brandContainerId, organizationId);
  const r2 = await detectOwnEngagementDrop(brandContainerId, organizationId);
  const r3 = await detectNegativeSentimentSpike(brandContainerId, organizationId);

  const totalDetected = (r1.detected || 0) + (r2.detected || 0) + (r3.detected || 0);
  return {
    total_detected: totalDetected,
    competitor_virality:        r1,
    own_engagement_drop:        r2,
    negative_sentiment_spike:   r3,
  };
}
