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
import { claudeJson, CLAUDE_MODEL } from "../lib/anthropic.js";

// Simbiosis de motores. Cada batch corre en el modelo que le conviene:
//   OpenAI  — lectura interpretativa: leer el alma de la marca en su copy y sus
//             imagenes (ADN visual, ADN verbal, vision).
//   Claude  — instruccion larga con reglas duras y esquema exigente: taxonomias
//             cerradas (posicion estrategica), audiencias con dolores/objeciones/
//             gatillos, y extraccion literal de reglas de negocio sin inventar.
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
    max_tokens: 2500,
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
- palabras_clave: 8-15 palabras que aparecen frecuentemente en el copy y son parte de la identidad
- palabras_prohibidas: terminos que la marca evita por contexto (ej. "barato" si es premium, o vocabulario clinico si habla calido); array vacio si no se puede inferir
- frases_propias: 5-10 expresiones LITERALES del sitio que suenan a la marca y podrian reusarse tal cual
- ejemplos_si: 2-4 frases de ejemplo escritas EN el tono de la marca (inventadas por ti, fieles al registro observado)
- ejemplos_no: 2-4 frases que la marca NUNCA diria, para marcar el limite del tono
- como_comunica: 2-4 frases sobre COMO habla: a quien le habla, si tutea o no, que promete y que evita prometer`;

  const user = JSON.stringify({
    h1: truncate(corpus.aggregated.all_h1 || [], 40, 250),
    h2: truncate(corpus.aggregated.all_h2 || [], 60, 250),
    meta_descriptions: truncate(corpus.aggregated.meta_descriptions || [], 25, 400),
    titles_sample: (corpus.pages || []).slice(0, 40).map((p) => p.title).filter(Boolean),
    // La prosa real del sitio: aqui vive el tono, no en los titulares.
    parrafos: (corpus.aggregated.paragraphs || []).slice(0, 120).map((p) => p.text),
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
      frases_propias:      { type: "array", items: { type: "string" } },
      ejemplos_si:         { type: "array", items: { type: "string" } },
      ejemplos_no:         { type: "array", items: { type: "string" } },
      como_comunica:       { type: ["string", "null"] },
    },
    required: ["tono_de_voz", "tagline", "pilares", "verbos_inspiracion", "palabras_clave", "palabras_prohibidas", "frases_propias", "ejemplos_si", "ejemplos_no", "como_comunica"],
  };

  const { content, usage } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "verbal_dna", strict: true, schema } },
    max_tokens: 3500,
  });

  return { data: JSON.parse(content), ...costFromUsage(usage) };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 3: Strategic

async function consolidateStrategic(corpus) {
  const sys = `Eres un estratega de marca senior. Recibes el contenido textual de un sitio web (titulos, titulares, PARRAFOS REALES del sitio, meta descriptions y productos/servicios detectados). Tu tarea es reconstruir la POSICION ESTRATEGICA de la marca con la profundidad con la que la escribiria un consultor que cobra por ella.

Devuelve JSON estricto.

REGLA DE HONESTIDAD (la mas importante): distingue lo que el sitio DICE de lo que tu INFIERES. Nunca inventes cifras, fechas, fundadores, premios ni mercados que no aparezcan en el material. Si un campo no se puede sostener con el material, devuelve null o array vacio y bajalo en 'confianza'. Es preferible un campo vacio a uno inventado: esta ficha va a alimentar a un agente que le habla al cliente.

Reglas por campo:
- brand_name: el nombre REAL de la marca (de og:site_name, el logo, titulos o el copy). NUNCA el dominio (si el dominio es "wakeupnf.com" y la marca es "WakeUp", devuelve "WakeUp"). null si no se puede determinar.
- nicho_core: EXACTAMENTE uno del enum. El mas representativo; "otro" si ninguno aplica.
- arquetipo: uno de [creador, cuidador, gobernante, bufon, amigo, amante, heroe, forajido, mago, inocente, explorador, sabio] o null. Elige por como se comporta la marca, no por su categoria.
- propuesta_valor: 3 a 5 frases. Que vende, a quien, con que mecanismo concreto (ingrediente, tecnologia, servicio, proceso) y contra que alternativa gana. Nada de "productos de calidad para clientes exigentes": eso no dice nada.
- mision_vision: 2 a 4 frases con el proposito declarado. Si el sitio lo declara textualmente, respetalo casi literal.
- creative_brief: 6 a 10 frases. Que es la empresa y de donde viene, quien es el cliente real, como se diferencia de verdad, en que tono habla, y — clave — que NO es la marca. Es el texto que otra IA va a leer para generar contenido fiel: escribelo para que sea util, no para que suene bonito.
- objetivos_estrategicos: 4 a 6 objetivos con verbo y objeto concreto, inferidos de lo que la marca empuja en su sitio (ej. "convertir visitantes en compradores recurrentes con el programa de suscripcion", no "crecer").
- diferenciadores: 3 a 6 diferenciadores REALES y verificables en el material, no adjetivos.
- momentos_de_uso: 3 a 6 ocasiones concretas de consumo o uso que el sitio sugiere.
- competencia_declarada: marcas o categorias contra las que el sitio se compara explicitamente; array vacio si no compara.
- slogan: frase corta de marca si existe; null si no.
- idiomas_contenido: codigos ISO detectados (ej. ["es","en"]).
- mercado_objetivo: codigos ISO de pais (ej. ["CO","US"]). Incluye un pais solo si hay senal real: moneda, envios, sedes, telefonos, idioma o menciones explicitas.
- temas: 3 a 7 sub-nichos concretos.
- timezone: zona IANA inferida del locale; null si no se sabe.
- locale: codigo ISO del idioma primario.
- evidencia: 3 a 6 citas LITERALES y cortas del material que sostienen lo que afirmaste.
- confianza: alta si el sitio es rico y explicito; media si tuviste que inferir bastante; baja si el material es pobre y casi todo es deduccion.`;

  const user = JSON.stringify({
    og_site_name: detectSiteName(corpus),
    dominio_url: detectDomain(corpus),
    titles: (corpus.pages || []).slice(0, 40).map((p) => p.title).filter(Boolean),
    h1: truncate(corpus.aggregated.all_h1 || [], 50, 250),
    h2: truncate(corpus.aggregated.all_h2 || [], 80, 250),
    meta_descriptions: truncate(corpus.aggregated.meta_descriptions || [], 25, 400),
    parrafos: (corpus.aggregated.paragraphs || []).slice(0, 160).map((p) => p.text),
    products_detected: (corpus.aggregated.products || []).slice(0, 25).map((p) => ({ name: p.name, description: (p.description || "").slice(0, 300), price: p.price })),
    services_detected: (corpus.aggregated.services || []).slice(0, 25).map((s) => ({ name: s.name, description: (s.description || "").slice(0, 300) })),
    social_detectado: (corpus.aggregated.social || []).map((s) => s.platform || s),
    langs_detected: corpus.aggregated.langs || [],
    page_count: (corpus.pages || []).length,
    rutas: (corpus.pages || []).slice(0, 60).map((p) => p.url),
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      brand_name:             { type: ["string", "null"] },
      nicho_core:             { type: "string", enum: MARKET_NICHES },
      arquetipo:              { type: ["string", "null"] },
      propuesta_valor:        { type: ["string", "null"] },
      mision_vision:          { type: ["string", "null"] },
      creative_brief:         { type: ["string", "null"] },
      objetivos_estrategicos: { type: "array", items: { type: "string" } },
      diferenciadores:        { type: "array", items: { type: "string" } },
      momentos_de_uso:        { type: "array", items: { type: "string" } },
      competencia_declarada:  { type: "array", items: { type: "string" } },
      slogan:                 { type: ["string", "null"] },
      idiomas_contenido:      { type: "array", items: { type: "string" } },
      mercado_objetivo:       { type: "array", items: { type: "string" } },
      temas:                  { type: "array", items: { type: "string" } },
      timezone:               { type: ["string", "null"] },
      locale:                 { type: ["string", "null"] },
      evidencia:              { type: "array", items: { type: "string" } },
      confianza:              { type: "string", enum: ["alta", "media", "baja"] },
    },
    required: ["brand_name", "nicho_core", "arquetipo", "propuesta_valor", "mision_vision", "creative_brief", "objetivos_estrategicos", "diferenciadores", "momentos_de_uso", "competencia_declarada", "slogan", "idiomas_contenido", "mercado_objetivo", "temas", "timezone", "locale", "evidencia", "confianza"],
  };

  const r = await claudeJson({ system: sys, user, schema, maxTokens: 8000, effort: "high" });
  return { data: r.data, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd, engine: "claude" };
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
    max_tokens: 2500,
    temperature: 0.4,
  });
  return { data: JSON.parse(out), ...costFromUsage(usage), images_used: imageUrls.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 5: Audiencias (Claude) — a quien le habla la marca, con dolores,
// objeciones y gatillos. Es la tabla mas rica del esquema (audience_personas) y
// hasta 2026-07 el creador de orgs no la llenaba NUNCA: por eso el fusionador
// de demografia real del social-scraper y el generador de ADN quedaban muertos.
// Depende del batch estrategico: recibe su salida para no contradecirlo.

async function consolidateAudience(corpus, strategic) {
  const sys = `Eres un estratega de audiencias. Recibes el contenido de un sitio web y la posicion estrategica ya inferida de la marca. Tu tarea es reconstruir a QUIEN le habla esta marca, con el detalle con el que lo haria un planner antes de una campana.

Devuelve JSON estricto.

REGLA DE HONESTIDAD: apoyate en senales reales del material (a quien se dirige el copy, que productos vende, que preguntas responde, que objeciones contesta, en que canales esta). No inventes datos demograficos precisos que el sitio no sugiera; si no hay senal, deja el campo vacio y bajalo en 'confianza'. Una persona inventada es peor que ninguna: esta ficha va a orientar decisiones de pauta y contenido.

Devuelve entre 3 y 6 personas. Deben ser DISTINTAS entre si (no la misma persona con otra edad) y cubrir el negocio real: si la marca vende a consumidor y tambien al por mayor, incluye la persona compradora B2B.

Por cada persona:
- name: un nombre-etiqueta memorable y humano, no un codigo. Ej. "La que sostiene la casa despierta", nunca "Persona 1" ni "Segmento A".
- description: 3 a 5 frases. Quien es, en que momento de su vida esta, y cual es su relacion con esta categoria. Concreto.
- awareness_level: uno de [unaware, problem_aware, solution_aware, product_aware, most_aware] segun que tan consciente es de la marca y del problema.
- dolores: 3 a 5 frustraciones REALES, en su lenguaje, no en el de la marca.
- deseos: 3 a 5 cosas que quiere lograr (el trabajo que le encarga al producto).
- objeciones: 3 a 5 razones por las que NO compraria, dichas como las diria: "es muy caro", "no se si me va a servir". Este campo es el mas valioso: sin objeciones no hay argumentario.
- gatillos_compra: 3 a 5 cosas concretas que le hacen decidirse.
- estilo_lenguaje: 3 a 5 notas sobre como hablarle (registro, tuteo, si acepta datos tecnicos, que la aburre).
- datos_demograficos: 3 a 5 rasgos, solo si hay senal en el material.
- datos_psicograficos: 3 a 5 rasgos de comportamiento y valores.
- target_age_min / target_age_max: rango etario estimado (enteros).
- target_genders: subconjunto de ["F","M"]; ambos si aplica a todos.
- es_principal: true SOLO para la persona que mas peso tiene en el negocio (una o dos como maximo).
- por_que_existe: 1 frase citando la senal del sitio que sostiene esta persona.

Ademas devuelve 'confianza' global: alta / media / baja.`;

  const user = JSON.stringify({
    posicion_estrategica: {
      nicho: strategic?.nicho_core || null,
      propuesta_valor: strategic?.propuesta_valor || null,
      diferenciadores: strategic?.diferenciadores || [],
      momentos_de_uso: strategic?.momentos_de_uso || [],
      mercado_objetivo: strategic?.mercado_objetivo || [],
    },
    h1: truncate(corpus.aggregated.all_h1 || [], 40, 250),
    h2: truncate(corpus.aggregated.all_h2 || [], 60, 250),
    parrafos: (corpus.aggregated.paragraphs || []).slice(0, 160).map((p) => p.text),
    productos: (corpus.aggregated.products || []).slice(0, 25).map((p) => ({ name: p.name, description: (p.description || "").slice(0, 250), price: p.price })),
    servicios: (corpus.aggregated.services || []).slice(0, 25).map((s) => ({ name: s.name, description: (s.description || "").slice(0, 250) })),
    rutas: (corpus.pages || []).slice(0, 60).map((p) => p.url),
  });

  const persona = {
    type: "object",
    additionalProperties: false,
    properties: {
      name:                { type: "string" },
      description:         { type: "string" },
      awareness_level:     { type: "string", enum: ["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"] },
      dolores:             { type: "array", items: { type: "string" } },
      deseos:              { type: "array", items: { type: "string" } },
      objeciones:          { type: "array", items: { type: "string" } },
      gatillos_compra:     { type: "array", items: { type: "string" } },
      estilo_lenguaje:     { type: "array", items: { type: "string" } },
      datos_demograficos:  { type: "array", items: { type: "string" } },
      datos_psicograficos: { type: "array", items: { type: "string" } },
      target_age_min:      { type: ["integer", "null"] },
      target_age_max:      { type: ["integer", "null"] },
      target_genders:      { type: "array", items: { type: "string", enum: ["F", "M"] } },
      es_principal:        { type: "boolean" },
      por_que_existe:      { type: "string" },
    },
    required: ["name", "description", "awareness_level", "dolores", "deseos", "objeciones", "gatillos_compra", "estilo_lenguaje", "datos_demograficos", "datos_psicograficos", "target_age_min", "target_age_max", "target_genders", "es_principal", "por_que_existe"],
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      audiencias: { type: "array", items: persona },
      confianza:  { type: "string", enum: ["alta", "media", "baja"] },
    },
    required: ["audiencias", "confianza"],
  };

  const r = await claudeJson({ system: sys, user, schema, maxTokens: 16000, effort: "high" });
  return { data: r.data, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd, engine: "claude" };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch 6: Reglas de negocio (Claude) — envios, pagos, devoluciones, mayoristas,
// garantias, contacto. Son las respuestas que un cliente pregunta a diario y que
// hasta ahora no se capturaban en ningun lado (brand_rules estaba vacia en TODA
// la plataforma). Aqui NO se infiere: se extrae literal o no se pone.

async function consolidateBusinessRules(corpus) {
  const sys = `Eres un analista que documenta las condiciones comerciales de una marca a partir de su sitio web.

Devuelve JSON estricto.

REGLA ABSOLUTA: aqui NO se infiere, se EXTRAE. Cada regla debe estar sostenida por texto del sitio. Si el sitio no dice cuanto cuesta el envio, no lo estimes: omite la regla. Una condicion comercial inventada le hace perder plata o credibilidad al cliente. Ante la duda, no la incluyas.

Devuelve solo las reglas que encuentres (puede ser un array vacio). Por cada una:
- tipo: uno de [envio, pagos, devoluciones, garantia, mayoristas, contacto, horarios, suscripcion, promociones, legal]
- resumen: 1 frase corta y accionable (ej. "Envio gratis en pedidos sobre $200.000").
- detalle: 1 a 3 frases con la condicion completa: montos, plazos, excepciones.
- cita: el fragmento LITERAL del sitio que la sostiene, tal cual aparece.
- fuente_url: la URL donde aparece, si la puedes identificar; null si no.

Ademas:
- canales_contacto: telefonos, correos o WhatsApp que aparezcan literalmente en el sitio.
- confianza: alta / media / baja segun que tan explicito era el material.`;

  const user = JSON.stringify({
    // La prosa completa importa aqui: las politicas viven en parrafos y FAQ.
    parrafos: (corpus.aggregated.paragraphs || []).slice(0, 220),
    h2: truncate(corpus.aggregated.all_h2 || [], 80, 250),
    rutas: (corpus.pages || []).slice(0, 60).map((p) => p.url),
  });

  const regla = {
    type: "object",
    additionalProperties: false,
    properties: {
      tipo:       { type: "string", enum: ["envio", "pagos", "devoluciones", "garantia", "mayoristas", "contacto", "horarios", "suscripcion", "promociones", "legal"] },
      resumen:    { type: "string" },
      detalle:    { type: "string" },
      cita:       { type: "string" },
      fuente_url: { type: ["string", "null"] },
    },
    required: ["tipo", "resumen", "detalle", "cita", "fuente_url"],
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      reglas:           { type: "array", items: regla },
      canales_contacto: { type: "array", items: { type: "string" } },
      confianza:        { type: "string", enum: ["alta", "media", "baja"] },
    },
    required: ["reglas", "canales_contacto", "confianza"],
  };

  const r = await claudeJson({ system: sys, user, schema, maxTokens: 12000, effort: "high" });
  return { data: r.data, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd, engine: "claude" };
}

/**
 * consolidate — corre los 6 batches y devuelve brand_payload + costo total.
 *
 * Orden: los tres de lectura (visual, verbal, vision) corren primero; el
 * estrategico despues; y audiencias depende del estrategico para no
 * contradecirlo. Reglas de negocio es independiente.
 *
 * @param {object} corpus  output de page-extractor.extractCorpus()
 * @returns {Promise<{ brand_payload, cost_usd, tokens_in, tokens_out, batches }>}
 */
export async function consolidate(corpus) {
  const startedAt = Date.now();
  const batches = {};
  let totalIn = 0, totalOut = 0, totalUsd = 0;
  let usdOpenai = 0, usdClaude = 0;

  const correr = async (nombre, fn) => {
    try {
      const r = await fn();
      if (r?.skipped) { batches[nombre] = { ok: false, skipped: true }; return null; }
      batches[nombre] = { ok: true, ...r };
      totalIn += r.tokens_in || 0; totalOut += r.tokens_out || 0; totalUsd += r.cost_usd || 0;
      if (r.engine === "claude") usdClaude += r.cost_usd || 0; else usdOpenai += r.cost_usd || 0;
      return r.data;
    } catch (e) {
      console.error(`brand-consolidator: batch ${nombre} fallo:`, e.message);
      batches[nombre] = { ok: false, error: e.message };
      return null;
    }
  };

  // Lectura interpretativa (OpenAI)
  const v   = (await correr("visual",  () => consolidateVisual(corpus)))  || {};
  const w   = (await correr("verbal",  () => consolidateVerbal(corpus)))  || {};
  const vis = (await correr("vision",  () => consolidateVision(corpus)))  || {};

  // Criterio estructurado (Claude)
  const s   = (await correr("strategic", () => consolidateStrategic(corpus))) || {};
  const aud = (await correr("audience",  () => consolidateAudience(corpus, s))) || {};
  const biz = (await correr("rules",     () => consolidateBusinessRules(corpus))) || {};

  // Nombre real: estrategico → logo visible → og:site_name. NUNCA el dominio.
  const domain = detectDomain(corpus);
  const brand_name = [s.brand_name, vis.brand_name_visible, detectSiteName(corpus)]
    .map((x) => (x || "").trim())
    .find((x) => x && x.toLowerCase() !== (domain || "").toLowerCase()) || null;

  // Moods: union de visual + vision
  const moods = [...new Set([...(v.preferred_moods || []), ...(vis.mood || [])])];

  const brand_payload = {
    brand_name,
    // Identidad estrategica
    nicho_core: s.nicho_core || null,
    arquetipo: s.arquetipo || null,
    propuesta_valor: s.propuesta_valor || null,
    mision_vision: s.mision_vision || null,
    creative_brief: s.creative_brief || null,
    objetivos_estrategicos: s.objetivos_estrategicos || [],
    diferenciadores: s.diferenciadores || [],
    momentos_de_uso: s.momentos_de_uso || [],
    competencia_declarada: s.competencia_declarada || [],
    // Verbal — el tono lo manda la VISION (refleja la comunicacion real); verbal es fallback
    tono_de_voz: vis.tono_de_voz || w.tono_de_voz || null,
    tagline: w.tagline || s.slogan || null,
    como_comunica: vis.como_comunica || w.como_comunica || null,
    pilares: w.pilares || [],
    verbos_inspiracion: w.verbos_inspiracion || [],
    palabras_clave: w.palabras_clave || [],
    palabras_prohibidas: w.palabras_prohibidas || [],
    frases_propias: w.frases_propias || [],
    ejemplos_si: w.ejemplos_si || [],
    ejemplos_no: w.ejemplos_no || [],
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
    // A quien le habla y bajo que condiciones vende (nuevo)
    audiencias: aud.audiencias || [],
    reglas_negocio: biz.reglas || [],
    canales_contacto: biz.canales_contacto || [],
    // Productos/servicios detectados (sin filtrar por LLM, vienen de schema.org)
    products_detected: (corpus.aggregated?.products || []).slice(0, 20),
    services_detected: (corpus.aggregated?.services || []).slice(0, 20),
    // Social
    social: corpus.aggregated?.social || [],
    // Trazabilidad: de donde salio cada bloque y que tan confiable es. Sin esto,
    // lo inferido y lo verificado entran a la marca como si valieran igual.
    _meta: {
      generado_el: new Date().toISOString(),
      motores: { interpretacion: MODEL, criterio: CLAUDE_MODEL },
      confianza: {
        estrategia: s.confianza || null,
        audiencias: aud.confianza || null,
        reglas:     biz.confianza || null,
      },
      evidencia_estrategia: s.evidencia || [],
      paginas_leidas: (corpus.pages || []).length,
      parrafos_leidos: (corpus.aggregated?.paragraphs || []).length,
    },
  };

  return {
    brand_payload,
    cost_usd: totalUsd,
    cost_by_engine: { openai: usdOpenai, claude: usdClaude },
    tokens_in: totalIn,
    tokens_out: totalOut,
    duration_ms: Date.now() - startedAt,
    batches: Object.fromEntries(Object.entries(batches).map(([k, b]) => [k, {
      ok: b.ok, cost: b.cost_usd, error: b.error, skipped: b.skipped, engine: b.engine || "openai",
    }])),
  };
}
