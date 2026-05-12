import { supabase } from "../lib/supabase.js";
import {
  getBearerToken,
  fetchUserFromAccessToken,
  assertOrgMember,
  assertConversationInOrg,
} from "../lib/chat-security.js";
import { processAndSaveReply } from "../services/ai.service.js";
import { estimateClaudeTaskCost } from "../lib/cost-estimator.js";

/**
 * POST /chat — Patrón async: responde inmediatamente y procesa en background.
 *
 * Flujo:
 *  1. Valida auth + membresía de org.
 *  2. Guarda el mensaje del usuario en ai_messages.
 *  3. Devuelve { conversation_id, status: "processing" } de inmediato (< 1s).
 *  4. Lanza processAndSaveReply en background (puede tardar minutos).
 *  5. Cuando termina, guarda la respuesta en ai_messages → el frontend la recibe
 *     via Supabase Realtime o GET /chat/conversation/:id/status.
 *
 * El frontend NUNCA espera la respuesta completa en esta llamada.
 */
export const chatController = async (req, res) => {
  try {
    const { organization_id, conversation_id, message, attachments, confirmed_high_cost } = req.body ?? {};

    const hasMessage     = typeof message === "string" && message.trim().length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!organization_id || (!hasMessage && !hasAttachments)) {
      return res.status(400).json({ error: "Faltan organization_id o message/attachments" });
    }

    const MAX_MESSAGE_LENGTH = 10_000;
    if (hasMessage && message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `El mensaje excede el límite de ${MAX_MESSAGE_LENGTH} caracteres`,
      });
    }

    if (hasAttachments && attachments.length > 10) {
      return res.status(400).json({ error: "Máximo 10 archivos adjuntos por mensaje" });
    }

    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    const user = await fetchUserFromAccessToken(accessToken);
    if (!user?.id) {
      return res.status(401).json({ error: "Invalid session" });
    }

    await assertOrgMember(organization_id, user.id);

    // ── Resolver o crear conversación ─────────────────────────────────────────
    let convId = conversation_id || null;

    if (convId) {
      await assertConversationInOrg(convId, organization_id);
    } else {
      const { data: newConversation, error: convError } = await supabase
        .from("ai_conversations")
        .insert({
          user_id: user.id,
          organization_id,
          title: "Nueva conversación",
        })
        .select()
        .single();

      if (convError) {
        console.error("chatController: error creando conversación:", convError.message);
        return res.status(500).json({ error: "No se pudo iniciar la conversación" });
      }
      convId = newConversation.id;
    }

    // ── Pre-flight cost estimation ────────────────────────────────────────────
    // Si la heurística estima que el mensaje superará el `confirm_threshold_usd`
    // de la org, devolvemos `cost_confirmation_required` SIN insertar el user
    // message. El frontend muestra el estimate al usuario y, si confirma,
    // re-envía con `confirmed_high_cost: true` que omite este check.
    if (!confirmed_high_cost && hasMessage) {
      try {
        const estimate = await estimateClaudeTaskCost({
          message:        message.trim(),
          attachments:    hasAttachments ? attachments : [],
          organizationId: organization_id,
        });
        if (estimate.confirm_required) {
          return res.json({
            conversation_id: convId,
            status:          "cost_confirmation_required",
            estimate,
          });
        }
      } catch (estErr) {
        console.warn(`chatController: cost estimation failed (fail-open): ${estErr.message}`);
      }
    }

    // ── Guardar mensaje del usuario ───────────────────────────────────────────
    const userRow = {
      conversation_id: convId,
      role:            "user",
      content:         hasMessage ? message.trim() : "",
      organization_id,
    };
    if (hasAttachments) userRow.attachments = attachments;

    const { error: userMessageError } = await supabase
      .from("ai_messages")
      .insert(userRow);

    if (userMessageError) {
      console.error("chatController: error guardando mensaje usuario:", userMessageError.message);
      return res.status(500).json({ error: "No se pudo procesar el mensaje" });
    }

    // ── Responder inmediatamente ─────────────────────────────────────────────
    // El cliente recibe conversation_id + status="processing" en < 1s.
    // La respuesta real llega a ai_messages (Supabase Realtime o polling).
    res.json({ conversation_id: convId, status: "processing" });

    // ── Procesar en background (fire & forget) ────────────────────────────────
    // processAndSaveReply nunca lanza — captura todos los errores internamente
    // y los guarda como mensaje de asistente en la DB.
    setImmediate(() => {
      processAndSaveReply({
        message:     hasMessage ? message.trim() : "",
        attachments: hasAttachments ? attachments : [],
        organizationId: organization_id,
        userId:         user.id,
        conversationId: convId,
      });
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error("chatController:", error);
    return res.status(status).json({
      error: error.message || "error en chat",
    });
  }
};

/**
 * GET /chat/conversation/:id/status
 *
 * Polling endpoint — devuelve el último mensaje del asistente para una
 * conversación dada. Úsalo cuando Supabase Realtime no esté disponible.
 *
 * Respuesta:
 *  { status: "processing" }                       — sin respuesta aún
 *  { status: "done", message, actions?, error? }  — respuesta lista
 */
export const conversationStatus = async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const { organization_id } = req.query;

    if (!conversationId || !organization_id) {
      return res.status(400).json({ error: "Faltan conversationId o organization_id" });
    }

    const accessToken = getBearerToken(req);
    if (!accessToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const user = await fetchUserFromAccessToken(accessToken);
    if (!user?.id) return res.status(401).json({ error: "Invalid session" });

    await assertOrgMember(organization_id, user.id);
    await assertConversationInOrg(conversationId, organization_id);

    // Último mensaje del asistente en esta conversación
    const { data: msg, error } = await supabase
      .from("ai_messages")
      .select("content, metadata, created_at")
      .eq("conversation_id", conversationId)
      .eq("organization_id", organization_id)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("conversationStatus: DB error:", error.message);
      return res.status(500).json({ error: "No se pudo consultar el estado" });
    }

    if (!msg) {
      return res.json({ status: "processing" });
    }

    return res.json({
      status: msg.metadata?.error ? "error" : "done",
      message: msg.content,
      actions: msg.metadata?.actions ?? [],
      created_at: msg.created_at,
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message || "error" });
  }
};
