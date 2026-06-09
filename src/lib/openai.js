/**
 * OpenAI client wrapper — entrada unica para chat completions.
 *
 * Reemplaza el patron de `fetch` inline disperso (media-processor, brand-indexer,
 * content-analysis). Mantiene la interfaz pequena: nada de retries automaticos
 * ni cache, solo error handling consistente.
 *
 * Uso:
 *   import { chatCompletion } from "../lib/openai.js";
 *   const { content, usage } = await chatCompletion({
 *     model: "gpt-4o",
 *     messages: [{ role: "system", content: "..." }, { role: "user", content: "..." }],
 *     max_tokens: 4096,
 *   });
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";

export async function chatCompletion({
  model = "gpt-4o",
  messages,
  max_tokens = 4096,
  temperature = 0.7,
  response_format = undefined,
}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no configurada");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages es requerido y no puede estar vacio");
  }

  const body = { model, messages, max_tokens, temperature };
  if (response_format) body.response_format = response_format;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 400);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, usage: data.usage ?? null, model: data.model ?? model };
}

/**
 * Embedding de un texto. Default = text-embedding-3-large @ dimensions=1536,
 * IDENTICO al modelo con que se construyeron ai_brand_vectors y ai_global_vectors
 * (Matryoshka truncation) — OBLIGATORIO que coincida o la similitud coseno es basura.
 * Devuelve el array de floats (length = dimensions).
 */
export async function createEmbedding(text, { model = "text-embedding-3-large", dimensions = 1536, maxChars = 30000 } = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no configurada");
  const input = String(text || "").slice(0, maxChars);
  if (!input) throw new Error("texto vacio para embedding");

  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input, dimensions }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 400);
    throw new Error(`OpenAI embeddings ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const vec = data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("embedding vacio en respuesta OpenAI");
  return vec;
}
