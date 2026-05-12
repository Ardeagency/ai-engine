import { createRequire } from "module";
const require = createRequire(import.meta.url);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_PDF_CHARS    = 4_000;
const MAX_IMG_DESC     = 1_500;
const MAX_DOC_CHARS    = 6_000;
const MAX_SHEET_ROWS   = 100;
const MAX_TEXT_CHARS   = 6_000;

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error descargando archivo (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? t.slice(0, max) + `\n[... ${t.length - max} caracteres omitidos]` : t;
}

async function processImage({ url, name }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe detalladamente esta imagen en español. Incluye objetos, personas, texto visible, colores y contexto. Sé específico y útil para quien la adjuntó en una conversación." },
          { type: "image_url", image_url: { url, detail: "high" } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Vision API error: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const description = (json.choices?.[0]?.message?.content || "Sin descripción disponible.").slice(0, MAX_IMG_DESC);
  return `[IMAGEN ADJUNTA: ${name || "imagen"}]\n${description}`;
}

async function processPDF({ url, name }) {
  let pdfParse;
  try { pdfParse = require("pdf-parse"); }
  catch (_) { return `[PDF ADJUNTO: ${name || "documento.pdf"}]\nNo se pudo extraer texto (módulo pdf-parse no disponible).`; }
  const buffer = await downloadBuffer(url);
  const data = await pdfParse(buffer);
  const text = (data.text || "").replace(/\s+/g, " ").trim();
  if (!text) return `[PDF ADJUNTO: ${name || "documento.pdf"} — ${data.numpages ?? "?"} páginas]\nEl PDF no contiene texto extraíble (puede ser escaneado).`;
  return `[PDF ADJUNTO: ${name || "documento.pdf"} — ${data.numpages ?? "?"} páginas]\n${truncate(text, MAX_PDF_CHARS)}`;
}

async function processAudio({ url, name, mime }) {
  const filename = name || "audio.mp3";
  const mimeType = mime || "audio/mpeg";
  const buffer = await downloadBuffer(url);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("model", "whisper-1");
  formData.append("language", "es");
  formData.append("response_format", "text");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Whisper API error: ${(await res.text()).slice(0, 200)}`);
  const transcription = (await res.text()).trim();
  return `[AUDIO ADJUNTO: ${filename}]\nTranscripción:\n${transcription}`;
}

function processVideo({ url, name }) {
  return `[VIDEO ADJUNTO: ${name || "video"}]\nURL: ${url}\nEl usuario ha adjuntado este video. Reconócelo en tu respuesta aunque no puedas reproducirlo directamente.`;
}

async function processWord({ url, name }) {
  let mammoth;
  try { mammoth = require("mammoth"); }
  catch (_) { return `[WORD ADJUNTO: ${name || "documento.docx"}]\nNo se pudo extraer texto (módulo mammoth no disponible).`; }
  const buffer = await downloadBuffer(url);
  const result = await mammoth.extractRawText({ buffer });
  const text = (result?.value || "").trim();
  if (!text) return `[WORD ADJUNTO: ${name || "documento.docx"}]\nEl documento no contiene texto extraíble.`;
  return `[WORD ADJUNTO: ${name || "documento.docx"}]\n${truncate(text, MAX_DOC_CHARS)}`;
}

async function processSpreadsheet({ url, name }) {
  let xlsx;
  try { xlsx = require("xlsx"); }
  catch (_) { return `[HOJA DE CÁLCULO ADJUNTA: ${name || "archivo"}]\nNo se pudo procesar (módulo xlsx no disponible).`; }
  const buffer = await downloadBuffer(url);
  const wb = xlsx.read(buffer, { type: "buffer" });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
    const rows = csv.split("\n");
    const truncated = rows.length > MAX_SHEET_ROWS
      ? rows.slice(0, MAX_SHEET_ROWS).join("\n") + `\n[... ${rows.length - MAX_SHEET_ROWS} filas omitidas]`
      : rows.join("\n");
    parts.push(`--- Hoja: ${sheetName} ---\n${truncated}`);
  }
  return `[HOJA DE CÁLCULO ADJUNTA: ${name || "archivo"}]\n${parts.join("\n\n")}`;
}

async function processText({ url, name }) {
  const buffer = await downloadBuffer(url);
  const text = buffer.toString("utf-8").trim();
  if (!text) return `[ARCHIVO DE TEXTO ADJUNTO: ${name || "archivo"}]\nVacío.`;
  return `[ARCHIVO DE TEXTO ADJUNTO: ${name || "archivo"}]\n${truncate(text, MAX_TEXT_CHARS)}`;
}

export async function processAttachments(attachments) {
  if (!attachments?.length) return "";
  const results = await Promise.allSettled(
    attachments.map(async (att) => {
      const type = String(att.type || "").toLowerCase();
      if (type === "image")        return processImage(att);
      if (type === "pdf")          return processPDF(att);
      if (type === "audio")        return processAudio(att);
      if (type === "video")        return processVideo(att);
      if (type === "word")         return processWord(att);
      if (type === "spreadsheet")  return processSpreadsheet(att);
      if (type === "text")         return processText(att);
      return `[ARCHIVO ADJUNTO: ${att.name || att.url}]`;
    })
  );
  return results
    .map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const att = attachments[i];
      console.error(`media-processor: error en "${att?.name}":`, r.reason?.message);
      return `[ARCHIVO ADJUNTO: ${att?.name || att?.url}]\nNo se pudo procesar: ${r.reason?.message}`;
    })
    .join("\n\n");
}
