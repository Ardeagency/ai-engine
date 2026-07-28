/**
 * anthropic.js — Cliente de Claude para respuestas estructuradas.
 *
 * Espejo de lib/openai.js: entrada unica, sin retries automaticos ni cache.
 * Sigue el patron que ya usa enrichment.populator.js (fetch directo a la API,
 * sin SDK) para no sumar dependencias al server.
 *
 * Por que Claude y no OpenAI en algunos batches del brand-consolidator: OpenAI
 * lee mejor lo interpretativo (el alma de la marca en su copy y sus imagenes);
 * Claude sostiene mejor una instruccion larga con reglas duras y un esquema
 * exigente (taxonomias cerradas, audiencias con dolores/objeciones/gatillos,
 * extraccion literal sin inventar). Cada batch usa el motor que le conviene.
 *
 * Uso:
 *   import { claudeJson } from "../lib/anthropic.js";
 *   const { data, usage, cost_usd } = await claudeJson({
 *     system: "...", user: "...", schema: { ... }, maxTokens: 8000,
 *   });
 */

const ANTHROPIC_URL     = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const CLAUDE_MODEL = "claude-opus-4-8";

// Precios por millon de tokens (Opus 4.8).
const INPUT_USD_PER_M  = 5;
const OUTPUT_USD_PER_M = 25;

export function claudeCost(usage) {
  const tin  = usage?.input_tokens  || 0;
  const tout = usage?.output_tokens || 0;
  return {
    tokens_in:  tin,
    tokens_out: tout,
    cost_usd:   (tin * INPUT_USD_PER_M + tout * OUTPUT_USD_PER_M) / 1_000_000,
  };
}

/**
 * Pide a Claude una respuesta que cumpla un JSON Schema.
 *
 * @param {object}   args
 * @param {string}   args.system     - prompt de sistema
 * @param {string|Array} args.user   - texto o bloques de contenido (permite imagenes)
 * @param {object}   args.schema     - JSON Schema; todos los objetos con additionalProperties:false
 * @param {number}   [args.maxTokens=8000]
 * @param {string}   [args.effort="high"] - low | medium | high | xhigh | max
 * @param {string}   [args.model]
 * @returns {Promise<{ data: object, usage: object, tokens_in: number, tokens_out: number, cost_usd: number }>}
 */
export async function claudeJson({ system, user, schema, maxTokens = 8000, effort = "high", model = CLAUDE_MODEL }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");
  if (!schema) throw new Error("claudeJson requiere schema");

  const res = await fetch(ANTHROPIC_URL, {
    method:  "POST",
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      // Pensamiento adaptativo: Claude decide cuanto razonar por tarea.
      thinking:      { type: "adaptive" },
      output_config: { effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`);
  }

  const json = await res.json();

  // Puede declinar la peticion: hay que mirar stop_reason antes que el contenido.
  if (json?.stop_reason === "refusal") {
    throw new Error(`Anthropic declino la peticion (${json?.stop_details?.category || "sin categoria"})`);
  }

  // El bloque de texto trae el JSON; los bloques de pensamiento se ignoran.
  const text = (json?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("Anthropic devolvio una respuesta vacia");

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Anthropic devolvio JSON invalido: ${text.slice(0, 200)}`); }

  return { data, usage: json.usage, ...claudeCost(json.usage) };
}
