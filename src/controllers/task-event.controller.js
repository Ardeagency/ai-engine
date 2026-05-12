import { supabase } from "../lib/supabase.js";
import {
  getBearerToken,
  fetchUserFromAccessToken,
  assertOrgMember,
} from "../lib/chat-security.js";

/**
 * POST /task-event
 * Guarda eventos de checklist (checkboxes) para gate de consentimiento.
 *
 * Body:
 * {
 *   organization_id,
 *   conversation_id,
 *   source_message_id,
 *   task_index,
 *   task_text,
 *   checked
 * }
 *
 * Inserta en ai_messages como role=system:
 * content = "TASK_EVENT <JSON>"
 */
export const taskEventController = async (req, res) => {
  try {
    const {
      organization_id,
      conversation_id,
      source_message_id,
      task_index,
      task_text,
      checked,
    } = req.body ?? {};

    if (!organization_id || !conversation_id) {
      return res.status(400).json({
        error: "Faltan organization_id o conversation_id",
      });
    }

    if (typeof task_text !== "string" || !task_text.trim()) {
      return res.status(400).json({
        error: "task_text es requerido",
      });
    }

    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({
        error: "Missing Authorization Bearer token",
      });
    }

    const user = await fetchUserFromAccessToken(accessToken);
    if (!user?.id) {
      return res.status(401).json({
        error: "Invalid session",
      });
    }

    await assertOrgMember(organization_id, user.id);

    // Asegura que la conversación pertenece a esa org
    const { data: conv, error: convError } = await supabase
      .from("ai_conversations")
      .select("id")
      .eq("id", conversation_id)
      .eq("organization_id", organization_id)
      .maybeSingle();

    if (convError) {
      return res.status(500).json({
        error: "error validando conversation",
        details: convError.message,
      });
    }
    if (!conv?.id) {
      return res.status(404).json({
        error: "Conversation not found for organization",
      });
    }

    const payload = {
      type: "task_toggle",
      source_message_id: source_message_id || null,
      task_index: Number.isFinite(Number(task_index)) ? Number(task_index) : null,
      task_text: task_text.trim(),
      checked: !!checked,
      user_id: user.id,
      at: new Date().toISOString(),
    };

    await supabase.from("ai_messages").insert({
      conversation_id,
      role: "system",
      content: `TASK_EVENT ${JSON.stringify(payload)}`,
      organization_id,
    });

    return res.json({ ok: true });
  } catch (e) {
    const status = e.statusCode || 500;
    return res.status(status).json({ error: e.message || "error en task-event" });
  }
};

