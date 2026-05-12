"""Image describer usando Claude Sonnet 4.6 con prompt optimizado.

Anthropic respeta robots.txt al fetchar URLs (IG/FB CDN bloquean), así que
SIEMPRE descargamos la imagen con httpx + enviamos como base64.
"""
import os
import io
import hashlib
import base64
import httpx
from PIL import Image
from anthropic import Anthropic

CLIENT = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
MODEL = "claude-sonnet-4-6"

IMAGE_PROMPT = """Describe esta imagen en español, máximo 130 palabras. Estructura obligatoria:

1. Escena/setting (ubicación, hora del día, atmósfera)
2. Personas (cuántas, edad aproximada, género, etnia, expresión, vestimenta)
3. Acción principal y poses
4. Objetos destacados, productos, marcas/logos visibles
5. Texto sobreimpreso si lo hay (transcribe literal)
6. Mood emocional y composición visual
7. Tipo de contenido (UGC, anuncio, contenido orgánico de marca, lifestyle, deportivo, etc.)

Sé específico, NO genérico. Evita "una persona con un objeto" — describe quién, qué hace, dónde, con qué marca."""


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


MAX_BYTES = 5 * 1024 * 1024  # Anthropic límite 5MB
MAX_DIM = 1568                # Sonnet token efficiency

def _download_image(url: str) -> tuple[str, str]:
    """Descarga + redimensiona si necesario. Devuelve (base64, media_type)."""
    with httpx.Client(timeout=30, follow_redirects=True, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }) as cli:
        r = cli.get(url)
        r.raise_for_status()
        data = r.content
        media_type = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        if not media_type.startswith("image/"):
            media_type = "image/jpeg"

    # Si excede tamaño o dimensiones → redimensionar/recomprimir
    needs_resize = len(data) > MAX_BYTES
    try:
        with Image.open(io.BytesIO(data)) as img:
            w, h = img.size
            if max(w, h) > MAX_DIM:
                needs_resize = True
            if needs_resize:
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                img.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85, optimize=True)
                data = buf.getvalue()
                media_type = "image/jpeg"
                # Si AÚN excede 5MB, baja calidad
                if len(data) > MAX_BYTES:
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=70, optimize=True)
                    data = buf.getvalue()
    except Exception:
        # Si Pillow falla y el tamaño está OK, mandamos original
        if len(data) > MAX_BYTES:
            raise RuntimeError(f"image too large and resize failed: {len(data)} bytes")

    return base64.standard_b64encode(data).decode("utf-8"), media_type


def describe_image(url: str) -> dict:
    """Describe una imagen. Costo aprox: $0.0042 por imagen 1024x1024."""
    if not url or not url.startswith("http"):
        return {"error": "invalid_url"}

    try:
        b64, mime = _download_image(url)
    except Exception as e:
        return {"error": f"download_failed: {str(e)[:120]}"}

    try:
        msg = CLIENT.messages.create(
            model=MODEL, max_tokens=200,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                    {"type": "text", "text": IMAGE_PROMPT},
                ],
            }],
        )
    except Exception as e:
        return {"error": f"anthropic_failed: {str(e)[:200]}"}

    description = msg.content[0].text.strip() if msg.content else ""
    tin, tout = msg.usage.input_tokens, msg.usage.output_tokens
    # Sonnet 4.6 pricing: $3/MTok in, $15/MTok out
    cost = (tin * 3 / 1_000_000) + (tout * 15 / 1_000_000)
    return {
        "description": description, "model": MODEL,
        "tokens_in": tin, "tokens_out": tout,
        "usd_cost": round(cost, 5),
    }


def describe_carousel(urls: list[str]) -> dict:
    """Describe un carrusel en 1 sola request (más barato que N descripciones)."""
    if not urls or not all(u.startswith("http") for u in urls):
        return {"error": "invalid_urls"}

    content = []
    for u in urls[:10]:
        try:
            b64, mime = _download_image(u)
            content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}})
        except Exception as e:
            return {"error": f"download_failed[{u[:80]}]: {str(e)[:80]}"}

    content.append({
        "type": "text",
        "text": (
            f"Estas {len(content)} imágenes forman un carrusel de redes sociales. "
            "Describe en español, máximo 150 palabras: tema unificador, progresión narrativa, "
            "marca/productos visibles, mood, propósito (educativo/promocional/lifestyle/UGC). "
            "Si cada slide cuenta algo distinto, mencionalo brevemente."
        ),
    })

    try:
        msg = CLIENT.messages.create(model=MODEL, max_tokens=250,
                                     messages=[{"role": "user", "content": content}])
    except Exception as e:
        return {"error": f"anthropic_failed: {str(e)[:200]}"}

    description = msg.content[0].text.strip() if msg.content else ""
    tin, tout = msg.usage.input_tokens, msg.usage.output_tokens
    cost = (tin * 3 / 1_000_000) + (tout * 15 / 1_000_000)
    return {
        "description": description, "model": MODEL,
        "image_count": len(urls),
        "tokens_in": tin, "tokens_out": tout,
        "usd_cost": round(cost, 5),
    }
