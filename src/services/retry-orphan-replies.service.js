/**
 * Retry Orphan Replies — scanner que corre al arrancar ai-engine.
 *
 * Busca conversaciones donde:
 *  - El último mensaje es role=user (Vera nunca contestó), O
 *  - El último mensaje es role=error (Vera intentó pero falló)
 *  - El usuario lo envió hace < 1 hora
 *
 * Para cada uno: dispara processAndSaveReply para que el usuario reciba
 * la respuesta que se le quedó debiendo. Si la causa fue un parse-error
 * de OpenClaw que ya fue arreglado por auto-repair, esto cierra el loop:
 * el fix llega y el mensaje pendiente se procesa solo.
 */
import { supabase } from "../lib/supabase.js";
import { processAndSaveReply } from "./ai.service.js";

const LOOKBACK_HOURS = 1;
const MAX_RETRIES_PER_BOOT = 20; // hard cap por arranque para no spammar OpenClaw

export async function retryOrphanReplies() {
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  // Tomamos los últimos mensajes de las últimas hora por conversación.
  // Estrategia simple: bajar todos los mensajes recientes y agrupar en memoria.
  const { data: rows, error } = await supabase
    .from("ai_messages")
    .select("id, conversation_id, organization_id, role, content, attachments, created_at")
    .gte("created_at", sinceIso)
    .in("role", ["user", "assistant", "error"])
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.warn("retry-orphan: query error:", error.message);
    return { scanned: 0, retried: 0 };
  }

  // Última fila por conversation_id (rows viene en orden descendente)
  const seen = new Set();
  const lastPerConv = [];
  for (const r of rows || []) {
    if (seen.has(r.conversation_id)) continue;
    seen.add(r.conversation_id);
    lastPerConv.push(r);
  }

  // Candidatos = última fila es user O error
  const orphans = lastPerConv.filter((r) => r.role === "user" || r.role === "error");

  if (orphans.length === 0) {
    console.log("retry-orphan: no hay respuestas pendientes en última hora");
    return { scanned: lastPerConv.length, retried: 0 };
  }

  console.log(`retry-orphan: ${orphans.length} conversaciones huérfanas detectadas — reintentando hasta ${MAX_RETRIES_PER_BOOT}`);

  // Resolver el user_id desde la conversación (lo necesita processAndSaveReply)
  let retried = 0;
  for (const orphan of orphans.slice(0, MAX_RETRIES_PER_BOOT)) {
    // Si el último mensaje fue un error, recuperamos el último mensaje USER de esa conv
    let userMessage = orphan;
    if (orphan.role === "error") {
      const { data: userRow } = await supabase
        .from("ai_messages")
        .select("id, content, attachments, created_at")
        .eq("conversation_id", orphan.conversation_id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!userRow) continue;
      userMessage = { ...userRow, conversation_id: orphan.conversation_id, organization_id: orphan.organization_id };

      // Marcar el mensaje de error como reintentado para no re-procesarlo otra vez
      await supabase
        .from("ai_messages")
        .update({ metadata: { retried_at: new Date().toISOString() } })
        .eq("id", orphan.id);
    }

    // Resolver user_id desde ai_conversations
    const { data: conv } = await supabase
      .from("ai_conversations")
      .select("user_id")
      .eq("id", orphan.conversation_id)
      .maybeSingle();
    if (!conv?.user_id) continue;

    console.log(`retry-orphan: reintentando conv=${orphan.conversation_id} msg="${String(userMessage.content || "").slice(0, 60)}"`);

    // Fire and forget — processAndSaveReply persiste el resultado solo.
    // setImmediate para no bloquear el arranque del servidor.
    setImmediate(() => {
      processAndSaveReply({
        message: String(userMessage.content || ""),
        attachments: Array.isArray(userMessage.attachments) ? userMessage.attachments : [],
        organizationId: orphan.organization_id,
        userId: conv.user_id,
        conversationId: orphan.conversation_id,
      });
    });

    retried++;
  }

  return { scanned: lastPerConv.length, retried };
}
