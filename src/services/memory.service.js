/**
 * Memory Service — estrategia de contexto para conversaciones largas.
 *
 * Tres capas de memoria:
 *   1. SHORT  → últimos N mensajes (contexto inmediato para OpenClaw)
 *   2. LONG   → resumen comprimido de mensajes más antiguos
 *   3. GOAL   → objetivo detectado en la sesión actual
 *
 * El resumen se guarda como mensaje system con prefijo "MEMORY_SUMMARY <json>"
 * en la misma tabla ai_messages para no necesitar nueva tabla.
 *
 * Umbral de resumen: cuando la conversación supera SUMMARIZE_THRESHOLD mensajes
 * de usuario/asistente se genera (o actualiza) el resumen.
 */
import { supabase } from "../lib/supabase.js";

const SHORT_CONTEXT_SIZE = 10;   // mensajes recientes que OpenClaw ve siempre
const SUMMARIZE_THRESHOLD = 25;  // a partir de cuántos mensajes generar resumen
const RESUMMARY_DELTA = 15;      // re-resumir cuando crecen N mensajes más

// ── Internal helpers ────────────────────────────────────────────────────────

function parseSummary(content) {
  const c = String(content || "");
  if (!c.startsWith("MEMORY_SUMMARY ")) return null;
  try {
    return JSON.parse(c.slice("MEMORY_SUMMARY ".length));
  } catch (_) {
    return null;
  }
}

function extractGoalFromMessages(messages) {
  // Objetivo = última consulta sustancial del usuario (> 10 chars)
  const userMsgs = messages.filter((m) => m.role === "user" && m.content.length > 10);
  if (!userMsgs.length) return null;
  return userMsgs[userMsgs.length - 1].content.slice(0, 300);
}

function buildTopicsList(messages) {
  const topics = new Set();
  for (const m of messages) {
    const t = String(m.content).toLowerCase();
    if (t.includes("campaña") || t.includes("campaign")) topics.add("campañas");
    if (t.includes("product") || t.includes("producto")) topics.add("productos");
    if (t.includes("flow") || t.includes("programa")) topics.add("flows/programación");
    if (t.includes("analiz") || t.includes("estado") || t.includes("rendim")) topics.add("análisis");
    if (t.includes("publicar") || t.includes("postear")) topics.add("publicaciones");
    if (t.includes("integrac") || t.includes("red social")) topics.add("integraciones");
    if (t.includes("competidor") || t.includes("tendencia")) topics.add("inteligencia");
  }
  return [...topics];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Construye el paquete de memoria para pasar a OpenClaw.
 *
 * @param {string} conversationId
 * @returns {{ recent: Message[], summary: string|null, goal: string|null, totalMessages: number }}
 */
export async function buildConversationMemory(conversationId) {
  const { data: allMessages, error } = await supabase
    .from("ai_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error || !allMessages?.length) {
    return { recent: [], summary: null, goal: null, totalMessages: 0 };
  }

  // Separar mensajes reales de mensajes de sistema (TASK_EVENT, MEMORY_SUMMARY)
  const realMessages = allMessages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  // Extraer el último MEMORY_SUMMARY
  const summaryMessages = allMessages.filter(
    (m) => m.role === "system" && String(m.content).startsWith("MEMORY_SUMMARY ")
  );
  const latestSummary = summaryMessages.length
    ? parseSummary(summaryMessages[summaryMessages.length - 1].content)
    : null;

  // Contexto corto (los últimos N mensajes reales)
  const recent = realMessages.slice(-SHORT_CONTEXT_SIZE);

  // Objetivo de la sesión
  const goal = extractGoalFromMessages(recent);

  return {
    recent,
    summary: latestSummary?.text ?? null,
    goal,
    totalMessages: realMessages.length,
  };
}

/**
 * Si la conversación supera el umbral, genera (o actualiza) el resumen
 * y lo guarda como mensaje system en ai_messages.
 *
 * Se debe llamar al FINAL del request (después de guardar la respuesta de Vera),
 * para no bloquear la respuesta al usuario.
 *
 * @param {string} conversationId
 * @param {string|null} organizationId  — puede ser null si la tabla no tiene esa columna
 * @returns {object|null}  resumen generado, o null si no se resumió
 */
export async function maybeSummarize(conversationId, organizationId = null) {
  const { data: allMessages, error } = await supabase
    .from("ai_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error || !allMessages?.length) return null;

  const realMessages = allMessages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  // ¿Hay suficientes mensajes para resumir?
  if (realMessages.length < SUMMARIZE_THRESHOLD) return null;

  // ¿Ya existe un resumen reciente que cubra la mayoría de los mensajes?
  const summaryMessages = allMessages.filter(
    (m) => m.role === "system" && String(m.content).startsWith("MEMORY_SUMMARY ")
  );
  if (summaryMessages.length > 0) {
    const last = parseSummary(summaryMessages[summaryMessages.length - 1].content);
    const coveredCount = last?.covered_count ?? 0;
    if (realMessages.length - coveredCount < RESUMMARY_DELTA) {
      return null; // demasiado reciente para volver a resumir
    }
  }

  // Mensajes a comprimir: todos menos los últimos SHORT_CONTEXT_SIZE
  const toSummarize = realMessages.slice(0, -SHORT_CONTEXT_SIZE);
  if (toSummarize.length < 5) return null;

  const topics = buildTopicsList(toSummarize);
  const userMessages = toSummarize.filter((m) => m.role === "user");
  const assistantMessages = toSummarize.filter((m) => m.role === "assistant");

  // Resumen estructurado (stub hasta conectar OpenClaw como summarizer)
  const summaryText =
    `Resumen de ${toSummarize.length} mensajes anteriores. ` +
    `El usuario discutió: ${topics.join(", ") || "consultas generales"}. ` +
    `Intercambios: ${userMessages.length} del usuario, ${assistantMessages.length} de Vera. ` +
    `Última consulta resumida: "${userMessages.slice(-1)[0]?.content?.slice(0, 100) ?? "—"}".`;

  const payload = {
    text: summaryText,
    covered_count: toSummarize.length,
    covered_through: toSummarize[toSummarize.length - 1]?.created_at,
    topics,
    generated_at: new Date().toISOString(),
  };

  // Insertar en ai_messages como system
  const insertData = {
    conversation_id: conversationId,
    role: "system",
    content: `MEMORY_SUMMARY ${JSON.stringify(payload)}`,
  };
  // Insertar organization_id solo si la columna existe en la tabla
  if (organizationId) insertData.organization_id = organizationId;

  await supabase.from("ai_messages").insert(insertData);

  return payload;
}

/**
 * Formatea la memoria para inyectarla como contexto a OpenClaw.
 * Retorna un string compacto que no expanda el prompt innecesariamente.
 */
export function formatMemoryForContext(memory) {
  const parts = [];

  if (memory.summary) {
    parts.push(`[Resumen de conversación previa]\n${memory.summary}`);
  }

  if (memory.goal) {
    parts.push(`[Objetivo actual del usuario]\n${memory.goal}`);
  }

  if (memory.recent?.length) {
    const formatted = memory.recent
      .map((m) => `${m.role === "user" ? "Usuario" : "Vera"}: ${m.content.slice(0, 200)}`)
      .join("\n");
    parts.push(`[Contexto reciente]\n${formatted}`);
  }

  return parts.join("\n\n");
}
