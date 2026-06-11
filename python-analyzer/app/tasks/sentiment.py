"""Sentiment analysis multilingual (ES + EN + PT) usando pysentimiento."""
from pysentimiento import create_analyzer
import re
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

# ── Heurísticas de polaridad explícita (post-procesado) ──────────────────────
# pysentimiento es conservador: "golden era, sweeps victory, dominates" lo deja en
# NEU porque su threshold interno favorece NEU ante ambigüedad. Acá amplificamos
# señales claras (emojis + keywords de victoria/celebración) que el modelo subestima.
POS_EMOJI = {"🔥","🏆","💪","🚀","💯","❤️","✨","🎉","💥","⭐","🌟","👑","🥇","💎"}
NEG_EMOJI = {"💔","😢","😞","😤","😡","💀","🤮","👎","🚨","⚠️","😩","😭"}
POS_KEYWORDS_EN = {
    " win", " winner", "victory", "champion", "champions", "winning",
    "best ", "greatest", "legendary", "iconic", "amazing", "incredible",
    "love this", "love it", "obsessed", "stunning", "premium", "elite",
    "exclusive", "perfect", "dominates", "dominated", "killed it", "crushed",
    "sweeps", "wins", " won ", "epic", "outstanding", "phenomenal", "brilliant",
    "magical", "spectacular", "next level", "world class",
}
POS_KEYWORDS_ES = {
    "ganador", "ganadora", "victoria", "triunfo", "campeón", "campeona",
    "increíble", "espectacular", "alucinante", "magnífico", "extraordinario",
    "imperdible", "el mejor", "la mejor", "icónico", "legendario", "exclusivo",
    "premium", "perfecto",
    # Jerga latina de elogio (en comentarios = positivo, no literal):
    "brutal", "brutalisimo", "bestial", "una bestia", "tremendo", "tremenda",
    "una locura", "que locura", "chimba", "berraco", "verraco", "salvaje",
    "demente", "lo maximo", "buenisimo", "buenisima", "genial", "hermoso",
    "hermosa", "una belleza", "me encanta", "encanta", "epico", "epica",
    "uff", "wow", "fino", "joya", "crack", "candela", "duro",
}
NEG_KEYWORDS_EN = {
    " fail", "failed", "disaster", "terrible", "worst", "awful",
    "scandal", "lawsuit", "boycott", "disappointed", "horrible",
    "broken", "ripoff", "scam", "fraud", "betrayed",
}
NEG_KEYWORDS_ES = {
    "fracaso", "desastre", "terrible", "pésimo", "horrible", "estafa",
    "fraude", "boicot", "decepción", "robado", "engañ",
}

def _normalize(text: str) -> str:
    """Colapsa alargamientos: 'brutaaaal'->'brutal', 'siii'->'si'."""
    return re.sub(r"(.)\1{2,}", r"\1", text.lower())

def _signals(text: str):
    """(pos_emoji, neg_emoji, pos_keyword, neg_keyword), normaliza alargamientos."""
    t = _normalize(text)
    pos_e = sum(text.count(e) for e in POS_EMOJI)
    neg_e = sum(text.count(e) for e in NEG_EMOJI)
    pos_k = sum(1 for k in POS_KEYWORDS_EN if k in t) + sum(1 for k in POS_KEYWORDS_ES if k in t)
    neg_k = sum(1 for k in NEG_KEYWORDS_EN if k in t) + sum(1 for k in NEG_KEYWORDS_ES if k in t)
    return pos_e, neg_e, pos_k, neg_k

def _polarity_boost(text: str) -> float:
    """Devuelve un delta a sumar al score (-0.4..+0.4)."""
    pos_e, neg_e, pos_k, neg_k = _signals(text)
    delta = (pos_e + pos_k) * 0.08 - (neg_e + neg_k) * 0.08
    return max(-0.4, min(0.4, delta))

def analyze_sentiment(text: str, lang: str | None = None) -> dict:
    """
    Devuelve { label: 'POS'|'NEG'|'NEU', score: -1..1, probas: {POS, NEG, NEU}, lang }
    score normalizado: POS=+probas.POS, NEG=-probas.NEG, NEU=0

    Post-procesado:
      1. Score boost por emojis/keywords explícitos de victoria/celebración (EN+ES).
      2. Si score|>=0.3| pero pysentimiento eligió NEU, override del label.
    """
    if not text or len(text.strip()) < 2:
        return {"label": "NEU", "score": 0.0, "probas": {"POS": 0.0, "NEG": 0.0, "NEU": 1.0}, "lang": lang or "?"}
    lang = lang or detect_lang(text)
    a = _get(lang)
    res = a.predict(text[:1000])
    probas = {k: round(float(v), 4) for k, v in res.probas.items()}
    label = res.output
    score = probas.get("POS", 0) - probas.get("NEG", 0)

    # Boost por señales explícitas (emojis + keywords) — corrige el sesgo conservador
    boost = _polarity_boost(text)
    if boost != 0:
        score = max(-1.0, min(1.0, score + boost))

    # Reacciones cortas de hype en jerga latina ("Brutal!!!", "BRUTAAAAAAL",
    # "Que chimba") que el modelo lee literal como negativas: si hay senal
    # positiva fuerte (slang/emoji), es corto y sin negativo explicito,
    # confiamos en el lexico sobre el modelo.
    pe, ne, pk, nk = _signals(text)
    if (pk >= 1 or pe >= 2) and nk == 0 and len(text.split()) <= 6:
        label = "POS"
        score = max(score, 0.6)

    # Override del label cuando el score (ya boosteado) es claramente polarizado pero
    # el modelo eligió NEU. Threshold 0.30 — empíricamente la zona donde pysentimiento
    # subclasifica como NEU a posts de marca claramente positivos.
    if label == "NEU":
        if score >= 0.30:
            label = "POS"
        elif score <= -0.30:
            label = "NEG"

    return {"label": label, "score": round(score, 4), "probas": probas, "lang": lang}
