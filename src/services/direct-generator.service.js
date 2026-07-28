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
// 2026-07-28: pasa a Seedance 2 Fast. El nombre anterior (`sora-2-text-to-video`)
// era correcto pero KIE tiene la interfaz de Sora PAUSADA de su lado, asi que toda
// generacion de video moria en 500 "temporarily paused". El comentario viejo daba
// "seedance-*" por sondeado-y-rechazado: eso valia para el string suelto
// "seedance-2" (vocabulario del dispatcher externo del flow runner, no de KIE); el
// nombre que KIE si reconoce lleva el prefijo del proveedor.
const VIDEO_MODEL  = process.env.KIE_VIDEO_MODEL || "bytedance/seedance-2-fast";
const R2_INGEST_URL = process.env.R2_INGEST_URL;
const R2_INGEST_KEY = process.env.R2_INGEST_KEY;

const IMAGE_ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]);
// Los 6 que KIE declara para Seedance 2 (antes aqui solo habia 3: 4:3, 3:4 y 21:9
// eran validos y se rechazaban por nuestra cuenta).
const VIDEO_ASPECTS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
// Union de lo que KIE ofrece en la familia Seedance 2. La variante `-fast` puede
// no servir las altas: si el proveedor la rechaza, su mensaje sube tal cual a Vera.
// Preferimos eso a bloquear por nuestra cuenta un valor que el modelo si acepta.
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p", "4k"]);
const VIDEO_DUR_MIN = 4;
const VIDEO_DUR_MAX = 15;
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

// Las listas de referencia admiten un solo string suelto por comodidad. Se filtran
// las cadenas vacias (la propia doc de KIE las muestra asi: reference_video_urls:[""])
// pero si NADA queda en pie y el llamador si mando algo, se avisa: una referencia
// que se cae en silencio produce un video que no se parece a lo que Vera pidio.
function _urlList(value, field, max = 5) {
  if (value === undefined || value === null) return null;
  const arr = (Array.isArray(value) ? value : [value]).filter((u) => String(u ?? "").trim() !== "");
  if (!arr.length) return null;
  const urls = arr.filter((u) => typeof u === "string" && /^https?:\/\//.test(u.trim())).map((u) => u.trim());
  if (!urls.length) {
    throw new Error(`${field}: cada referencia debe ser una URL http(s) publica de un archivo ya existente.`);
  }
  return urls.slice(0, max);
}

function _url(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const u = String(value).trim();
  if (!/^https?:\/\//.test(u)) {
    throw new Error(`${field}: debe ser una URL http(s) publica de un archivo ya existente (recibido: ${u.slice(0, 60)}).`);
  }
  return u;
}

function _bool(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field}: debe ser true o false (recibido: ${JSON.stringify(value)}).`);
}

// KIE quiere un NUMERO en segundos, no la cadena "5" que se mandaba antes.
function _duration(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < VIDEO_DUR_MIN || n > VIDEO_DUR_MAX) {
    throw new Error(`duration: debe ser un numero entero de segundos entre ${VIDEO_DUR_MIN} y ${VIDEO_DUR_MAX} (recibido: ${JSON.stringify(value)}).`);
  }
  return n;
}

async function _start({ mediaType, prompt, organizationId, conversationId, aspectRatio, imageInput, resolution, outputFormat, video = {} }) {
  // El prompt de Vera viaja VERBATIM al proveedor: ni se reescribe, ni se enriquece,
  // ni se trunca. Ella es la directora creativa; el motor es el cable.
  prompt = String(prompt ?? "").trim();
  const isVideo = mediaType === "video";
  const que = isVideo ? "el video" : "la imagen";

  if (!prompt) {
    const pieza = isVideo
      ? "el video completo (sujeto, accion, movimiento de camara, ambiente, luz y estilo)"
      : "la imagen completa (sujeto, escena, luz, encuadre, estilo, y el texto exacto si lleva)";
    throw new Error(`Falta "prompt": describe TU MISMA ${pieza}. Ya no hay un modelo intermedio que lo redacte por ti — lo que escribas es lo que se genera.`);
  }
  if (prompt.length < MIN_PROMPT_CHARS) {
    throw new Error(`"prompt" tiene ${prompt.length} caracteres: es muy corto para dirigir ${que}. ${isVideo ? "Describelo" : "Describela"} con detalle.`);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`"prompt" tiene ${prompt.length} caracteres y el maximo es ${MAX_PROMPT_CHARS}. Recortalo tu (no lo trunco yo: te entregaria una pieza distinta de la que pediste).`);
  }

  // createTask (rapido)
  let taskId, timeoutMs;
  if (isVideo) {
    const input = {
      prompt,
      aspect_ratio: _pick(aspectRatio, VIDEO_ASPECTS, "aspect_ratio") || "16:9",
      resolution:   _pick(video.resolution, VIDEO_RESOLUTIONS, "resolution") || "720p",
      duration:     _duration(video.duration) ?? 5,
    };
    // Opcionales: solo se mandan si Vera los puso. Enviar un null o un [] vacio a
    // KIE no es lo mismo que no enviar el campo.
    const firstFrame = _url(video.first_frame_url, "first_frame_url");
    const lastFrame  = _url(video.last_frame_url, "last_frame_url");
    const refImgs    = _urlList(video.reference_image_urls, "reference_image_urls");
    const refVids    = _urlList(video.reference_video_urls, "reference_video_urls");
    const refAudio   = _urlList(video.reference_audio_urls, "reference_audio_urls");
    const genAudio   = _bool(video.generate_audio, "generate_audio");
    const retLast    = _bool(video.return_last_frame, "return_last_frame");
    const webSearch  = _bool(video.web_search, "web_search");
    if (firstFrame) input.first_frame_url = firstFrame;
    if (lastFrame)  input.last_frame_url = lastFrame;
    if (refImgs)    input.reference_image_urls = refImgs;
    if (refVids)    input.reference_video_urls = refVids;
    if (refAudio)   input.reference_audio_urls = refAudio;
    if (genAudio  !== null) input.generate_audio = genAudio;
    if (retLast   !== null) input.return_last_frame = retLast;
    if (webSearch !== null) input.web_search = webSearch;

    taskId = await _createTask(VIDEO_MODEL, input);
    // Seedance 2 Fast promedia ~4 min. Los 5 min de antes dejaban margen para un
    // solo mal minuto: un video que llegaba tarde se reportaba como "no lo pude
    // confirmar" aunque KIE lo hubiera entregado bien.
    timeoutMs = 600_000;
  } else {
    const input = {
      prompt,
      aspect_ratio:  _pick(aspectRatio, IMAGE_ASPECTS, "aspect_ratio") || "1:1",
      resolution:    _pick(resolution, IMAGE_RESOLUTIONS, "resolution") || "2K",
      output_format: _pick(outputFormat, OUTPUT_FORMATS, "output_format") || "png",
    };
    const refs = _urlList(imageInput, "image_input");
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
    video: {
      resolution:           params.resolution,
      duration:             params.duration,
      first_frame_url:      params.first_frame_url,
      last_frame_url:       params.last_frame_url,
      reference_image_urls: params.reference_image_urls,
      reference_video_urls: params.reference_video_urls,
      reference_audio_urls: params.reference_audio_urls,
      generate_audio:       params.generate_audio,
      return_last_frame:    params.return_last_frame,
      web_search:           params.web_search,
    },
  });
}
