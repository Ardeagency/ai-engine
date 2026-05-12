/**
 * Notification Service — alertas al usuario (in-app + email).
 *
 * Política:
 *   - in-app:  siempre (INSERT en user_notifications, propagado via Supabase Realtime
 *              si la tabla está añadida a la publication supabase_realtime).
 *   - email:   solo si send_email=true o type='warning'|'error'.
 *
 * Si RESEND_VERA_API_KEY no está configurada, el email se skipea silenciosamente
 * pero la in-app sí se guarda. Todos los errores se loggean y NO bloquean al caller.
 */
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

const resendApiKey = process.env.RESEND_VERA_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

if (!resend) {
  console.warn("[notify] RESEND_VERA_API_KEY no configurada — emails deshabilitados");
}

/**
 * @param {object} opts
 * @param {string} opts.user_id
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {"info"|"success"|"warning"|"error"} [opts.type="info"]
 * @param {string|null} [opts.link_to]
 * @param {string} [opts.user_email]    — requerido para email
 * @param {boolean} [opts.send_email]   — fuerza email aunque type no sea warning/error
 */
export async function notifyUser({
  user_id,
  title,
  message,
  type = "info",
  link_to = null,
  user_email,
  send_email = false,
}) {
  // 1. In-app siempre
  const { data: notif, error } = await supabase.from("user_notifications").insert({
    user_id, title, message, type, link_to,
  }).select().maybeSingle();
  if (error) console.error("[notify] insert error:", error.message);

  // 2. Email si corresponde
  const shouldEmail = send_email || type === "warning" || type === "error";
  if (shouldEmail && user_email && resend) {
    try {
      await resend.emails.send({
        from:    "VERA <contact@aismartcontent.io>",
        to:      user_email,
        subject: title,
        html:    _buildEmailHtml(title, message, link_to),
      });
    } catch (e) {
      console.error("[notify] email error (non-blocking):", e.message);
    }
  }

  return notif || null;
}

function _buildEmailHtml(title, message, link_to) {
  const linkBlock = link_to
    ? `<a href="${_escAttr(link_to)}" style="display:inline-block;background:#00e5cc;color:#000;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Ver en plataforma →</a>`
    : "";
  return `
    <div style="font-family:Inter,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0a0a0a;color:#e5e5e5;border-radius:12px;">
      <div style="font-size:13px;color:#00e5cc;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;">VERA · AI Smart Content</div>
      <h2 style="font-size:20px;font-weight:700;color:#ffffff;margin:0 0 12px;line-height:1.3;">${_esc(title)}</h2>
      <p style="font-size:15px;line-height:1.6;color:#a3a3a3;margin:0 0 24px;">${_esc(message)}</p>
      ${linkBlock}
      <p style="font-size:12px;color:#525252;margin-top:32px;">AI Smart Content · aismartcontent.io</p>
    </div>
  `;
}

// Escape básico para no romper HTML (XSS mitigation)
function _esc(s)     { return String(s ?? "").replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c])); }
function _escAttr(s) { return String(s ?? "").replace(/["<>]/g, c => ({'"':"&quot;","<":"&lt;",">":"&gt;"}[c])); }
