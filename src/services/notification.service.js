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

// ── Plantilla de email AI Smart Content ──────────────────────────────────────
// Mismo formato que las plantillas de Supabase Auth: tarjeta blanca 600px, barra
// de degradado arcoiris superior, logo de marca, tipografia Helvetica, boton
// oscuro con texto blanco y footer. title/message van escapados (XSS).
const _LOGO_URL    = "https://res.cloudinary.com/dmruwjuxn/image/upload/v1780427171/lOGO-SMART_zpbfdp.png";
const _RAINBOW_URL = "https://tsdpbqcwjckbfsdqacam.supabase.co/storage/v1/object/public/org-assets/email/rainbow-bar.png";
const _FONT        = "Helvetica, Arial, sans-serif";

function _buildEmailHtml(title, message, link_to) {
  const btn = link_to
    ? `
        <tr>
          <td align="center" style="padding:14px 40px 8px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#141517"
                    style="background-color:#141517;border:1px solid #242424;border-radius:10px;">
                  <a href="${_escAttr(link_to)}" target="_blank"
                     style="display:inline-block;padding:15px 28px;font-family:${_FONT};
                            font-size:20px;font-weight:400;line-height:121%;
                            letter-spacing:-0.05em;color:#FFFFFF;text-decoration:none;">
                    Ver en plataforma
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${_esc(title)}</title>
<style>
  body { margin:0; padding:0; background-color:#EDEDED; -webkit-text-size-adjust:100%; }
  a { text-decoration:none; }
  @media only screen and (max-width:620px) { .email-card { width:100% !important; } }
</style>
</head>
<body style="margin:0;padding:0;background-color:#EDEDED;font-family:${_FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#EDEDED;">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0"
             border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;
             border-radius:14px;overflow:hidden;border-collapse:separate;">

        <!-- Barra arcoiris -->
        <tr><td style="padding:0;line-height:0;font-size:0;background-color:#FF6500;">
          <img src="${_RAINBOW_URL}" width="600" height="4" alt=""
               style="display:block;width:100%;height:4px;border:0;outline:none;" />
        </td></tr>

        <!-- Logo -->
        <tr>
          <td align="center" style="padding:31px 40px 6px 40px;">
            <img src="${_LOGO_URL}" width="62" height="62" alt="AI Smart Content"
                 style="display:block;width:62px;height:62px;border:0;outline:none;" />
          </td>
        </tr>

        <!-- Titulo -->
        <tr>
          <td align="center" style="padding:18px 40px 0 40px;">
            <h1 style="margin:0;font-family:${_FONT};font-size:32px;font-weight:400;
                       line-height:35px;text-align:center;color:#0B0B0B;">
              ${_esc(title)}
            </h1>
          </td>
        </tr>

        <!-- Cuerpo -->
        <tr>
          <td align="center" style="padding:18px 50px 6px 50px;">
            <p style="margin:0;font-family:${_FONT};font-size:18px;font-weight:400;
                      line-height:1.45;letter-spacing:-0.02em;text-align:center;color:#0B0B0B;">
              ${_esc(message)}
            </p>
          </td>
        </tr>

        ${btn}

        <!-- Espaciador -->
        <tr><td style="height:34px;line-height:34px;font-size:0;">&nbsp;</td></tr>

        <!-- Footer social -->
        <tr>
          <td align="center" style="padding:0 40px 4px 40px;">
            <p style="margin:0;font-family:${_FONT};font-size:15px;font-weight:700;
                      line-height:16px;text-align:center;">
              <a href="https://www.instagram.com/aismart.content/" target="_blank"
                 style="color:#7B7B7B;text-decoration:underline;font-weight:700;">Instagram</a>
              <span style="color:#7B7B7B;">&nbsp;&middot;&nbsp;</span>
              <a href="https://www.youtube.com/@AISmartContent-h5d" target="_blank"
                 style="color:#7B7B7B;text-decoration:underline;font-weight:700;">YouTube</a>
            </p>
          </td>
        </tr>

        <!-- Footer enlaces -->
        <tr>
          <td align="center" style="padding:6px 40px 0 40px;">
            <p style="margin:0;font-family:${_FONT};font-size:15px;font-weight:400;
                      line-height:16px;text-align:center;">
              <a href="https://aismartcontent.io" target="_blank"
                 style="color:#7B7B7B;text-decoration:underline;">aismartcontent.io</a>
              <span style="color:#7B7B7B;">&nbsp;&middot;&nbsp;</span>
              <a href="https://aismartcontent.io/privacy-policy" target="_blank"
                 style="color:#7B7B7B;text-decoration:underline;">Privacidad</a>
              <span style="color:#7B7B7B;">&nbsp;&middot;&nbsp;</span>
              <a href="https://aismartcontent.io/terms-and-conditions" target="_blank"
                 style="color:#7B7B7B;text-decoration:underline;">Terminos</a>
            </p>
          </td>
        </tr>

        <!-- Copyright -->
        <tr>
          <td align="center" style="padding:14px 48px 34px 48px;">
            <p style="margin:0;font-family:${_FONT};font-size:15px;font-weight:400;
                      line-height:16px;text-align:center;color:#7B7B7B;">
              &copy; 2026 AI Smart Content &mdash; Todos los derechos reservados
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Escape básico para no romper HTML (XSS mitigation)
function _esc(s)     { return String(s ?? "").replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c])); }
function _escAttr(s) { return String(s ?? "").replace(/["<>]/g, c => ({'"':"&quot;","<":"&lt;",">":"&gt;"}[c])); }
