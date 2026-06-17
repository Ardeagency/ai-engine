/**
 * Activity Emitter — puente entre el procesamiento en background y el frontend.
 *
 * Guarda mensajes de estado (role = "status") en ai_messages mientras OpenClaw
 * procesa. El frontend los recibe via Supabase Realtime y los muestra como
 * indicadores animados. Al terminar el procesamiento se limpian de la DB.
 *
 * La diferencia clave con "OpenClaw dice que va a hacer algo":
 *   emitActivity() solo se llama cuando ai-engine REALMENTE hace algo
 *   (build context, dispatch tool, save result). Si OpenClaw solo "promete"
 *   pero no emite tool_calls, no aparece ningún status de ejecución.
 */
import { supabase } from "./supabase.js";

// Conversaciones activas: conversationId → organizationId
const _active = new Map();

// Etiquetas legibles para cada herramienta
const TOOL_LABELS = {
  getBrandInfo:              "leyendo datos de marca",
  getBrandPosts:             "consultando publicaciones de la marca",
  getBrandColors:            "consultando paleta de colores",
  getBrandFonts:             "consultando tipografías",
  getBrandRules:             "consultando reglas de marca",
  getAudiences:              "consultando audiencias",
  getProducts:               "consultando productos",
  getCampaigns:              "consultando campañas",
  getAvailableFlows:         "listando flujos disponibles",
  runFlow:                   "ejecutando flujo de automatización",
  getGoogleAnalytics:        "obteniendo métricas de Google Analytics",
  getMetaInsights:           "obteniendo estadísticas de Meta",
  getInstagramPosts:         "consultando posts de Instagram",
  getFacebookPosts:          "consultando posts de Facebook",
  publishPost:               "publicando contenido",
  schedulePost:              "programando publicación",
  createCampaign:            "creando campaña",
  updateCampaign:            "actualizando campaña",
  searchCompetitors:         "analizando competencia",
  generateContent:           "generando contenido",
  getIntegrationTokens:      "verificando accesos de integración",
  webSearch:                 "buscando en internet",
  webFetch:                  "leyendo páginas web",
  getBrandKit:               "leyendo la identidad de marca",
  createArtifact:            "diseñando y generando archivo",
  listArtifacts:             "consultando archivos generados",
};

export function registerConversation(conversationId, organizationId) {
  _active.set(conversationId, organizationId);
}

export function unregisterConversation(conversationId) {
  _active.delete(conversationId);
}

export function isActive(conversationId) {
  return _active.has(conversationId);
}

/**
 * Emite un mensaje de estado visible para el usuario.
 * Solo actúa si la conversación está registrada como activa.
 * Silencia errores — el status es best-effort y nunca bloquea el procesamiento.
 */
export async function emitActivity(conversationId, text, meta = {}) {
  const organizationId = _active.get(conversationId);
  if (!organizationId) return;

  const row = {
    conversation_id: conversationId,
    organization_id: organizationId,
    role: "status",
    content: text,
    metadata: { is_status: true, ...meta },
  };

  const { error } = await supabase.from("ai_messages").insert(row);

  if (error) {
    if (error.code === "42703") {
      // Columna metadata no existe todavía — reintentar sin ella
      delete row.metadata;
      const { error: retryErr } = await supabase.from("ai_messages").insert(row);
      if (retryErr && retryErr.code !== "23514") {
        // 23514 = check constraint — 'status' no está en el enum todavía, ignorar silenciosamente
        console.warn("[activity-emitter] emit error (retry):", retryErr.message);
      }
    } else if (error.code === "23514") {
      // Check constraint — 'status'/'error' no está en el enum todavía.
      // Los status son best-effort, no bloquean el procesamiento.
      // Ejecutar SQL/migrate_v7_ai_messages_metadata.sql para activarlos.
    } else {
      console.warn("[activity-emitter] emit error:", error.message);
    }
  }
}

/**
 * Emite estado de ejecución de una herramienta real.
 * Llamado ÚNICAMENTE por tool.dispatcher.js cuando la herramienta realmente ejecuta.
 */
export async function emitToolActivity(conversationId, toolName) {
  const label = TOOL_LABELS[toolName] || toolName.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  await emitActivity(conversationId, `Ejecutando: ${label}…`, {
    tool_name: toolName,
    status_type: "tool_executing",
  });
}

/**
 * Elimina todos los mensajes de estado de una conversación.
 * Llamado al finalizar el procesamiento (éxito o error).
 */
export async function clearActivities(conversationId) {
  try {
    await supabase
      .from("ai_messages")
      .delete()
      .eq("conversation_id", conversationId)
      .eq("role", "status");
  } catch (e) {
    console.warn("[activity-emitter] clear error:", e.message);
  }
}
