/**
 * direct-generator.service.js
 * Generador DIRECTO de imagen/video via KIE (api.kie.ai), INDEPENDIENTE de los
 * content-flows / dispatcher ComfyUI. Pipeline "muy al punto":
 *   intent -> forgeProductionPrompt (RAG ai_global_vectors + OpenAI) -> KIE createTask
 *   -> [ASYNC] poll recordInfo -> persist R2 -> entrega la media a la conversacion.
 *
 * ASYNC a proposito: el tool DEVUELVE RAPIDO (forge+createTask ~7s) para no
 * exceder el timeout del cliente MCP (error -32001). Un poll de fondo entrega la
 * imagen a la conversacion (insert ai_messages) cuando el resultado REAL existe.
 * "Generando" es HONESTO porque hay un task KIE real detras (task_id devuelto).
 *
 * LIMITACION v1: el poll vive en memoria del proceso — si ai-engine reinicia a
 * mitad de una generacion, ese poll se pierde (el task KIE igual termina, pero no
 * se entrega). Upgrade pendiente: tabla durable direct_generations + poller cron.
 */
import { supabase } from "../lib/supabase.js";
import { forgeProductionPrompt } from "../tools/prompt-forge.tools.js";

const KIE_BASE     = (process.env.KIE_API_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");
const CREATE_PATH  = "/api/v1/jobs/createTask";
const RECORD_PATH  = "/api/v1/jobs/recordInfo";
const IMAGE_MODEL  = process.env.KIE_IMAGE_MODEL || "nano-banana-pro";
const VIDEO_MODEL  = process.env.KIE_VIDEO_MODEL || "bytedance/seedance-v1-pro"; // TODO verificar string exacto (kie.ai/market) antes de habilitar video
const R2_INGEST_URL = process.env.R2_INGEST_URL;
const R2_INGEST_KEY = process.env.R2_INGEST_KEY;

const IMAGE_ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]);
const VIDEO_ASPECTS = new Set(["16:9", "9:16", "1:1"]);

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
    const msg = data?.msg || data?.message || data?.error ||
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
  const label = String(intent || "").slice(0, 80) || (mediaType === "video" ? "video" : "imagen");
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

async function _start({ mediaType, intent, brandContainerId, organizationId, conversationId, aspectRatio, imageInput }) {
  intent = String(intent || "").trim();
  if (!intent) throw new Error("Falta la descripcion de que generar");
  const isVideo = mediaType === "video";

  // 1. Prompt profesional (RAG ai_global_vectors + OpenAI)
  let prompt = intent;
  try {
    const forged = await forgeProductionPrompt({ intent, productionType: isVideo ? "video" : "image" }, brandContainerId, organizationId);
    prompt = forged?.prompt || forged?.forged_prompt || forged?.production_prompt || forged?.text ||
             (typeof forged === "string" ? forged : intent);
  } catch (e) { console.warn(`direct-generator: forge fail-open -> ${e.message}`); }
  prompt = String(prompt).slice(0, 2500);

  // 2. createTask (rapido)
  let taskId, timeoutMs;
  if (isVideo) {
    const ar = VIDEO_ASPECTS.has(aspectRatio) ? aspectRatio : "16:9";
    taskId = await _createTask(VIDEO_MODEL, { prompt, aspect_ratio: ar, duration: "5" });
    timeoutMs = 300_000;
  } else {
    const ar = IMAGE_ASPECTS.has(aspectRatio) ? aspectRatio : "1:1";
    const input = { prompt, aspect_ratio: ar, resolution: "2K", output_format: "png" };
    if (Array.isArray(imageInput) && imageInput.length) {
      input.image_input = imageInput.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 5);
    }
    taskId = await _createTask(IMAGE_MODEL, input);
    timeoutMs = 200_000;
  }

  // 3. Dispara el poll de fondo (no bloquea el retorno del tool)
  setImmediate(() => {
    _pollAndDeliver({ taskId, timeoutMs, conversationId, organizationId, mediaType, intent })
      .catch((e) => console.warn(`direct-generator: poll fallo task=${taskId} — ${e.message}`));
  });

  // 4. Retorno RAPIDO (task real ya existe -> "generando" es honesto)
  return {
    ok: true,
    status: "generating",
    task_id: taskId,
    media_type: isVideo ? "video" : "image",
    prompt_used: prompt.slice(0, 400),
    note: `Generacion REAL iniciada (task ${taskId}). Dile al usuario en 1 linea que la estas generando y que aparecera aqui en la conversacion en ~60-90s. NO afirmes que ya esta lista ni inventes una URL: el sistema la entrega solo cuando el archivo REAL existe.`,
  };
}

export function generateImageDirect(params = {}, brandContainerId, organizationId, conversationId) {
  return _start({
    mediaType: "image",
    intent: params.intent || params.description || params.prompt,
    brandContainerId, organizationId, conversationId,
    aspectRatio: params.aspect_ratio,
    imageInput: params.image_input,
  });
}

export function generateVideoDirect(params = {}, brandContainerId, organizationId, conversationId) {
  return _start({
    mediaType: "video",
    intent: params.intent || params.description || params.prompt,
    brandContainerId, organizationId, conversationId,
    aspectRatio: params.aspect_ratio,
  });
}
