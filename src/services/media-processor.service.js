/**
 * media-processor.service.js — el pasamanos de adjuntos.
 *
 * QUE HABIA ANTES (138 lineas, siete micro-lectores): ai-engine descargaba cada
 * adjunto y lo LEIA por su cuenta — imagenes a OpenAI gpt-4o, PDFs, audio, Word,
 * hojas de calculo, texto— y le pasaba a Vera un resumen en texto plano. O sea:
 * pagabamos por ver y por leer, y ella recibia el resumen de otro en vez del
 * archivo.
 *
 * POR QUE SE FUE: OpenClaw trae los lectores. Media understanding esta ENCENDIDO
 * POR DEFECTO (imagen, video y audio con cascada de proveedores: Anthropic,
 * Google, OpenAI, Deepgram, Groq, Qwen), mas los plugins Document Extract y Web
 * Readability. Probado el 2026-07-28 que Vera ve una imagen desde su URL en 28s
 * y la describe bien. Reconstruir eso aqui era una version cara y peor.
 *
 * QUE HACE AHORA: entrega el manifiesto —nombre, tipo y enlace— y se aparta.
 * Quien lee es ella.
 *
 * Ver doctrina: ai-engine es el conector, no el motor.
 */

/** Etiqueta legible del tipo, para que sepa que esta abriendo antes de abrirlo. */
function _comoSeLlama(tipo) {
  const t = String(tipo || "").toLowerCase();
  return {
    image: "imagen",
    pdf: "PDF",
    audio: "audio",
    video: "video",
    word: "documento Word",
    spreadsheet: "hoja de calculo",
    text: "texto",
  }[t] || (t || "archivo");
}

/**
 * Construye el manifiesto de adjuntos que se inyecta en el mensaje.
 *
 * No descarga, no describe, no transcribe: da el enlace y dice que es. Si un
 * adjunto llega sin URL se dice, porque un adjunto que no se puede abrir es un
 * hueco y no puede parecer un archivo vacio.
 *
 * @param {Array<{url?:string,name?:string,type?:string,mime?:string}>} attachments
 * @returns {Promise<string>} texto para el bloque de adjuntos
 */
export async function processAttachments(attachments) {
  if (!attachments?.length) return "";

  const lineas = attachments.map((att, i) => {
    const nombre = att?.name || `adjunto ${i + 1}`;
    const tipo = _comoSeLlama(att?.type || att?.mime);
    if (!att?.url) {
      return `${i + 1}. ${nombre} (${tipo}) — SIN ENLACE: no se puede abrir. Dilo asi, no supongas que venia vacio.`;
    }
    return `${i + 1}. ${nombre} (${tipo}) → ${att.url}`;
  });

  return [
    "Estos archivos los adjuntó la persona con la que hablas. ÁBRELOS TÚ:",
    "",
    ...lineas,
    "",
    "Míralos o léelos con tus propias herramientas antes de responder sobre ellos.",
    "Opinar de un archivo que no abriste es inventar con buena redacción.",
  ].join("\n");
}
