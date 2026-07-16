/**
 * vision.js — helper unico para analisis de IMAGENES con LLM vision (gpt-4o).
 *
 * Envuelve chatCompletion pasando contenido multimodal (texto + image_url). Uso
 * on-demand / cadencia larga (NO background recurrente): cada llamada gasta tokens,
 * asi que el caller SIEMPRE debe samplear y gatear (maxImages). `detail:"low"`
 * mantiene el costo bajo (~85 tokens/imagen a 512px) y alcanza para paleta/logo/
 * legibilidad; sube a "high" solo si necesitas leer tipografia fina.
 *
 * Devuelve JSON parseado (response_format json_object) + usage para auditar costo.
 */
import { chatCompletion } from "./openai.js";

/**
 * @param {string[]} imageUrls  URLs publicas fetchables (R2 / storage publico).
 * @param {string}   instruction  prompt que DEBE pedir salida JSON.
 * @param {object}   [opts] { model, maxImages, detail, max_tokens }
 * @returns {Promise<{data:object|null, usage:object|null, model:string, images_analyzed:number, skipped?:string}>}
 */
export async function analyzeImagesJSON(imageUrls, instruction, opts = {}) {
  const model = opts.model || "gpt-4o";
  const maxImages = Math.max(1, Math.min(Number(opts.maxImages) || 6, 12));
  const urls = [...new Set((imageUrls || []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u)))].slice(0, maxImages);
  if (!urls.length) return { data: null, usage: null, model, images_analyzed: 0, skipped: "sin imagenes fetchables" };

  const content = [
    { type: "text", text: instruction },
    ...urls.map((u) => ({ type: "image_url", image_url: { url: u, detail: opts.detail || "low" } })),
  ];

  const { content: raw, usage, model: used } = await chatCompletion({
    model,
    messages: [{ role: "user", content }],
    max_tokens: opts.max_tokens || 1500,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  let data = null;
  try { data = JSON.parse(raw); } catch { data = { _parse_error: true, raw: String(raw).slice(0, 800) }; }
  return { data, usage: usage ?? null, model: used ?? model, images_analyzed: urls.length };
}
