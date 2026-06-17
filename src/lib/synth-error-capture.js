/**
 * synth-error-capture.js — captura rechazos del SINTETIZADOR para auto-reparación.
 *
 * Solo captura cuando la capa de formato/validación (tool-call.validator /
 * parser de markers) rechaza una tool-call que Vera emitió — es decir, cuando
 * Vera quiso usar un formato que el sintetizador no acepta. NO captura fallos
 * de negocio, de red ni de permisos. El detector `self-repair.service` consume
 * estas filas y adapta el sintetizador al formato que Vera necesita.
 *
 * Es fire-and-forget: jamás debe romper el flujo de chat.
 */
import crypto from "crypto";
import { supabase } from "./supabase.js";

function signatureOf(toolName, reason) {
  const norm = String(reason || "").toLowerCase()
    .replace(/[0-9a-f-]{16,}/g, "")  // quita uuids/hashes
    .replace(/\s+/g, " ").trim().slice(0, 140);
  return crypto.createHash("sha1").update(`${toolName}|${norm}`).digest("hex").slice(0, 16);
}

function safeClone(p) {
  try { return JSON.parse(JSON.stringify(p)); } catch { return null; }
}

export async function captureSynthError({ organizationId, conversationId, userId, toolName, params, reason }) {
  try {
    const signature = signatureOf(toolName, reason);
    // Dedup: si ya hay una abierta/en proceso con la misma firma, solo cuenta.
    const { data: existing } = await supabase
      .from("vera_synth_errors")
      .select("id, attempts")
      .eq("signature", signature)
      .in("status", ["open", "repairing"])
      .maybeSingle();
    if (existing) {
      await supabase.from("vera_synth_errors")
        .update({ attempts: (existing.attempts || 0) + 1, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      return;
    }
    await supabase.from("vera_synth_errors").insert({
      organization_id: organizationId || null,
      conversation_id: conversationId || null,
      user_id: userId || null,
      tool_name: toolName,
      reason: String(reason || "").slice(0, 500),
      rejected_payload: safeClone(params),
      signature,
      status: "open",
    });
  } catch (_) { /* nunca romper el chat por la captura */ }
}
