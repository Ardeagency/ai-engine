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

// Nichos REALES de mercado — el LLM elige uno de esta lista (enum), no inventa.
// Debe mantenerse en sync con el dropdown del frontend (DevLeadCreateOrgView).
export const MARKET_NICHES = [
  "snacks saludables", "alimentos y bebidas", "comida saludable", "cafe", "reposteria",
  "bebidas energeticas", "bebidas funcionales", "suplementos y nutricion deportiva", "vitaminas y suplementos",
  "skincare", "maquillaje", "cuidado del cabello", "perfumeria", "cuidado personal e higiene",
  "moda femenina", "moda masculina", "ropa deportiva", "calzado", "accesorios de moda", "joyeria y relojeria",
  "tecnologia y electronica", "accesorios tecnologicos", "software y apps", "gaming",
  "fitness y entrenamiento", "bienestar y salud", "salud (servicios medicos)",
  "hogar y decoracion", "muebles", "electrodomesticos",
  "educacion y cursos", "consultoria y agencias", "servicios financieros y fintech", "turismo y viajes",
  "mascotas", "bebes y maternidad", "automotriz", "deportes y outdoor",
  "libreria y papeleria", "jugueteria", "arte y manualidades", "ecommerce y retail", "restaurantes y food service",
  "otro",
];

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

// og:site_name de cualquier pagina (pista del nombre real de marca).
function detectSiteName(corpus) {
  for (const p of corpus.pages || []) {
    const sn = p.meta?.og?.site_name;
    if (sn && sn.trim()) return sn.trim();
  }
  return null;
}

// Dominio raiz del sitio (para que el LLM NO use el dominio como nombre).
function detectDomain(corpus) {
  const url = (corpus.pages || [])[0]?.url;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// URLs de imagenes representativas para analisis visual (og:image + fotos de producto).
function collectImageUrls(corpus, max = 7) {
  const out = [];
  const push = (u) => { if (u && typeof u === "string" && /^https?:\/\//i.test(u)) out.push(u.trim()); };
  for (const p of (corpus.pages || []).slice(0, 15)) push(p.meta?.og?.image);     // hero
  for (const vp of (corpus.aggregated?.video_posters || [])) push(vp);            // frames de video (alto valor)
  for (const pr of (corpus.aggregated?.products || []).slice(0, 8)) push(pr.image); // producto
  for (const p of (corpus.pages || []).slice(0, 15)) push(p.meta?.twitter?.image);
  return [...new Set(out)].slice(0, max);
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
- tagline: SOLO el slogan/lema de marca corto y memorable (idealmente 2-7 palabras, ej. "Just Do It"). NUNCA uses una descripcion de producto, una lista de features, ni el meta og:description. Si no hay un lema de marca claro, null
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
- brand_name: el nombre REAL de la marca (de og:site_name, el logo, titulos o el copy). NUNCA uses el dominio de la URL como nombre (ej. si el dominio es "wakeupnf.com" pero la marca se llama "WakeUp", devuelve "WakeUp"). Si no puedes determinar el nombre real con confianza, null.
- nicho_core: elige EXACTAMENTE uno de la lista de nichos reales de mercado provista en el schema (enum). Usa el mas representativo de la marca; si ninguno aplica, "otro". NO inventes nichos que no existan.
- arquetipo: uno de [creador, cuidador, gobernante, bufon, amigo, amante, heroe, forajido, mago, inocente, explorador, sabio] o null
- propuesta_valor: 1 parrafo de max 2 frases con la propuesta de valor inferida
- mision_vision: 1 parrafo de max 2 frases con la mision/vision inferida
- creative_brief: 1-2 frases de sintesis creativa de la marca (que es, para quien, como se diferencia, su esencia). Concreto y util para que una IA genere contenido.
- objetivos_estrategicos: 3-5 objetivos estrategicos de marca/marketing inferidos (ej. "construir comunidad", "educar sobre nutricion", "posicionar como premium")
- slogan: si detectas frase corta clave de marca; si no, null
- idiomas_contenido: codigos ISO de idiomas detectados (ej. ["es", "en"])
- mercado_objetivo: codigos ISO de paises objetivo si se infiere (ej. ["CO", "MX"]); array vacio si no
- temas: 3-7 sub-nichos o temas (ej. "moda femenina", "estilo casual", "moda sostenible")
- timezone: una zona IANA inferida del locale (ej. "America/Bogota" si lang=es-CO); null si no se sabe
- locale: codigo ISO del idioma primario (es/en/pt)`;

  const user = JSON.stringify({
    og_site_name: detectSiteName(corpus),
    dominio_url: detectDomain(corpus),
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
      brand_name:           { type: ["string", "null"] },
      nicho_core:           { type: "string", enum: MARKET_NICHES },
      arquetipo:            { type: ["string", "null"] },
      propuesta_valor:      { type: ["string", "null"] },
      mision_vision:        { type: ["string", "null"] },
      creative_brief:       { type: ["string", "null"] },
      objetivos_estrategicos: { type: "array", items: { type: "string" } },
      slogan:               { type: ["string", "null"] },
      idiomas_contenido:    { type: "array", items: { type: "string" } },
      mercado_objetivo:     { type: "array", items: { type: "string" } },
      temas:                { type: "array", items: { type: "string" } },
      timezone:             { type: ["string", "null"] },
      locale:               { type: ["string", "null"] },
    },
    required: ["brand_name", "nicho_core", "arquetipo", "propuesta_valor", "mision_vision", "creative_brief", "objetivos_estrategicos", "slogan", "idiomas_contenido", "mercado_objetivo", "temas", "timezone", "locale"],
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

// ────────────────────────────────────────────────────────────────────────────
// Batch 4: Vision — gpt-4o mira imagenes reales para captar como comunica la marca

async function consolidateVision(corpus) {
  const imageUrls = collectImageUrls(corpus, 6);
  if (imageUrls.length === 0) return { data: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, skipped: true };

  const sys = `Eres un director creativo y de marca. Te muestro imagenes reales del sitio/contenido de una marca: hero, producto, lifestyle y FRAMES DE VIDEOS de la marca. Tu tarea es entender COMO COMUNICA la marca a partir de lo visual y audiovisual: tono, animo, estilo, lenguaje visual y como se mueve/expresa en sus videos. Esto es clave para que otra IA genere contenido fiel a la marca, no generico.

Devuelve JSON estricto. Si no puedes inferir un campo, null o array vacio.
Reglas:
- tono_de_voz: el tono que TRANSMITEN las imagenes, una de [amigable, premium, tecnico, irreverente, divertido, profesional, casual, inspirador, autoritario, empatico, humoristico, serio, joven, tradicional, innovador, calido, directo, poetico, energico, tranquilo]. Elige el que mejor refleje la realidad visual, NO el generico "profesional" por defecto.
- mood: 3-6 palabras del animo/atmosfera (ej. "vibrante", "natural", "energico", "minimalista")
- estilo_visual: 1 frase del estilo (fotografia, color, composicion)
- signature_hints: 3-6 rasgos de FIRMA visual concretos y accionables (ej. "luz rim calida puntual", "sombra real marcada", "materialidad mate", "asimetria como tension", "macro de textura")
- como_comunica: 1-2 frases concretas de COMO comunica la marca (lenguaje visual, que evoca, a quien le habla)
- brand_name_visible: si un logo muestra el nombre de la marca, devuelvelo; si no, null`;

  const content = [
    { type: "text", text: "Analiza la comunicacion visual de esta marca a partir de estas imagenes:" },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
  ];

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      tono_de_voz:        { type: ["string", "null"] },
      mood:               { type: "array", items: { type: "string" } },
      estilo_visual:      { type: ["string", "null"] },
      signature_hints:    { type: "array", items: { type: "string" } },
      como_comunica:      { type: ["string", "null"] },
      brand_name_visible: { type: ["string", "null"] },
    },
    required: ["tono_de_voz", "mood", "estilo_visual", "signature_hints", "como_comunica", "brand_name_visible"],
  };

  const { content: out, usage } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "visual_communication", strict: true, schema } },
    max_tokens: 700,
    temperature: 0.4,
  });
  return { data: JSON.parse(out), ...costFromUsage(usage), images_used: imageUrls.length };
}

/**
 * consolidate — corre los batches (incl. vision) y devuelve brand_payload + costo total.
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

  // Batch 4: Vision (imagenes reales → como comunica la marca)
  try {
    const r = await consolidateVision(corpus);
    if (r.skipped) { batches.vision = { ok: false, skipped: true }; }
    else { batches.vision = { ok: true, ...r }; totalIn += r.tokens_in; totalOut += r.tokens_out; totalUsd += r.cost_usd; }
  } catch (e) {
    batches.vision = { ok: false, error: e.message };
  }

  // Ensamblar brand_payload final
  const v = batches.visual?.data || {};
  const w = batches.verbal?.data || {};
  const s = batches.strategic?.data || {};
  const vis = batches.vision?.data || {};

  // Nombre real: estrategico → logo visible → og:site_name. NUNCA el dominio.
  const domain = detectDomain(corpus);
  const brand_name = [s.brand_name, vis.brand_name_visible, detectSiteName(corpus)]
    .map((x) => (x || "").trim())
    .find((x) => x && x.toLowerCase() !== (domain || "").toLowerCase()) || null;

  // Moods: union de visual + vision
  const moods = [...new Set([...(v.preferred_moods || []), ...(vis.mood || [])])];

  const brand_payload = {
    // Nombre real de la marca (no el dominio)
    brand_name,
    // Identidad estrategica
    nicho_core: s.nicho_core || null,
    arquetipo: s.arquetipo || null,
    propuesta_valor: s.propuesta_valor || null,
    mision_vision: s.mision_vision || null,
    creative_brief: s.creative_brief || null,
    objetivos_estrategicos: s.objetivos_estrategicos || [],
    // Verbal — el tono lo manda la VISION (refleja la comunicacion real); verbal es fallback
    tono_de_voz: vis.tono_de_voz || w.tono_de_voz || null,
    tagline: w.tagline || s.slogan || null,
    como_comunica: vis.como_comunica || null,
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
    estetica: v.estetica || vis.estilo_visual || null,
    preferred_moods: moods,
    signature_hints: vis.signature_hints || [],
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
      vision:    { ok: batches.vision?.ok, cost: batches.vision?.cost_usd, error: batches.vision?.error, images: batches.vision?.images_used },
    },
  };
}
