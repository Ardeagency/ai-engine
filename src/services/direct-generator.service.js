/**
 * direct-generator.service.js
 * Generador DIRECTO de imagen/video via KIE (api.kie.ai), INDEPENDIENTE de los
 * content-flows / dispatcher ComfyUI. Pipeline "muy al punto":
 *   prompt de Vera -> KIE createTask
 *   -> [ASYNC] poll recordInfo -> persist R2 -> entrega la media a la conversacion.
 *
 * SIN LLM INTERMEDIO (2026-07-28). Antes, entre Vera y KIE habia un segundo
 * modelo: `forgeProductionPrompt` (RAG sobre ai_global_vectors + OpenAI) reescribia
 * su descripcion y ESE texto —no el suyo— era el que llegaba al generador. Vera
 * escribia una intencion y recibia una imagen de un prompt que nunca vio: no podia
 * corregir el encuadre, ni fijar un detalle, ni saber por que salio distinta.
 * Ahora ai-engine le pasa el ESQUEMA de KIE y ella lo llena: su `prompt` viaja
 * VERBATIM al proveedor. El motor solo valida y transporta.
 *
 * ASYNC a proposito: el tool DEVUELVE RAPIDO (createTask ~2-4s) para no exceder
 * el timeout del cliente MCP (error -32001). Un poll de fondo entrega la imagen a
 * la conversacion (insert ai_messages) cuando el resultado REAL existe.
 * "Generando" es HONESTO porque hay un task KIE real detras (task_id devuelto).
 *
 * LIMITACION v1: el poll vive en memoria del proceso — si ai-engine reinicia a
 * mitad de una generacion, ese poll se pierde (el task KIE igual termina, pero no
 * se entrega). Upgrade pendiente: tabla durable direct_generations + poller cron.
 */
import { supabase } from "../lib/supabase.js";

const KIE_BASE     = (process.env.KIE_API_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");
const CREATE_PATH  = "/api/v1/jobs/createTask";
const RECORD_PATH  = "/api/v1/jobs/recordInfo";
const IMAGE_MODEL  = process.env.KIE_IMAGE_MODEL || "nano-banana-pro";
// El unico nombre de video que /jobs/createTask reconoce hoy. Sondeados y rechazados:
// veo3*, kling-*, seedance-* (incluido "seedance-2", que es vocabulario del dispatcher
// externo del flow runner, no de KIE), wan, hailuo, runway. Veo3 existe pero en otra
// ruta (/veo3-api/...) que _createTask no habla. OJO: KIE tiene la interfaz de Sora
// PAUSADA de su lado — el nombre es correcto y aun asi devuelve 500 "temporarily paused".
const VIDEO_MODEL  = process.env.KIE_VIDEO_MODEL || "sora-2-text-to-video";
const R2_INGEST_URL = process.env.R2_INGEST_URL;
const R2_INGEST_KEY = process.env.R2_INGEST_KEY;

const IMAGE_ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]);
const VIDEO_ASPECTS = new Set(["16:9", "9:16", "1:1"]);
// Valores que acepta `input` de nano-banana-pro. Antes estaban CLAVADOS en el
// codigo (2K/png): Vera no tenia como pedir otra cosa aunque el modelo la ofrezca.
const IMAGE_RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const OUTPUT_FORMATS    = new Set(["png", "jpg"]);
// Tope del proveedor para el texto del prompt. Se RECHAZA al pasarse en vez de
// truncar en silencio: un prompt cortado a la mitad produce una imagen que no es
// la que Vera pidio, y ella no tendria como enterarse.
const MAX_PROMPT_CHARS  = 5000;
const MIN_PROMPT_CHARS  = 10;

function _headers() {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY no configurada en ai-engine");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function _acquireKieSlot(maxWaitMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const { data, error } = await supabase.rpc("kie_rate_acquire", { p_provider: "kie", p_cost: 1 });
      const ok = data === true || data?.acquired === true || (Array.isArray(data) && data[0]?.acquired === true);
      if (error || ok) return true; // fail-open
    } catch (_) { return true; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return true;
}

async function _createTask(model, input) {
  await _acquireKieSlot();
  const res = await fetch(`${KIE_BASE}${CREATE_PATH}`, {
    method: "POST", headers: _headers(), body: JSON.stringify({ model, input }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 200)) {
    const crudo = String(data?.msg || data?.message || data?.error || "");
    // Un mensaje de proveedor no le sirve a nadie: se traduce a lo que hay que
    // hacer. "paused" es KIE apagando ese modelo de su lado, no un fallo nuestro.
    const msg = /temporarily paused/i.test(crudo)
        ? `${model}: el proveedor tiene ese modelo pausado ahora mismo. No es un fallo de la marca ni del prompt; no hay nada que reintentar hasta que KIE lo reactive.`
      : /not supported/i.test(crudo)
        ? `${model}: KIE no reconoce ese nombre de modelo (revisa KIE_VIDEO_MODEL / KIE_IMAGE_MODEL).`
      : crudo ||
        (res.status === 401 ? "KIE_API_KEY invalida" : res.status === 402 ? "Saldo KIE insuficiente" : `KIE createTask ${res.status}`);
    throw new Error(msg);
  }
  const taskId = data?.data?.taskId || data?.taskId;
  if (!taskId) throw new Error("KIE no devolvio taskId");
  return taskId;
}

function _extractUrls(d) {
  try {
    if (typeof d.resultJson === "string" && d.resultJson.trim()) {
      const p = JSON.parse(d.resultJson);
      const urls = p.resultUrls || p.urls || [];
      return (urls || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    }
  } catch (_) { /* fallthrough */ }
  const alt = d.resultUrls || d.response?.resultUrls || [];
  return (alt || []).filter((u) => typeof u === "string" && u.startsWith("http"));
}

async function _persistR2(sourceUrl, path) {
  if (!R2_INGEST_URL || !R2_INGEST_KEY) return sourceUrl;
  try {
    const res = await fetch(`${R2_INGEST_URL}/url`, {
      method: "POST",
      headers: { "x-ingest-key": R2_INGEST_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: sourceUrl, path }),
    });
    if (res.ok) { const j = await res.json().catch(() => ({})); if (j.url) return j.url; }
  } catch (_) { /* fail-open */ }
  return sourceUrl;
}

async function _deliver(conversationId, organizationId, content) {
  if (!conversationId) { console.warn("direct-generator: sin conversationId, no se entrega"); return; }
  try {
    await supabase.from("ai_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content,
      organization_id: organizationId,
    });
  } catch (e) {
    console.warn(`direct-generator: entrega a conversacion fallo — ${e.message}`);
  }
}

// Poll de fondo: espera el resultado REAL, persiste a R2 y lo entrega a la conversacion.
async function _pollAndDeliver({ taskId, timeoutMs, conversationId, organizationId, mediaType, intent }) {
  const start = Date.now();
  // Con el prompt escrito por Vera (largo y detallado) un slice crudo cortaba a
  // mitad de palabra en pleno mensaje al usuario. Se corta en el ultimo espacio.
  const crudo = String(intent || "").replace(/\s+/g, " ").trim();
  const corto = crudo.length > 80 ? crudo.slice(0, 80).replace(/\s+\S*$/, "") + "…" : crudo;
  const label = corto || (mediaType === "video" ? "video" : "imagen");
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    let d = {};
    try {
      const res = await fetch(`${KIE_BASE}${RECORD_PATH}?taskId=${encodeURIComponent(taskId)}`, { headers: _headers() });
      d = (await res.json().catch(() => ({})))?.data || {};
    } catch (_) { continue; }
    let state = d.state || d.status || "";
    if (state === "failed") state = "fail";

    if (state === "success") {
      const urls = _extractUrls(d);
      if (!urls.length) { await _deliver(conversationId, organizationId, `No pude generar ${label}: KIE reporto exito pero sin archivo. Reintenta.`); return; }
      const ext = mediaType === "video" ? "mp4" : "png";
      const mediaUrl = await _persistR2(urls[0], `direct-gen/${organizationId || "org"}/${taskId}.${ext}`);
      const credits = Number(d.creditsConsumed || 0);
      console.log(`direct-generator: ${mediaType} entregado org=${organizationId} task=${taskId} kieCredits=${credits} url=${mediaUrl}`);
      const body = mediaType === "video"
        ? `Aquí está tu video:\n\n[▶ Ver video](${mediaUrl})\n\n${mediaUrl}`
        : `Aquí está tu imagen:\n\n![${label}](${mediaUrl})`;
      await _deliver(conversationId, organizationId, body);
      return;
    }
    if (state === "fail") {
      await _deliver(conversationId, organizationId, `No pude generar ${label}. KIE reporto un fallo: ${d.failMsg || `code ${d.failCode}`}. Puedes pedirme que lo intente de nuevo.`);
      return;
    }
  }
  await _deliver(conversationId, organizationId, `La generación de ${label} está tardando más de lo normal y no la pude confirmar. Pídeme que lo reintente.`);
}

// Un valor fuera de la lista se RECHAZA con las opciones al lado, en vez de caer
// a un default silencioso: si Vera pide 4:5 y el motor le entrega 1:1 sin decirlo,
// ella cree que el modelo no respeta el encuadre y reintenta contra un fantasma.
function _pick(value, allowed, field) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value).trim();
  if (!allowed.has(v)) {
    throw new Error(`${field}: "${v}" no es un valor valido. Opciones: ${[...allowed].join(" | ")}`);
  }
  return v;
}

function _cleanImageInput(imageInput) {
  if (imageInput === undefined || imageInput === null) return null;
  const arr = Array.isArray(imageInput) ? imageInput : [imageInput];
  const urls = arr.filter((u) => typeof u === "string" && /^https?:\/\//.test(u.trim())).map((u) => u.trim());
  if (arr.length && !urls.length) {
    throw new Error("image_input: cada referencia debe ser una URL http(s) publica de una imagen ya existente.");
  }
  return urls.length ? urls.slice(0, 5) : null;
}

async function _start({ mediaType, prompt, organizationId, conversationId, aspectRatio, imageInput, resolution, outputFormat }) {
  // El prompt de Vera viaja VERBATIM al proveedor: ni se reescribe, ni se enriquece,
  // ni se trunca. Ella es la directora creativa; el motor es el cable.
  prompt = String(prompt ?? "").trim();
  const isVideo = mediaType === "video";
  const que = isVideo ? "el video" : "la imagen";

  if (!prompt) {
    throw new Error(`Falta "prompt": describe TU MISMA ${que} completa (sujeto, escena, luz, encuadre, estilo, texto si lleva). Ya no hay un modelo intermedio que lo redacte por ti — lo que escribas es lo que se genera.`);
  }
  if (prompt.length < MIN_PROMPT_CHARS) {
    throw new Error(`"prompt" tiene ${prompt.length} caracteres: es muy corto para dirigir ${que}. Describela con detalle.`);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`"prompt" tiene ${prompt.length} caracteres y el maximo es ${MAX_PROMPT_CHARS}. Recortalo tu (no lo trunco yo: te entregaria una pieza distinta de la que pediste).`);
  }

  // createTask (rapido)
  let taskId, timeoutMs;
  if (isVideo) {
    const input = { prompt, aspect_ratio: _pick(aspectRatio, VIDEO_ASPECTS, "aspect_ratio") || "16:9", duration: "5" };
    taskId = await _createTask(VIDEO_MODEL, input);
    timeoutMs = 300_000;
  } else {
    const input = {
      prompt,
      aspect_ratio:  _pick(aspectRatio, IMAGE_ASPECTS, "aspect_ratio") || "1:1",
      resolution:    _pick(resolution, IMAGE_RESOLUTIONS, "resolution") || "2K",
      output_format: _pick(outputFormat, OUTPUT_FORMATS, "output_format") || "png",
    };
    const refs = _cleanImageInput(imageInput);
    if (refs) input.image_input = refs;
    taskId = await _createTask(IMAGE_MODEL, input);
    timeoutMs = 200_000;
  }

  // Dispara el poll de fondo (no bloquea el retorno del tool)
  setImmediate(() => {
    _pollAndDeliver({ taskId, timeoutMs, conversationId, organizationId, mediaType, intent: prompt })
      .catch((e) => console.warn(`direct-generator: poll fallo task=${taskId} — ${e.message}`));
  });

  // Retorno RAPIDO (task real ya existe -> "generando" es honesto)
  return {
    ok: true,
    status: "generating",
    task_id: taskId,
    media_type: isVideo ? "video" : "image",
    prompt_sent: prompt,
    note: `Generacion REAL iniciada (task ${taskId}) con TU prompt tal cual, sin reescribir. Dile al usuario en 1 linea que la estas generando y que aparecera aqui en la conversacion en ~60-90s. NO afirmes que ya esta lista ni inventes una URL: el sistema la entrega solo cuando el archivo REAL existe.`,
  };
}

// `intent`/`description` se siguen aceptando como alias de `prompt` para no romper
// una llamada vieja en vuelo, pero ya NO significan "una idea que otro redactara":
// lo que llegue por cualquiera de los tres nombres se manda al proveedor tal cual.
export function generateImageDirect(params = {}, brandContainerId, organizationId, conversationId) {
  return _start({
    mediaType: "image",
    prompt: params.prompt ?? params.intent ?? params.description,
    organizationId, conversationId,
    aspectRatio:  params.aspect_ratio,
    imageInput:   params.image_input,
    resolution:   params.resolution,
    outputFormat: params.output_format,
  });
}

export function generateVideoDirect(params = {}, brandContainerId, organizationId, conversationId) {
  return _start({
    mediaType: "video",
    prompt: params.prompt ?? params.intent ?? params.description,
    organizationId, conversationId,
    aspectRatio: params.aspect_ratio,
  });
}
