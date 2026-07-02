/**
 * campaign-performance.service.js
 *
 * Cierra el loop "campaign linked to persona → real demographics → strategic
 * recommendation". Sin LLM (regla del usuario): comparación determinística +
 * templates. La explicación rica en lenguaje natural se hace cuando el user
 * abre la pending_action en chat con Vera.
 *
 * Trigger: sensor `meta_campaign_audience_demographics` (daily, brand-wide).
 * Run sequence per brand:
 *   1. Listar campaigns con persona_id NOT NULL y platform LIKE 'meta_%'
 *   2. Por campaign: GET /act_X/insights?breakdowns=age,gender,country&date_preset=last_30d
 *   3. Persist en campaigns.real_demographics
 *   4. Comparar con persona conceptual (datos_demograficos parsed) →
 *      detectar gaps por edad/género/geo
 *   5. Si gap > umbral, INSERT vera_pending_actions con
 *      action_type='strategic_recommendation_for_campaign' + reasoning template
 */
import { supabase } from "../lib/supabase.js";
import { decryptToken } from "../lib/integration-token-vault.js";

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const APP_SECRET = () => process.env.META_APP_SECRET || "";
const REQUIRE_PROOF = String(process.env.META_REQUIRE_APPSECRET_PROOF || "").toLowerCase() === "true";

async function metaFetch(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${path}`);
  url.searchParams.set("access_token", token);
  if (REQUIRE_PROOF && APP_SECRET()) {
    const crypto = await import("node:crypto");
    const proof = crypto.createHmac("sha256", APP_SECRET()).update(token).digest("hex");
    url.searchParams.set("appsecret_proof", proof);
  }
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`Meta Graph ${res.status}: ${json?.error?.message || JSON.stringify(json?.error || json).slice(0, 200)}`);
  }
  return json;
}

// ── 1. Demographics breakdown per campaign ──────────────────────────────────

async function fetchCampaignDemographics(token, externalCampaignId) {
  const out = { age: {}, gender: {}, country: {}, period: "last_30d" };
  // Insights with multiple breakdowns require separate calls (Meta no permite combinar age+gender+country en una sola)
  for (const [key, breakdown] of [["age", "age"], ["gender", "gender"], ["country", "country"]]) {
    try {
      const json = await metaFetch(`/${externalCampaignId}/insights`, token, {
        fields:       "impressions,reach,clicks,spend,actions",
        date_preset:  "last_30d",
        breakdowns:   breakdown,
        level:        "campaign",
      });
      for (const row of (json.data || [])) {
        const dim = String(row[breakdown] || "").trim();
        if (!dim) continue;
        out[key][dim] = {
          impressions: Number(row.impressions) || 0,
          reach:       Number(row.reach) || 0,
          clicks:      Number(row.clicks) || 0,
          spend:       Number(row.spend) || 0,
          conversions: (row.actions || []).filter(a => /purchase|complete_registration|lead/i.test(a.action_type || "")).reduce((s, a) => s + (Number(a.value) || 0), 0),
        };
      }
    } catch (e) {
      // Si una breakdown falla (p.ej. campaign no entregó por country), seguir
      console.warn(`campaign-performance: ${externalCampaignId} ${breakdown}:`, e.message?.slice(0, 100));
    }
  }
  return out;
}

// ── 2. Top dimensions (deterministic ranking) ───────────────────────────────

function topByImpressions(distribution, limit = 3) {
  const entries = Object.entries(distribution || {})
    .filter(([, v]) => v && v.impressions > 0)
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .slice(0, limit);
  return entries.map(([dim, v]) => ({ dim, impressions: v.impressions, reach: v.reach, conversions: v.conversions, spend: v.spend }));
}

// ── 3. Persona target parsing (reused pattern from audience-alignment) ─────

const COUNTRY_NAME_TO_ISO = {
  "colombia": "CO", "mexico": "MX", "méxico": "MX", "argentina": "AR",
  "perú": "PE", "peru": "PE", "chile": "CL", "ecuador": "EC", "venezuela": "VE",
  "estados unidos": "US", "usa": "US", "united states": "US",
  "españa": "ES", "espana": "ES", "spain": "ES", "brasil": "BR", "brazil": "BR",
};

function parsePersonaTarget(persona) {
  const text = [
    ...(persona.datos_demograficos || []),
    ...(persona.datos_psicograficos || []),
    persona.description || "", persona.name || ""
  ].join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const ageMatch = text.match(/(\d{2})\s*(?:a|al?|hasta|-|–|—|\sto\s)\s*(\d{2})/);
  const expectedAgeMin = ageMatch ? parseInt(ageMatch[1], 10) : null;
  const expectedAgeMax = ageMatch ? parseInt(ageMatch[2], 10) : null;
  let expectedGender = null;
  if (/\bmujer(?:es)?|femenin/.test(text) && !/\bhombre(?:s)?|masculin/.test(text)) expectedGender = "female";
  if (/\bhombre(?:s)?|masculin/.test(text) && !/\bmujer(?:es)?|femenin/.test(text)) expectedGender = "male";

  // Países declarados en el texto: extraer ISO-2 codes
  const expectedCountries = [];
  for (const [name, iso] of Object.entries(COUNTRY_NAME_TO_ISO)) {
    if (text.includes(name) && !expectedCountries.includes(iso)) expectedCountries.push(iso);
  }
  return { expectedAgeMin, expectedAgeMax, expectedGender, expectedCountries };
}

// ── 4. Gap detection ────────────────────────────────────────────────────────

function ageBucketToRange(bucket) {
  // Meta usa "18-24", "25-34", etc.
  const m = String(bucket || "").match(/^(\d+)-(\d+)$/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  if (/^65\+/.test(bucket)) return { min: 65, max: 99 };
  return null;
}

// ── Match scoring (% alignment campaign real demographics ↔ persona conceptual) ──
// Devuelve { age, gender, geo, composite, missing }. composite = avg sólo de
// ejes evaluables. Cada eje 0-100.
function computeMatchScores({ demographics, personaTarget }) {
  const out = { age: null, gender: null, geo: null, composite: null, missing: { age: true, gender: true, geo: true } };

  // AGE: overlap del top-2 age buckets reales con el rango de la persona
  if (personaTarget.expectedAgeMin && personaTarget.expectedAgeMax) {
    const ageTop = topByImpressions(demographics.age, 2);
    if (ageTop.length > 0) {
      let totalImp = 0, matchedImp = 0;
      for (const [bucket, v] of Object.entries(demographics.age || {})) {
        const range = ageBucketToRange(bucket);
        if (!range) continue;
        totalImp += v.impressions;
        // Solapamiento: si hay intersección NO vacía entre [range.min, range.max] y [target.min, target.max]
        if (!(range.max < personaTarget.expectedAgeMin || range.min > personaTarget.expectedAgeMax)) {
          matchedImp += v.impressions;
        }
      }
      if (totalImp > 0) {
        out.age = Math.round((matchedImp / totalImp) * 100);
        out.missing.age = false;
      }
    }
  }

  // GENDER: % de impressions del género esperado
  if (personaTarget.expectedGender) {
    const distro = demographics.gender || {};
    const totalImp = Object.values(distro).reduce((s, v) => s + (v.impressions || 0), 0);
    const matchedImp = (distro[personaTarget.expectedGender]?.impressions) || 0;
    if (totalImp > 0) {
      out.gender = Math.round((matchedImp / totalImp) * 100);
      out.missing.gender = false;
    }
  }

  // GEO: persona puede tener países declarados en datos_demograficos; si no, usar la regla:
  //  - si la persona declara un país y matchea con top 1 real → 100
  //  - si no declara país pero hay concentración geográfica clara (top país >50%) → 80
  //  - default: usar concentración como proxy (qué tan focalizada está la audiencia)
  const geoDistro = demographics.country || {};
  const geoTotal = Object.values(geoDistro).reduce((s, v) => s + (v.impressions || 0), 0);
  if (geoTotal > 0) {
    if (personaTarget.expectedCountries && personaTarget.expectedCountries.length > 0) {
      const matched = personaTarget.expectedCountries
        .map(cc => (geoDistro[cc]?.impressions) || 0)
        .reduce((s, v) => s + v, 0);
      out.geo = Math.round((matched / geoTotal) * 100);
    } else {
      // sin target geográfico declarado → concentración del top país (proxy de coherencia)
      const top = topByImpressions(geoDistro, 1)[0];
      out.geo = top ? Math.round((top.impressions / geoTotal) * 100) : 0;
    }
    out.missing.geo = false;
  }

  // Composite: avg sólo de los ejes con score evaluable
  const evaluable = [out.age, out.gender, out.geo].filter(v => v != null);
  out.composite = evaluable.length > 0
    ? Math.round(evaluable.reduce((s, v) => s + v, 0) / evaluable.length)
    : null;

  return out;
}

function summarizeGaps({ demographics, personaTarget }) {
  const topAge     = topByImpressions(demographics.age, 2);
  const topGender  = topByImpressions(demographics.gender, 2);
  const topCountry = topByImpressions(demographics.country, 3);

  const findings = [];
  let needsAdjustment = false;

  if (topAge.length > 0) {
    const realRange = ageBucketToRange(topAge[0].dim);
    if (realRange && personaTarget.expectedAgeMin && personaTarget.expectedAgeMax) {
      const overlap = !(realRange.max < personaTarget.expectedAgeMin || realRange.min > personaTarget.expectedAgeMax);
      if (!overlap) {
        needsAdjustment = true;
        findings.push(`Edad real top "${topAge[0].dim}" fuera del target conceptual ${personaTarget.expectedAgeMin}-${personaTarget.expectedAgeMax}`);
      } else {
        findings.push(`Edad top alineada: ${topAge[0].dim}`);
      }
    } else if (realRange) {
      findings.push(`Edad top: ${topAge[0].dim}`);
    }
  }

  if (topGender.length > 0 && personaTarget.expectedGender) {
    const realGender = topGender[0].dim;
    if (realGender !== personaTarget.expectedGender) {
      needsAdjustment = true;
      findings.push(`Género real top "${realGender}" distinto del target conceptual "${personaTarget.expectedGender}"`);
    }
  }

  if (topCountry.length > 0) {
    const list = topCountry.map(c => `${c.dim} (${c.impressions.toLocaleString("es")} imp)`).join(", ");
    findings.push(`Geografías top: ${list}`);
  }

  return { findings, needsAdjustment, topAge, topGender, topCountry };
}

// ── 5. Pending action generator ─────────────────────────────────────────────

function buildRecommendationSummary({ campaign, persona, summary, demographics }) {
  const cName  = campaign.nombre_campana || campaign.external_campaign_name || "Campaña";
  const pName  = persona.name || "tu persona objetivo";
  const ageStr = summary.topAge.map(a => a.dim).join(" / ");
  const genStr = summary.topGender.map(g => g.dim === "male" ? "hombres" : (g.dim === "female" ? "mujeres" : g.dim)).join(", ");
  const ctyStr = summary.topCountry.map(c => c.dim).join(", ");

  const parts = [];
  parts.push(`Tu campaña "${cName}" está atrayendo público real en ${ageStr || "rangos diversos"}`);
  if (genStr) parts.push(`mayoritariamente ${genStr}`);
  if (ctyStr) parts.push(`con foco en ${ctyStr}`);
  parts.push(`(persona objetivo: ${pName})`);

  if (summary.needsAdjustment) {
    parts.push("— Vera detecta divergencia con la persona conceptual: ajusta tono, copy e imágenes en la próxima campaña y posts de la semana al perfil real.");
  } else {
    parts.push("— el público real está alineado con la persona; mantén la dirección.");
  }
  return parts.join(" ");
}

// ── 6. Public API ───────────────────────────────────────────────────────────

export async function runCampaignPerformanceForBrand(brandContainerId, organizationId) {
  const stats = { campaigns_analyzed: 0, recommendations_created: 0, errors: 0, skipped_no_token: 0 };
  if (!brandContainerId || !organizationId) return stats;

  // 1. Get ALL Meta campaigns of the brand (linked to a persona or not).
  //    La demografía real es propiedad de la CAMPAÑA (la da Meta), no depende de
  //    que haya una persona ligada. Antes esto filtraba `.not("persona_id","is",null)`,
  //    lo que creaba un DEADLOCK: como ninguna campaña tenía persona, ninguna recibía
  //    demografía nunca → personas sin dato real → alignment sin score → motor de
  //    audiencia muerto. El bloque de análisis vs persona ya se salta solo con
  //    `if (!persona) continue` más abajo, así que aquí solo sincronizamos demografía
  //    para todas y dejamos que el análisis de gap corra cuando SÍ haya persona.
  const { data: campaigns, error: cErr } = await supabase
    .from("campaigns")
    .select("id, nombre_campana, external_campaign_id, external_account_id, integration_id, platform, persona_id, real_demographics, demographics_synced_at")
    .eq("brand_container_id", brandContainerId)
    .in("platform", ["meta_facebook", "meta_instagram"])
    .not("integration_id", "is", null);
  if (cErr) throw cErr;
  if (!campaigns || campaigns.length === 0) return { ...stats, status: "no_meta_campaigns" };

  // 2. Cargar tokens de las integraciones referenciadas (encriptados → decrypt)
  const integIds = [...new Set(campaigns.map(c => c.integration_id))];
  const { data: integs } = await supabase
    .from("brand_integrations")
    .select("id, access_token, is_active")
    .in("id", integIds)
    .eq("is_active", true);
  const tokenById = {};
  for (const it of (integs || [])) {
    try { tokenById[it.id] = decryptToken(it.access_token); } catch (_) { /* skip */ }
  }

  // 3. Personas del brand_container
  const { data: personas } = await supabase
    .from("audience_personas")
    .select("id, name, description, datos_demograficos, datos_psicograficos")
    .eq("brand_container_id", brandContainerId);
  const personaById = {};
  for (const p of (personas || [])) personaById[p.id] = p;

  // 4. Por cada campaign Meta → fetch demographics → persist → (si hay persona) analyze → maybe pending_action
  const DEMO_TTL_MS = 24 * 60 * 60 * 1000; // re-sincroniza demografía como mucho 1×/día
  for (const c of campaigns) {
    const token = tokenById[c.integration_id];
    if (!token) { stats.skipped_no_token++; continue; }
    // Guard de frescura: como ahora procesamos TODAS las campañas Meta, evitamos
    // re-pegarle a la Meta API en cada ciclo del scraper (45 min) para campañas ya
    // sincronizadas hace poco. Las nuevas / stale sí se traen.
    if (c.demographics_synced_at && (Date.now() - new Date(c.demographics_synced_at).getTime()) < DEMO_TTL_MS) {
      stats.skipped_fresh = (stats.skipped_fresh || 0) + 1;
      continue;
    }
    try {
      const demographics = await fetchCampaignDemographics(token, c.external_campaign_id);

      stats.campaigns_analyzed++;

      const persona = personaById[c.persona_id];
      const target = persona ? parsePersonaTarget(persona) : { expectedAgeMin: null, expectedAgeMax: null, expectedGender: null, expectedCountries: [] };
      const matchScores = persona
        ? { ...computeMatchScores({ demographics, personaTarget: target }), computed_at: new Date().toISOString(), persona_id: c.persona_id }
        : {};

      // Persistir demographics + match_scores en una sola UPDATE
      await supabase
        .from("campaigns")
        .update({
          real_demographics: demographics,
          demographics_synced_at: new Date().toISOString(),
          match_scores: matchScores,
        })
        .eq("id", c.id);

      if (!persona) continue;

      const summary = summarizeGaps({ demographics, personaTarget: target });

      // Skip si no hay impressions en ningún breakdown (campaña inactiva)
      const hasData = summary.topAge.length > 0 || summary.topGender.length > 0 || summary.topCountry.length > 0;
      if (!hasData) continue;

      // Idempotencia: no duplicar recomendación si ya hay una pending para esta campaign
      const { count: existingCount } = await supabase
        .from("vera_pending_actions")
        .select("*", { count: "exact", head: true })
        .eq("brand_container_id", brandContainerId)
        .eq("action_type", "strategic_recommendation_for_campaign")
        .eq("target_id", c.id)
        .eq("status", "pending");
      if (existingCount && existingCount > 0) continue;

      const recSummary = buildRecommendationSummary({ campaign: c, persona, summary, demographics });
      const confidence = summary.needsAdjustment ? 0.75 : 0.55;
      const priority   = summary.needsAdjustment ? 7 : 5;

      const { error: insErr } = await supabase.from("vera_pending_actions").insert({
        organization_id:    organizationId,
        brand_container_id: brandContainerId,
        action_type:        "strategic_recommendation_for_campaign",
        target_table:       "campaigns",
        target_id:          c.id,
        proposed_payload: {
          summary:        recSummary,
          campaign_name:  c.nombre_campana,
          persona_name:   persona.name,
          findings:       summary.findings,
          top_age:        summary.topAge,
          top_gender:     summary.topGender,
          top_country:    summary.topCountry,
          needs_adjustment: summary.needsAdjustment,
        },
        current_state: {
          persona_id: c.persona_id,
          demographics_synced_at: new Date().toISOString(),
        },
        vera_reasoning:  summary.findings.join(" · "),
        vera_confidence: confidence,
        impact_estimate: { engagement_lift_pct: summary.needsAdjustment ? 15 : null, revenue_impact_usd: null },
        status:          "pending",
        priority,
        expires_at:      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (insErr) { stats.errors++; console.error(`campaign-performance: pending_action insert ${c.id}:`, insErr.message); continue; }
      stats.recommendations_created++;
    } catch (e) {
      stats.errors++;
      console.error(`campaign-performance: campaign ${c.id} failed:`, e.message?.slice(0, 200));
    }
  }

  return stats;
}
