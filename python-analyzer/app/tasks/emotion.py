"""Emotion analysis (joy, anger, sadness, fear, disgust, surprise, others) — pysentimiento ES nativo."""
from pysentimiento import create_analyzer

_analyzers = {}

def _get(lang: str):
    lang = lang if lang in ("es", "en") else "en"
    if lang not in _analyzers:
        _analyzers[lang] = create_analyzer(task="emotion", lang=lang)
    return _analyzers[lang]

def analyze_emotion(text: str, lang: str = "en") -> dict:
    """
    Devuelve { dominant: 'joy', probas: {joy:.., anger:.., ...}, intensity: 0-1 }
    intensity = max probability of non-neutral emotion (proxy de "fuerza emocional")
    """
    if not text or len(text.strip()) < 2:
        return {"dominant": "others", "probas": {}, "intensity": 0.0}
    a = _get(lang)
    res = a.predict(text[:1000])
    probas = {k: round(float(v), 4) for k, v in res.probas.items()}
    dominant = res.output
    # Intensity: prob de la emoción dominante si NO es 'others'/'neutral'
    intensity = 0.0
    if dominant.lower() not in ("others", "neutral"):
        intensity = probas.get(dominant, 0.0)
    return {"dominant": dominant, "probas": probas, "intensity": round(intensity, 4)}
