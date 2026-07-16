/**
 * Audience Alignment Service — comparación persona conceptual ↔ público real.
 *
 * Sin LLM. Todo cómputo determinístico:
 *   1. Parsea datos_demograficos (texto libre) con regex/keywords → target estructurado
 *   2. Compara con real_age/gender/location_distribution (poblado por sensores demográficos)
 *   3. Calcula alignment_score ∈ [0,1] como media ponderada de 3 ejes
 *   4. Cruza con campaigns.cached_roas para identificar top_converting_segment
 *   5. Si score < 0.5, INSERT en vera_pending_actions con reasoning generado por template
 *
 * Vera (LLM) NUNCA se invoca aquí. Solo se activa cuando el usuario abre la
 * pending_action en chat o pide explicación bajo demanda.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

// ── Patrones de parseo del target conceptual ─────────────────────────────────

const _GENDER_PATTERNS = {
  female: /\b(mujer(?:es)?|femenin[ao]s?|chica(?:s)?|dama(?:s)?|women|female)\b/i,
  male:   /\b(hombre(?:s)?|masculin[ao]s?|chico(?:s)?|caballero(?:s)?|men|male)\b/i,
};

const _AGE_RANGE = /(\d{2})\s*(?:a|al?|hasta|-|–|—|\sto\s)\s*(\d{2})/i;

const _COUNTRY_NAMES = {
  CO: ["colombia"],
  MX: ["mexico", "méxico"],
  AR: ["argentina"],
  PE: ["perú", "peru"],
  CL: ["chile"],
  EC: ["ecuador"],
  VE: ["venezuela"],
  US: ["estados unidos", "usa", "united states"],
  ES: ["españa", "espana", "spain"],
  BR: ["brasil", "brazil"],
};

function _stripDiacritics(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function parseTargetAudience(persona) {
  const raw = _stripDiacritics(
    [
      ...(persona.datos_demograficos || []),
      ...(persona.datos_psicograficos || []),
      persona.description || "",
      persona.name || "",
    ].join(" \n ")
  );

  let expectedGender = null;
  const hasFemale = _GENDER_PATTERNS.female.test(raw);
  const hasMale   = _GENDER_PATTERNS.male.test(raw);
  if (hasFemale && !hasMale) expectedGender = "female";
  else if (hasMale && !hasFemale) expectedGender = "male";

  let ageMin = null, ageMax = null;
  const m = raw.match(_AGE_RANGE);
  if (m) {
    ageMin = parseInt(m[1], 10);
    ageMax = parseInt(m[2], 10);
  }

  const countries = [];
  for (const [code, names] of Object.entries(_COUNTRY_NAMES)) {
    if (names.some((n) => raw.includes(_stripDiacritics(n)))) countries.push(code);
  }

  // Cities: matchear nombres mencionados que aparezcan en real_location_distribution
  const realCities = Object.keys(persona.real_location_distribution?.cities || {})
    .filter((k) => !k.startsWith("_"));
  const cities = realCities.filter((c) => raw.includes(_stripDiacritics(c)));

  return { expectedGender, ageMin, ageMax, countries, cities };
}

// ── Scores por eje (todos retornan null si no hay expectativa o no hay datos) ─

function _stripMeta(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !k.startsWith("_")));
}

function scoreAge(realDist, ageMin, ageMax) {
  if (ageMin == null || ageMax == null) return null;
  const dist = _stripMeta(realDist);
  const total = Object.values(dist).reduce((s, v) => s + (Number(v) || 0), 0);
  if (total <= 0) return null;

  let inRange = 0;
  for (const [bucket, val] of Object.entries(dist)) {
    const bm = bucket.match(/(\d+)\s*-\s*(\d+)/);
    if (!bm) continue;
    const bMin = parseInt(bm[1], 10);
    const bMax = parseInt(bm[2], 10);
    const overlapMin = Math.max(bMin, ageMin);
    const overlapMax = Math.min(bMax, ageMax);
    if (overlapMin <= overlapMax) {
      const bucketSpan  = bMax - bMin + 1;
      const overlapSpan = overlapMax - overlapMin + 1;
      inRange += Number(val) * (overlapSpan / bucketSpan);
    }
  }
  return inRange / total;
}

function scoreGender(realDist, expectedGender) {
  if (!expectedGender) return null;
  const dist = _stripMeta(realDist);
  const total = Object.values(dist).reduce((s, v) => s + (Number(v) || 0), 0);
  if (total <= 0) return null;
  return Number(dist[expectedGender] || 0) / total;
}

function scoreLocation(realDist, countries, cities) {
  const realCountries = _stripMeta(realDist?.countries);
  const realCities    = _stripMeta(realDist?.cities);
  const totalC  = Object.values(realCountries).reduce((s, v) => s + Number(v), 0);
  const totalCi = Object.values(realCities).reduce((s, v) => s + Number(v), 0);

  let scoreC = null, scoreCi = null;
  if (countries.length && totalC > 0) {
    const matched = countries.reduce((s, c) => s + Number(realCountries[c] || 0), 0);
    scoreC = matched / totalC;
  }
  if (cities.length && totalCi > 0) {
    const matched = cities.reduce((s, c) => s + Number(realCities[c] || 0), 0);
    scoreCi = matched / totalCi;
  }
  if (scoreC == null && scoreCi == null) return null;
  if (scoreC == null) return scoreCi;
  if (scoreCi == null) return scoreC;
  return (scoreC + scoreCi) / 2;
}

// ── Top converting segment (cruce con campaigns.cached_roas) ────────────────

async function findTopConvertingSegment(personaId) {
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, nombre_campana, platform, cached_roas, cached_ctr, cached_conversions, cached_spend")
    .eq("persona_id", personaId)
    .not("cached_roas", "is", null)
    .order("cached_roas", { ascending: false })
    .limit(5);

  if (!campaigns?.length) return null;
  const top = campaigns[0];
  return {
    campaign_id:   top.id,
    campaign_name: top.nombre_campana,
    platform:      top.platform,
    roas:          Number(top.cached_roas) || 0,
    ctr:           top.cached_ctr != null ? Number(top.cached_ctr) : null,
    conversions:   Number(top.cached_conversions) || 0,
    spend:         Number(top.cached_spend) || 0,
  };
}

function _topEntry(dist) {
  const entries = Object.entries(_stripMeta(dist)).sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries[0] || null;
}

// ── Función por persona ─────────────────────────────────────────────────────

export async function runAlignmentForPersona(persona, organizationId) {
  const realAge      = persona.real_age_distribution      || {};
  const realGender   = persona.real_gender_distribution   || {};
  const realLocation = persona.real_location_distribution || {};

  const hasAge      = Object.keys(_stripMeta(realAge)).length > 0;
  const hasGender   = Object.keys(_stripMeta(realGender)).length > 0;
  const hasLocation = Object.keys(_stripMeta(realLocation?.countries)).length > 0;

  if (!hasAge && !hasGender && !hasLocation) {
    return { persona_id: persona.id, skipped: true, reason: "no_real_audience_data" };
  }

  const parsed = parseTargetAudience(persona);

  const sAge      = scoreAge(realAge, parsed.ageMin, parsed.ageMax);
  const sGender   = scoreGender(realGender, parsed.expectedGender);
  const sLocation = scoreLocation(realLocation, parsed.countries, parsed.cities);

  const weights = { age: 0.4, gender: 0.3, location: 0.3 };
  let weightedSum = 0, weightTotal = 0;
  if (sAge != null)      { weightedSum += sAge      * weights.age;      weightTotal += weights.age; }
  if (sGender != null)   { weightedSum += sGender   * weights.gender;   weightTotal += weights.gender; }
  if (sLocation != null) { weightedSum += sLocation * weights.location; weightTotal += weights.location; }

  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const top   = await findTopConvertingSegment(persona.id);
  const scoreObj = { score, axes: { age: sAge, gender: sGender, location: sLocation }, weights };

  // UPDATE persona con score + top_converting_segment
  const { error: updErr } = await supabase
    .from("audience_personas")
    .update({
      alignment_score:        score,
      alignment_analyzed_at:  new Date().toISOString(),
      top_converting_segment: top || {},
      updated_at:             new Date().toISOString(),
    })
    .eq("id", persona.id);
  if (updErr) console.warn(`[alignment] update persona ${persona.id} falló: ${updErr.message}`);

  // No se crean pending_actions tipo `update_persona`: el handler
  // `execute_update_persona` fue removido en la migración Apify del 2026-04-28
  // y las acciones quedaban colgadas en `pending` para siempre (BUG-001 A).
  return {
    persona_id:        persona.id,
    persona_name:      persona.name,
    score,
    axes:              scoreObj.axes,
    top_converter:     top,
    pending_action_id: null,
  };
}

// ── Función por brand (entry point del scraper) ─────────────────────────────

export async function runAlignmentForBrand(brandContainerId, organizationId) {
  if (process.env.POST_SCRAPE_ANALYSIS_ENABLED === "false") return { count: 0, results: [], skipped: true, reason: "analysis_disabled", disabled: true };
  const { data: personas, error } = await supabase
    .from("audience_personas")
    .select("id, name, description, datos_demograficos, datos_psicograficos, brand_container_id, real_age_distribution, real_gender_distribution, real_location_distribution")
    .eq("brand_container_id", brandContainerId);

  if (error) return { error: error.message, results: [], count: 0 };
  if (!personas?.length) return { skipped: true, reason: "no_personas", results: [], count: 0 };

  const results = [];
  for (const p of personas) {
    try {
      results.push(await runAlignmentForPersona(p, organizationId));
    } catch (e) {
      console.warn(`[alignment] persona ${p.id} falló: ${e.message}`);
      results.push({ persona_id: p.id, error: e.message });
    }
  }
  return { results, count: results.length };
}
