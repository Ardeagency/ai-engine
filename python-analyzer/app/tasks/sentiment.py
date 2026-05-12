"""Sentiment analysis multilingual (ES + EN + PT) usando pysentimiento."""
from pysentimiento import create_analyzer
from langdetect import detect, DetectorFactory

DetectorFactory.seed = 42  # langdetect determinista

# Cargar 1 vez al import (modelos en RAM ~700MB total)
_analyzers = {}

def _get(lang: str):
    lang = lang if lang in ("es", "en", "pt", "it") else "en"
    if lang not in _analyzers:
        _analyzers[lang] = create_analyzer(task="sentiment", lang=lang)
    return _analyzers[lang]

def detect_lang(text: str) -> str:
    try:
        l = detect(text[:500])
        return l if l in ("es", "en", "pt", "it") else "en"
    except Exception:
        return "en"

def analyze_sentiment(text: str, lang: str | None = None) -> dict:
    """
    Devuelve { label: 'POS'|'NEG'|'NEU', score: -1..1, probas: {POS, NEG, NEU}, lang }
    score normalizado: POS=+probas.POS, NEG=-probas.NEG, NEU=0
    """
    if not text or len(text.strip()) < 2:
        return {"label": "NEU", "score": 0.0, "probas": {"POS": 0.0, "NEG": 0.0, "NEU": 1.0}, "lang": lang or "?"}
    lang = lang or detect_lang(text)
    a = _get(lang)
    res = a.predict(text[:1000])
    probas = {k: round(float(v), 4) for k, v in res.probas.items()}
    label = res.output  # POS/NEG/NEU
    score = round(probas.get("POS", 0) - probas.get("NEG", 0), 4)
    return {"label": label, "score": score, "probas": probas, "lang": lang}
