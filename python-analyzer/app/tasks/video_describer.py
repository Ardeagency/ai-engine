"""Video describer usando Gemini 2.5 Flash nativo (paquete google.genai nuevo)."""
import os
import time
import httpx
from google import genai
from google.genai import types

_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
MODEL = "gemini-2.5-flash"

VIDEO_PROMPT = """Describe este video en español, máximo 180 palabras. Estructura obligatoria:

1. Setting/contexto (dónde se filma, hora, ambiente)
2. Protagonistas (cuántos, edad, género, etnia, vestimenta, expresiones)
3. NARRATIVA TEMPORAL: qué pasa al inicio → desarrollo → clímax → desenlace
4. Acciones específicas (no "alguien hace algo": describe la acción)
5. Productos, marcas, logos visibles (cuándo aparecen y dónde)
6. Texto sobreimpreso, captions del video, voz en off (transcribe literal si es importante)
7. Música/audio si es relevante (ritmo, género, mood)
8. Mood general y tipo de contenido (UGC, anuncio, deportivo, lifestyle, tutorial, viral, etc.)

Sé específico. Captura la HISTORIA del video, no solo describas frames sueltos."""


def _calc_cost(tin: int, tout: int) -> float:
    # Gemini 2.5 Flash: $0.30/MTok in, $2.50/MTok out
    return round((tin * 0.30 / 1_000_000) + (tout * 2.50 / 1_000_000), 5)


def describe_video_url(video_url: str) -> dict:
    """Para YouTube: pasa URL directa. Para otros: descarga + Files API."""
    if not video_url or not video_url.startswith("http"):
        return {"error": "invalid_url"}

    try:
        if "youtube.com" in video_url or "youtu.be" in video_url:
            response = _client.models.generate_content(
                model=MODEL,
                contents=types.Content(parts=[
                    types.Part(file_data=types.FileData(file_uri=video_url, mime_type="video/mp4")),
                    types.Part(text=VIDEO_PROMPT),
                ]),
            )
            usage = response.usage_metadata
            return {
                "description": response.text.strip() if response.text else "",
                "model": MODEL,
                "tokens_in": usage.prompt_token_count,
                "tokens_out": usage.candidates_token_count,
                "usd_cost": _calc_cost(usage.prompt_token_count, usage.candidates_token_count),
                "method": "url_direct",
            }
        return describe_video_via_upload(video_url)
    except Exception as e:
        return {"error": str(e)[:300]}


def describe_video_via_upload(video_url: str, max_size_mb: int = 100) -> dict:
    """Descarga MP4 + sube via Files API (válido ~48h)."""
    try:
        with httpx.Client(timeout=90, follow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }) as cli:
            r = cli.get(video_url)
            r.raise_for_status()
            data = r.content
            if len(data) > max_size_mb * 1024 * 1024:
                return {"error": f"video too large: {len(data)/1024/1024:.1f}MB > {max_size_mb}MB"}

        tmp_path = f"/tmp/video_{int(time.time())}_{abs(hash(video_url)) % 10**8}.mp4"
        with open(tmp_path, "wb") as f:
            f.write(data)

        try:
            file_obj = _client.files.upload(file=tmp_path)
            # Esperar processing (Gemini procesa video antes de poder usarlo)
            for _ in range(30):
                file_obj = _client.files.get(name=file_obj.name)
                if file_obj.state.name == "ACTIVE":
                    break
                if file_obj.state.name == "FAILED":
                    return {"error": "gemini_processing_failed"}
                time.sleep(2)
            else:
                return {"error": "gemini_processing_timeout"}

            response = _client.models.generate_content(
                model=MODEL,
                contents=types.Content(parts=[
                    types.Part(file_data=types.FileData(file_uri=file_obj.uri, mime_type=file_obj.mime_type)),
                    types.Part(text=VIDEO_PROMPT),
                ]),
            )
            usage = response.usage_metadata
            try:
                _client.files.delete(name=file_obj.name)
            except Exception:
                pass
            return {
                "description": response.text.strip() if response.text else "",
                "model": MODEL,
                "tokens_in": usage.prompt_token_count,
                "tokens_out": usage.candidates_token_count,
                "usd_cost": _calc_cost(usage.prompt_token_count, usage.candidates_token_count),
                "method": "upload",
            }
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
    except Exception as e:
        return {"error": str(e)[:300]}
