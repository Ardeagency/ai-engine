"""Tone vector (5 dimensiones) sin modelos pesados — textstat + heurísticas + diccionarios."""
import re
import textstat
import emoji as emoji_lib

# Diccionarios mínimos (extender con tiempo)
URGENCY_WORDS = {
    "es": {"ya", "ahora", "hoy", "rápido", "urgente", "última", "último", "última oportunidad", "no te lo pierdas", "corre", "antes", "vence"},
    "en": {"now", "today", "fast", "urgent", "limited", "last", "hurry", "don't miss", "act", "expires", "ending"},
}
PERSUASION_WORDS = {
    "es": {"tú", "ti", "te ofrecemos", "imagínate", "descubre", "garantizado", "gratis", "exclusivo", "solo para ti", "comprueba"},
    "en": {"you", "your", "imagine", "discover", "guaranteed", "free", "exclusive", "only for you", "proven", "try"},
}
INFORMAL_MARKERS = {
    "es": {"jaja", "jeje", "xd", "lol", "qué", "wey", "bro", "bb", "tipo", "neta", "obvio"},
    "en": {"lol", "lmao", "omg", "tbh", "rn", "bro", "fam", "literally", "vibing", "lit"},
}
FORMAL_MARKERS = {
    "es": {"asimismo", "por consiguiente", "no obstante", "a saber", "en consecuencia", "considerando", "mediante"},
    "en": {"furthermore", "however", "therefore", "moreover", "consequently", "regarding", "pursuant"},
}


def _count_any(text_low: str, words: set) -> int:
    return sum(1 for w in words if w in text_low)


def tone_vector(text: str, lang: str = "es") -> dict:
    """
    Devuelve vector 5-dim normalizado [0..1] + readability raw.
      formality:  formal vs informal (1 = formal)
      enthusiasm: signos de exclamación, emojis positivos, hipérboles
      authority:  pronombres formales / institucionales
      persuasion: imperativos, llamados a acción
      urgency:    presión temporal
    """
    if not text or len(text.strip()) < 2:
        return {"formality": 0.5, "enthusiasm": 0, "authority": 0.5, "persuasion": 0, "urgency": 0,
                "readability": {"flesch": None, "complexity": None}, "length_chars": 0, "length_words": 0}

    text_low = text.lower()
    words = re.findall(r"\w+", text_low)
    n_words = max(len(words), 1)
    lang = lang if lang in ("es", "en") else "en"

    # Enthusiasm
    n_excl = text.count("!")
    n_emoji = sum(1 for ch in text if ch in emoji_lib.EMOJI_DATA)
    enthusiasm = min(1.0, (n_excl * 0.25) + (n_emoji * 0.15))

    # Persuasion
    n_persuasion = _count_any(text_low, PERSUASION_WORDS[lang])
    has_imperative = bool(re.search(r"\b(?:descubr[íi]?|prueb[áa]?|compr[áa]?|hac[ée]l[oa]?|try|get|buy|grab|join)\b", text_low))
    persuasion = min(1.0, n_persuasion * 0.3 + (0.4 if has_imperative else 0))

    # Urgency
    n_urgency = _count_any(text_low, URGENCY_WORDS[lang])
    urgency = min(1.0, n_urgency * 0.4)

    # Formality (-formal +informal → invertimos)
    informal_hits = _count_any(text_low, INFORMAL_MARKERS[lang])
    formal_hits = _count_any(text_low, FORMAL_MARKERS[lang])
    has_excl_or_emoji = (n_excl + n_emoji) > 0
    informal_score = informal_hits * 0.3 + (0.2 if has_excl_or_emoji else 0)
    formal_score = formal_hits * 0.3
    formality = max(0.0, min(1.0, 0.5 + (formal_score - informal_score) * 0.5))

    # Authority (uso de "nosotros", "we", marcas mayúsculas)
    n_we = len(re.findall(r"\b(?:we|our|us|nosotros|nuestros?|nuestras?)\b", text_low))
    n_caps_words = sum(1 for w in re.findall(r"\b[A-Z]{2,}\b", text) if len(w) > 1)
    authority = max(0.0, min(1.0, 0.4 + n_we * 0.1 + n_caps_words * 0.05))

    # Readability (textstat es EN-biased pero da signal en cualquier latin script)
    try:
        flesch = round(textstat.flesch_reading_ease(text), 2)
    except Exception:
        flesch = None
    complexity = round(len(words) / max(text.count(".") + text.count("!") + text.count("?"), 1), 2)

    return {
        "formality": round(formality, 3),
        "enthusiasm": round(enthusiasm, 3),
        "authority": round(authority, 3),
        "persuasion": round(persuasion, 3),
        "urgency": round(urgency, 3),
        "readability": {"flesch": flesch, "complexity": complexity},
        "length_chars": len(text),
        "length_words": n_words,
        "emoji_count": n_emoji,
        "exclamation_count": n_excl,
    }
