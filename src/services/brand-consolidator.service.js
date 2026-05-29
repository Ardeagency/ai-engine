/**
 * Brand Consolidator Service — Fase 4 del brand-scraper.
 *
 * Toma el corpus agregado del page-extractor y lo procesa con gpt-4o en 3 batches
 * con structured outputs strict para producir el brand_payload final que va a
 * llenar el brand_container del wizard de Crear Org.
 *
 * Batches:
 *   1. Visual DNA      — input: colores top + tipografias + assets summary
 *                       + screenshots ausentes (futuro: agregar visual via OpenAI Vision)
 *                       output: visual_dna JSON
 *   2. Verbal DNA      — input: h1/h2 + parrafos agregados + meta descriptions
 *                       output: verbal_dna JSON
 *   3. Strategic       — input: paginas about/mission + textos largos
 *                       output: nicho_core, arquetipo, propuesta_valor, mision_vision,
 *                               palabras_clave, palabras_prohibidas, idiomas_contenido,
 *                               mercado_objetivo, slogan
 *
 * Cada batch reporta tokens_in/out y costo USD (gpt-4o pricing).
 */
import { chatCompletion } from "../lib/openai.js";

const MODEL = "gpt-4o";
const INPUT_USD_PER_M = 2.5;   // gpt-4o input pricing (2024-08)
const OUTPUT_USD_PER_M = 10;   // gpt-4o output pricing

function costFromUsage(usage) {
  const tin = usage?.prompt_tokens || 0;
  const tout = usage?.completion_tokens || 0;
  const usd = (tin * INPUT_USD_PER_M + tout * OUTPUT_USD_PER_M) / 1_000_000;
  return { tokens_in: tin, tokens_out: tout, cost_usd: usd };
}

function truncate(arr, maxItems, maxCharsEach = 500) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map((s) => typeof s === "string" ? s.slice(0, maxCharsEach) : s);
}

function joinTexts(arr, maxChars = 8000) {
  const joined = arr.filter(Boolean).join(" | ");
  return joined.length > maxChars ? joined.slice(0, maxChars) + "…" : joined;
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 1: Visual DNA

async function consolidateVisual(corpus) {
  const sys = `Eres un director de arte experto en branding. Recibes datos crudos extraidos de un sitio web (colores CSS detectados, tipografias declaradas, conteo de assets). Tu tarea es inferir la identidad VISUAL de la marca.

Devuelve JSON estricto con la estructura definida. NO inventes datos que no esten en el input. Si no puedes inferir un campo con confianza, usa null/array vacio.

Reglas:
- primary_color y secondary_color: elige los 2 hex que mejor representen la marca de los colores observados (no #ffffff/#000000 puros si hay otros disponibles)
- typography_primary: el font-family mas usado en el sitio
- estetica: 1-3 palabras como "minimalista, premium, calida"
- preferred_moods: 3-5 moods que reflejan el sitio (ej. "elegante", "energetico", "calido")
- never: array de cosas que la marca NO haria visualmente (inferido del input, ej. "saturado", "decorado", "pixel art")`;

  const user = JSON.stringify({
    colors_top: corpus.aggregated.colors_top || [],
    typography: corpus.aggregated.typography || {},
    assets_summary: corpus.aggregated.assets_summary || {},
    sample_meta: (corpus.aggregated.meta_descriptions || []).slice(0, 5),
    sample_h1: (corpus.aggregated.all_h1 || []).slice(0, 10),
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      primary_color:        { type: "string", description: "hex #RRGGBB" },
      secondary_color:      { type: "string", description: "hex #RRGGBB" },
      palette_extra:        { type: "array", items: { type: "string" }, description: "hex extra (max 4)" },
      typography_primary:   { type: ["string", "null"] },
      typography_secondary: { type: ["string", "null"] },
      estetica:             { type: "string", description: "1-3 palabras" },
      preferred_moods:      { type: "array", items: { type: "string" } },
      never:                { type: "array", items: { type: "string" } },
    },
    required: ["primary_color", "secondary_color", "palette_extra", "typography_primary", "typography_secondary", "estetica", "preferred_moods", "never"],
  };

  const { content, usage } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "visual_dna", strict: true, schema } },
    max_tokens: 800,
  });

  return { data: JSON.parse(content), ...costFromUsage(usage) };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 2: Verbal DNA

async function consolidateVerbal(corpus) {
  const sys = `Eres un estratega de comunicacion experto en branding. Recibes textos extraidos del sitio web (h1, h2, parrafos, meta descriptions). Tu tarea es inferir la identidad VERBAL de la marca.

Devuelve JSON estricto. NO inventes — si no puedes inferir con confianza, usa null o array vacio.

Reglas:
- tono_de_voz: una de [amigable, premium, tecnico, irreverente, divertido, profesional, casual, inspirador, autoritario, empatico, humoristico, serio, joven, tradicional, innovador, calido, directo, poetico, energico, tranquilo]
- tagline: si encuentras un slogan recurrente o el meta og:description; si no, null
- pilares: 3-5 valores/pilares que se repiten en el sitio (ej. "transparencia", "comunidad", "innovacion")
- verbos_inspiracion: 3-5 verbos que la marca usa (ej. "crear", "transformar", "conectar")
- palabras_clave: 5-10 palabras que aparecen frecuentemente en el copy y son parte de la identidad
- palabras_prohibidas: si detectas que la marca evita ciertos terminos por contexto (ej. "barato" si es premium); array vacio si no se puede inferir`;

  const user = JSON.stringify({
    h1: truncate(corpus.aggregated.all_h1 || [], 30, 200),
    h2: truncate(corpus.aggregated.all_h2 || [], 50, 200),
    meta_descriptions: truncate(corpus.aggregated.meta_descriptions || [], 20, 300),
    titles_sample: (corpus.pages || []).slice(0, 30).map((p) => p.title).filter(Boolean),
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      tono_de_voz:         { type: ["string", "null"] },
      tagline:             { type: ["string", "null"] },
      pilares:             { type: "array", items: { type: "string" } },
      verbos_inspiracion:  { type: "array", items: { type: "string" } },
      palabras_clave:      { type: "array", items: { type: "string" } },
      palabras_prohibidas: { type: "array", items: { type: "string" } },
    },
    required: ["tono_de_voz", "tagline", "pilares", "verbos_inspiracion", "palabras_clave", "palabras_prohibidas"],
  };

  const { content, usage } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "verbal_dna", strict: true, schema } },
    max_tokens: 1000,
  });

  return { data: JSON.parse(content), ...costFromUsage(usage) };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 3: Strategic

async function consolidateStrategic(corpus) {
  const sys = `Eres un estratega de marca senior. Recibes contenido textual de un sitio web (titulos, parrafos, meta descriptions, productos/servicios detectados). Tu tarea es identificar la POSICION ESTRATEGICA de la marca.

Devuelve JSON estricto. Si no puedes inferir un campo, null o array vacio.

Reglas:
- nicho_core: 1-3 palabras del nicho principal (ej. "skincare", "consultoria B2B", "moda sostenible")
- arquetipo: uno de [creador, cuidador, gobernante, bufon, amigo, amante, heroe, forajido, mago, inocente, explorador, sabio] o null
- propuesta_valor: 1 parrafo de max 2 frases con la propuesta de valor inferida
- mision_vision: 1 parrafo de max 2 frases con la mision/vision inferida
- slogan: si detectas frase corta clave de marca; si no, null
- idiomas_contenido: codigos ISO de idiomas detectados (ej. ["es", "en"])
- mercado_objetivo: codigos ISO de paises objetivo si se infiere (ej. ["CO", "MX"]); array vacio si no
- temas: 3-7 sub-nichos o temas (ej. "moda femenina", "estilo casual", "moda sostenible")
- timezone: una zona IANA inferida del locale (ej. "America/Bogota" si lang=es-CO); null si no se sabe
- locale: codigo ISO del idioma primario (es/en/pt)`;

  const user = JSON.stringify({
    titles: (corpus.pages || []).slice(0, 40).map((p) => p.title).filter(Boolean),
    h1: truncate(corpus.aggregated.all_h1 || [], 50, 200),
    h2: truncate(corpus.aggregated.all_h2 || [], 80, 200),
    meta_descriptions: truncate(corpus.aggregated.meta_descriptions || [], 20, 400),
    products_detected: (corpus.aggregated.products || []).slice(0, 20).map((p) => ({ name: p.name, description: p.description?.slice(0, 200) })),
    services_detected: (corpus.aggregated.services || []).slice(0, 20).map((s) => ({ name: s.name, description: s.description?.slice(0, 200) })),
    langs_detected: corpus.aggregated.langs || [],
    page_count: (corpus.pages || []).length,
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      nicho_core:         { type: ["string", "null"] },
      arquetipo:          { type: ["string", "null"] },
      propuesta_valor:    { type: ["string", "null"] },
      mision_vision:      { type: ["string", "null"] },
      slogan:             { type: ["string", "null"] },
      idiomas_contenido:  { type: "array", items: { type: "string" } },
      mercado_objetivo:   { type: "array", items: { type: "string" } },
      temas:              { type: "array", items: { type: "string" } },
      timezone:           { type: ["string", "null"] },
      locale:             { type: ["string", "null"] },
    },
    required: ["nicho_core", "arquetipo", "propuesta_valor", "mision_vision", "slogan", "idiomas_contenido", "mercado_objetivo", "temas", "timezone", "locale"],
  };

  const { content, usage } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "strategic_dna", strict: true, schema } },
    max_tokens: 1500,
  });

  return { data: JSON.parse(content), ...costFromUsage(usage) };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator publico

/**
 * consolidate — corre los 3 batches en serie y devuelve brand_payload + costo total.
 *
 * @param {object} corpus  output de page-extractor.extractCorpus()
 * @returns {Promise<{ brand_payload, cost_usd, tokens_in, tokens_out, batches }>}
 */
export async function consolidate(corpus) {
  const startedAt = Date.now();
  const batches = {};
  let totalIn = 0, totalOut = 0, totalUsd = 0;

  // Batch 1: Visual
  try {
    const r = await consolidateVisual(corpus);
    batches.visual = { ok: true, ...r };
    totalIn += r.tokens_in; totalOut += r.tokens_out; totalUsd += r.cost_usd;
  } catch (e) {
    batches.visual = { ok: false, error: e.message };
  }

  // Batch 2: Verbal
  try {
    const r = await consolidateVerbal(corpus);
    batches.verbal = { ok: true, ...r };
    totalIn += r.tokens_in; totalOut += r.tokens_out; totalUsd += r.cost_usd;
  } catch (e) {
    batches.verbal = { ok: false, error: e.message };
  }

  // Batch 3: Strategic
  try {
    const r = await consolidateStrategic(corpus);
    batches.strategic = { ok: true, ...r };
    totalIn += r.tokens_in; totalOut += r.tokens_out; totalUsd += r.cost_usd;
  } catch (e) {
    batches.strategic = { ok: false, error: e.message };
  }

  // Ensamblar brand_payload final desde los 3 batches
  const v = batches.visual?.data || {};
  const w = batches.verbal?.data || {};
  const s = batches.strategic?.data || {};

  const brand_payload = {
    // Identidad estrategica
    nicho_core: s.nicho_core || null,
    arquetipo: s.arquetipo || null,
    propuesta_valor: s.propuesta_valor || null,
    mision_vision: s.mision_vision || null,
    creative_brief: null, // futuro: batch 4 dedicado
    // Verbal
    tono_de_voz: w.tono_de_voz || null,
    tagline: w.tagline || s.slogan || null,
    pilares: w.pilares || [],
    verbos_inspiracion: w.verbos_inspiracion || [],
    palabras_clave: w.palabras_clave || [],
    palabras_prohibidas: w.palabras_prohibidas || [],
    // Visual
    primary_color: v.primary_color || "#000000",
    secondary_color: v.secondary_color || "#ffffff",
    palette_extra: v.palette_extra || [],
    typography_primary: v.typography_primary || null,
    typography_secondary: v.typography_secondary || null,
    estetica: v.estetica || null,
    preferred_moods: v.preferred_moods || [],
    never: v.never || [],
    // Region + estrategia
    locale: s.locale || (corpus.aggregated?.langs?.[0]?.lang || null),
    timezone: s.timezone || null,
    idiomas_contenido: s.idiomas_contenido || [],
    mercado_objetivo: s.mercado_objetivo || [],
    temas: s.temas || [],
    // Productos/servicios detectados (sin filtrar por LLM, vienen de schema.org)
    products_detected: (corpus.aggregated?.products || []).slice(0, 20),
    services_detected: (corpus.aggregated?.services || []).slice(0, 20),
    // Social
    social: corpus.aggregated?.social || [],
  };

  return {
    brand_payload,
    cost_usd: totalUsd,
    tokens_in: totalIn,
    tokens_out: totalOut,
    duration_ms: Date.now() - startedAt,
    batches: {
      visual:    { ok: batches.visual?.ok, cost: batches.visual?.cost_usd, error: batches.visual?.error },
      verbal:    { ok: batches.verbal?.ok, cost: batches.verbal?.cost_usd, error: batches.verbal?.error },
      strategic: { ok: batches.strategic?.ok, cost: batches.strategic?.cost_usd, error: batches.strategic?.error },
    },
  };
}
