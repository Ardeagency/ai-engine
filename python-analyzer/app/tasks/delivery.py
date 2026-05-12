"""Delivery Layer — sender unificado para Slack/Webhook/Email.

Cada función devuelve dict con {ok, http_status, error, payload_size_bytes}.
"""
import os
import json
import smtplib
import httpx
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


# ── SLACK ────────────────────────────────────────────────────────────────────
def send_to_slack(webhook_url: str, title: str, markdown_content: str, max_chars: int = 35_000) -> dict:
    """
    Slack incoming webhook con formato Block Kit.
    El markdown se trunca a 35K (limite Slack ~40K total).
    """
    if not webhook_url or not webhook_url.startswith("https://hooks.slack.com/"):
        return {"ok": False, "error": "invalid_slack_webhook"}

    truncated = markdown_content[:max_chars]
    if len(markdown_content) > max_chars:
        truncated += f"\n\n_...truncated ({len(markdown_content)} chars total)_"

    payload = {
        "text": title,  # fallback para notificaciones
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": title[:150], "emoji": True},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": _md_to_slack_mrkdwn(truncated)},
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "_Powered by AI Smart Content_"}],
            },
        ],
    }

    body_str = json.dumps(payload)
    try:
        with httpx.Client(timeout=15) as cli:
            r = cli.post(webhook_url, content=body_str, headers={"Content-Type": "application/json"})
        return {
            "ok": r.status_code < 400,
            "http_status": r.status_code,
            "error": r.text[:200] if r.status_code >= 400 else None,
            "payload_size_bytes": len(body_str),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "payload_size_bytes": len(body_str)}


def _md_to_slack_mrkdwn(md: str) -> str:
    """Conversión mínima Markdown → Slack mrkdwn."""
    import re
    out = md
    # Headers → bold
    out = re.sub(r"^#{1,6}\s+(.*)", r"*\1*", out, flags=re.M)
    # **bold** → *bold*
    out = re.sub(r"\*\*(.+?)\*\*", r"*\1*", out)
    # `code` queda igual
    # links [text](url) → <url|text>
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<\2|\1>", out)
    return out


# ── WEBHOOK GENÉRICO ─────────────────────────────────────────────────────────
def send_to_webhook(url: str, payload: dict, secret: str | None = None) -> dict:
    """
    POST JSON genérico. Si hay secret, agrega header X-AISMARTCONTENT-Signature (HMAC SHA256).
    """
    if not url or not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "invalid_webhook_url"}

    body_str = json.dumps(payload)
    headers = {"Content-Type": "application/json", "User-Agent": "AISmartContent-Webhook/1.0"}
    if secret:
        import hmac, hashlib
        sig = hmac.new(secret.encode(), body_str.encode(), hashlib.sha256).hexdigest()
        headers["X-AISMARTCONTENT-Signature"] = f"sha256={sig}"

    try:
        with httpx.Client(timeout=20, follow_redirects=True) as cli:
            r = cli.post(url, content=body_str, headers=headers)
        return {
            "ok": r.status_code < 400,
            "http_status": r.status_code,
            "error": r.text[:200] if r.status_code >= 400 else None,
            "payload_size_bytes": len(body_str),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "payload_size_bytes": len(body_str)}


# ── EMAIL (SMTP) ─────────────────────────────────────────────────────────────
def send_to_email(config: dict, subject: str, markdown_body: str, recipients: list[str]) -> dict:
    """
    config esperado: {smtp_host, smtp_port, smtp_user, smtp_pass, from_address}
    Se envía como HTML (markdown convertido) + texto plano (markdown raw).
    """
    if not recipients:
        return {"ok": False, "error": "no_recipients"}
    required = ("smtp_host", "smtp_port", "smtp_user", "smtp_pass", "from_address")
    missing = [k for k in required if not config.get(k)]
    if missing:
        return {"ok": False, "error": f"missing_smtp_config:{','.join(missing)}"}

    html = _md_to_html(markdown_body)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject[:200]
    msg["From"] = config["from_address"]
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(markdown_body, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        port = int(config["smtp_port"])
        if port == 465:
            with smtplib.SMTP_SSL(config["smtp_host"], port, timeout=30) as smtp:
                smtp.login(config["smtp_user"], config["smtp_pass"])
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(config["smtp_host"], port, timeout=30) as smtp:
                smtp.starttls()
                smtp.login(config["smtp_user"], config["smtp_pass"])
                smtp.send_message(msg)
        return {"ok": True, "http_status": 250, "payload_size_bytes": len(markdown_body)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "payload_size_bytes": len(markdown_body)}


def _md_to_html(md: str) -> str:
    """Conversión mínima Markdown → HTML (sin librería pesada)."""
    import re
    html_lines = []
    for line in md.split("\n"):
        stripped = line.strip()
        if not stripped:
            html_lines.append("<br>")
            continue
        # Headers
        m = re.match(r"^(#{1,6})\s+(.*)", stripped)
        if m:
            level = len(m.group(1))
            html_lines.append(f"<h{level}>{m.group(2)}</h{level}>")
            continue
        # Lista
        if stripped.startswith(("- ", "* ")):
            html_lines.append(f"<li>{stripped[2:]}</li>")
            continue
        # Tablas | col | col |
        if "|" in stripped and stripped.startswith("|"):
            cols = [c.strip() for c in stripped.strip("|").split("|")]
            tag = "th" if all(c.replace("-", "").replace(":", "").strip() == "" for c in cols) else "td"
            html_lines.append("<tr>" + "".join(f"<{tag}>{c}</{tag}>" for c in cols) + "</tr>")
            continue
        # Bold + italic
        line_h = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", stripped)
        line_h = re.sub(r"\*(.+?)\*", r"<em>\1</em>", line_h)
        # Code inline
        line_h = re.sub(r"`([^`]+)`", r"<code>\1</code>", line_h)
        # Links
        line_h = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', line_h)
        html_lines.append(f"<p>{line_h}</p>")
    body = "\n".join(html_lines)
    return f"""<!DOCTYPE html><html><head><meta charset='utf-8'><style>
body{{font-family:-apple-system,sans-serif;max-width:720px;margin:20px auto;padding:0 16px;color:#1a1a1a}}
h1,h2,h3{{color:#0d0d0d}}
li{{margin:4px 0}}
code{{background:#f3f4f6;padding:2px 5px;border-radius:3px;font-size:0.9em}}
table{{border-collapse:collapse;margin:8px 0;width:100%}}
td,th{{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}}
th{{background:#f9fafb}}
a{{color:#2563eb}}
</style></head><body>{body}</body></html>"""


# ── DISPATCHER ───────────────────────────────────────────────────────────────
def dispatch(channel_type: str, channel_config: dict, event_type: str, content: dict) -> dict:
    """
    content esperado:
      { title, markdown, payload_json (dict) }
    Retorna resultado de la entrega.
    """
    title = content.get("title") or f"AI Smart Content — {event_type}"
    markdown = content.get("markdown") or ""
    payload_json = content.get("payload_json") or {}

    if channel_type == "slack":
        webhook_url = channel_config.get("webhook_url")
        return send_to_slack(webhook_url, title, markdown)

    if channel_type == "webhook":
        url = channel_config.get("url")
        secret = channel_config.get("secret")
        # Para webhook genérico mandamos JSON estructurado, no markdown
        full_payload = {
            "event_type": event_type,
            "title": title,
            "markdown": markdown,
            "data": payload_json,
        }
        return send_to_webhook(url, full_payload, secret)

    if channel_type == "email":
        recipients = channel_config.get("recipients") or []
        return send_to_email(channel_config, title, markdown, recipients)

    if channel_type == "notion":
        # MVP: notion como webhook genérico — cliente conecta vía Zapier/Make
        url = channel_config.get("webhook_url")
        if not url:
            return {"ok": False, "error": "notion_requires_zapier_webhook"}
        return send_to_webhook(url, {"event_type": event_type, "title": title, "markdown": markdown}, None)

    return {"ok": False, "error": f"unknown_channel_type:{channel_type}"}
