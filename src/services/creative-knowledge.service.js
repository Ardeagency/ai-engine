/**
 * Creative Knowledge Retriever — RAG sobre ai_global_vectors (creative_knowledge).
 *
 * Inyecta el conocimiento de direccion de arte CURADO de ARDE en la resolucion de
 * prompts (FEAT-034) para que las producciones NO dependan al 100% del prompt de
 * ejemplo (golden): cada run recupera patrones REALES (composicion / luz / color),
 * los principios del metodo ARDE y los anti-patrones, y ROTA entre los top-K mas
 * relevantes para dar VARIEDAD profesional sin perder consistencia.
 *
 * Embedding: text-embedding-3-large @ dims=1536 (mismo modelo que construyo el vector).
 * Tabla: ai_global_vectors (source_bucket=creative_knowledge). RPC: match_ai_global_vectors
 * (filtra por source_type, devuelve content + metadata + similarity).
 *
 * Fail-open: si cualquier paso falla, devuelve bloque vacio -> el resolver sigue
 * exactamente como antes (golden template puro). Nunca peor que hoy.
 * Ver [[project-prompts-dinamicos-agente]] + [[feedback-brand-spec-no-dump]] + [[feedback-embeddings-sancionados]].
 */
import { createClient } from "@supabase/supabase-js";
import { createEmbedding } from "../lib/openai.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

// Ejes de conocimiento a recuperar por similitud: { source_type, cuantos inyectar, top-pool del que se elige }.
// Se elige `take` al azar entre los `pool` mas relevantes -> variedad sobre lo profesional.
// IMAGEN: CAMERA se omite (en el golden template el bloque CAMERA queda frozen, el LLM no lo escribe).
const AXES_IMAGE = [
  { type: "composition_pattern", take: 2, pool: 5 },
  { type: "lighting_preset",     take: 1, pool: 3 },
  { type: "color_palette",       take: 1, pool: 3 },
  { type: "anti_pattern",        take: 1, pool: 3 },
];
// VIDEO (i2v): la escena/luz/color YA estan horneadas en el frame producido; lo que aporta es
// el MOVIMIENTO -> aqui SI sirve camera_setup (encuadre/movimiento de camara) + composicion (lectura del plano).
const AXES_VIDEO = [
  { type: "camera_setup",        take: 2, pool: 5 },
  { type: "composition_pattern", take: 1, pool: 4 },
  { type: "anti_pattern",        take: 1, pool: 3 },
];
function axesFor(productionType) {
  return productionType === "video" ? AXES_VIDEO : AXES_IMAGE;
}

// Principios del metodo ARDE: SIEMPRE inyectados (no por similitud — son anclas universales de calidad).
const METHOD_TYPE = "arde_method_principle";
const METHOD_COUNT = 2;

const _embedCache = new Map(); // intentKey -> vector (cache in-process)

// Elige n elementos al azar de los primeros `pool` de un array ya ordenado por relevancia.
function sampleTop(arr, n, pool) {
  const head = arr.slice(0, Math.min(pool, arr.length));
  const out = [];
  while (out.length < n && head.length) {
    out.push(head.splice(Math.floor(Math.random() * head.length), 1)[0]);
  }
  return out;
}

// Construye el texto de intencion que se embebe para buscar conocimiento relevante.
// El corpus de ai_global_vectors esta en INGLES -> framing en ingles mejora la
// precision del match coseno (los datos de producto del tenant van como detalle).
function buildIntentQuery(ctx = {}) {
  const p = ctx.product || {};
  const bits = [
    p.nombre_producto || p.name || p.product_name || "",
    p.categoria || p.category || p.tipo || "",
    p.descripcion || p.description || "",
    ctx.brandBrief || "",
    ctx.hardConstraints || "",
    ctx.userDirection?.escenario || "",
    ctx.userDirection?.movimiento_video || "",
  ].filter(Boolean).join(". ");
  const head = ctx.productionType === "video"
    ? "Professional commercial product video direction: camera movement, framing, pacing and motion for a hero product shot."
    : "Professional commercial product photography art direction: composition, lighting, color palette, mood and styling.";
  return `${head} Product details: ${bits}`.slice(0, 1500);
}

async function matchByType(qv, source_type, count) {
  const { data, error } = await supabase.rpc("match_ai_global_vectors", {
    query_embedding: qv,
    match_count: count,
    filter: { source_type },
  });
  if (error || !Array.isArray(data)) {
    if (error) console.warn(`creative-knowledge: match ${source_type} -> ${error.message}`);
    return [];
  }
  return data;
}

/**
 * Recupera un bloque de conocimiento curado listo para inyectar en el prompt del LLM.
 * @param {object} ctx { product, brandBrief, hardConstraints }
 * @returns {Promise<{block:string, used:Array<{type,trend,similarity}>}>}
 */
export async function retrieveCreativeKnowledge(ctx = {}) {
  try {
    const query = buildIntentQuery(ctx);
    const cacheKey = query.slice(0, 400);
    let qv = _embedCache.get(cacheKey);
    if (!qv) {
      qv = await createEmbedding(query);
      _embedCache.set(cacheKey, qv);
    }

    const axisResults = await Promise.all(
      axesFor(ctx.productionType).map(async (ax) => {
        const rows = await matchByType(qv, ax.type, ax.pool);
        return sampleTop(rows, ax.take, ax.pool).map((r) => ({ ...r, _type: ax.type }));
      })
    );
    const methodRows = (await matchByType(qv, METHOD_TYPE, METHOD_COUNT)).map((r) => ({ ...r, _type: METHOD_TYPE }));

    const chosen = [...axisResults.flat(), ...methodRows].filter((r) => r && r.content);
    if (!chosen.length) return { block: "", used: [] };

    const block = chosen
      .map((r) => `[${(r._type || "").replace(/_/g, " ").toUpperCase()}] ${String(r.content).trim()}`)
      .join("\n\n");

    const used = chosen.map((r) => ({
      type: r._type,
      trend: r.metadata?.trend_category || null,
      similarity: typeof r.similarity === "number" ? Number(r.similarity.toFixed(3)) : null,
    }));

    return { block, used };
  } catch (e) {
    console.warn(`creative-knowledge: retrieval fallback (${e.message})`);
    return { block: "", used: [] };
  }
}
