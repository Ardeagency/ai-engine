"""Detector de GANCHO CREATIVO de un post (competencia). Camino FRIO / batch: corre
solo sobre los TOP posts por engagement (donde esta el aprendizaje), no en el hot path.

El problema que resuelve: un reel de galletas con tematica de Harry Potter ("Banany
Potter Chocolate Frogs") se veia como "receta de frambuesa". El caption + la descripcion
de la media (imagen via Claude, video via Gemini) llevan la señal creativa; este detector
la nombra: NO es el ingrediente lo que rinde, es la CREATIVIDAD (referencia pop-culture,
narrativa, formato). Eso es lo que la marca propia puede aprender de su competencia.

detect_creative_theme(caption, media_description, lang) -> {
  "hook": str,            # etiqueta corta del gancho ("Parodia de Harry Potter")
  "theme_type": str,      # pop_culture | seasonal | personaje | tutorial | humor | ugc | reto | trend | producto | otro
  "references": [str],    # refs culturales detectadas (peliculas, memes, eventos)
  "format": str,          # formato del contenido (reel_receta, skit, unboxing, ...)
  "why": str,             # 1 linea: por que engancha a la audiencia
  "confidence": float
}
"""
import os
import json
import re
from anthropic import Anthropic

CLIENT = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
MODEL = "claude-sonnet-4-6"

_THEMES = ["pop_culture", "seasonal", "personaje", "tutorial", "humor", "ugc",
           "reto", "trend", "producto", "otro"]

PROMPT = """Eres analista creativo de marketing. Te doy el CAPTION de un post de redes de una
marca y (si existe) la DESCRIPCION de su imagen/video. Identifica el GANCHO CREATIVO: que
hace ese contenido memorable mas alla del producto. Detecta referencias de cultura pop
(peliculas, series, memes, celebridades, eventos), juegos de palabras, personajes, narrativa
o formato distintivo. Ej: "Banany Potter Chocolate Frogs" = parodia de Harry Potter (las
ranas de chocolate son de esa saga).

Responde SOLO JSON valido, sin markdown:
{{"hook":"<etiqueta corta en español, max 6 palabras>",
  "theme_type":"<uno de: {themes}>",
  "references":["<refs culturales, [] si ninguna>"],
  "format":"<formato del contenido, español, max 4 palabras>",
  "why":"<1 frase: por que engancha a la audiencia>",
  "confidence":<0.0-1.0>}}

Si NO hay gancho creativo real (post plano de producto), usa theme_type "producto" o "otro"
y confidence baja. NO inventes referencias que no esten sugeridas por el texto/descripcion.

CAPTION:
{caption}

DESCRIPCION DE LA MEDIA:
{desc}"""


def detect_creative_theme(caption: str, media_description: str = "", lang: str = "es") -> dict:
    cap = (caption or "").strip()
    desc = (media_description or "").strip()
    if len(cap) + len(desc) < 8:
        return {"hook": None, "theme_type": "otro", "references": [], "format": None, "why": None, "confidence": 0.0}
    prompt = PROMPT.format(themes=" | ".join(_THEMES), caption=cap[:1500], desc=desc[:1500] or "(sin descripcion de media)")
    try:
        msg = CLIENT.messages.create(model=MODEL, max_tokens=300,
                                     messages=[{"role": "user", "content": prompt}])
        raw = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        m = re.search(r"\{.*\}", raw, re.S)
        data = json.loads(m.group(0) if m else raw)
        tt = data.get("theme_type") if data.get("theme_type") in _THEMES else "otro"
        refs = data.get("references") or []
        if not isinstance(refs, list):
            refs = [str(refs)]
        cost_in = msg.usage.input_tokens * 3 / 1_000_000
        cost_out = msg.usage.output_tokens * 15 / 1_000_000
        return {
            "hook": (data.get("hook") or None),
            "theme_type": tt,
            "references": [str(r)[:60] for r in refs][:5],
            "format": (data.get("format") or None),
            "why": (data.get("why") or None),
            "confidence": float(data.get("confidence") or 0.0),
            "usd_cost": round(cost_in + cost_out, 5),
        }
    except Exception as e:
        return {"hook": None, "theme_type": "otro", "references": [], "format": None, "why": None, "confidence": 0.0, "error": str(e)[:200]}
