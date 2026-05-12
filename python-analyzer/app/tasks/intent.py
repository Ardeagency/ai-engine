"""Buying intent / call-to-action detection — keyword + regex (sin modelo)."""
import re

BUYING_PATTERNS = {
    "es": [
        r"\b(?:compr[áa]r?|adquirir|consigu[íi]r|d[óo]nde\s+(?:lo|la)?\s*compr[áao])\b",
        r"\b(?:precio|cu[áa]nto\s+(?:cuesta|vale)|oferta|descuento)\b",
        r"\b(?:disponible|en\s+stock|env[íi]o\s+gratis)\b",
        r"\b(?:link\s+en\s+bio|swipe\s+up|men[úu]\s+stories)\b",
        r"\b(?:tienda|shop|carrito)\b",
    ],
    "en": [
        r"\b(?:buy|purchase|where\s+to\s+(?:buy|get|find)|order|shop\s+now)\b",
        r"\b(?:price|how\s+much|cost|sale|deal|discount|off)\b",
        r"\b(?:available|in\s+stock|free\s+shipping|delivery)\b",
        r"\b(?:link\s+in\s+bio|swipe\s+up|tap\s+to\s+shop|use\s+code)\b",
        r"\b(?:store|cart|checkout)\b",
    ],
}

CTA_PATTERNS = [
    r"\b(?:click|tap|swipe|comment|like|share|follow|subscribe|sign\s+up)\b",
    r"\b(?:dale|comparte|comenta|sigue|registr[áa]te|s[íi]guenos|suscr[íi]bete)\b",
    r"#\w+",  # hashtags como CTA implícito
]


def detect_intent(text: str, lang: str = "es") -> dict:
    """
    Devuelve { buying_intent: 0..1, cta_intent: 0..1, signals: [...] }
    """
    if not text:
        return {"buying_intent": 0.0, "cta_intent": 0.0, "signals": []}

    text_low = text.lower()
    lang_key = lang if lang in BUYING_PATTERNS else "en"
    signals = []
    buying_hits = 0
    for pat in BUYING_PATTERNS[lang_key]:
        if re.search(pat, text_low):
            buying_hits += 1
            signals.append(f"buy:{pat[:30]}")

    cta_hits = 0
    for pat in CTA_PATTERNS:
        if re.search(pat, text_low, re.IGNORECASE):
            cta_hits += 1

    buying_intent = min(1.0, buying_hits * 0.35)
    cta_intent = min(1.0, cta_hits * 0.20)

    return {"buying_intent": round(buying_intent, 3), "cta_intent": round(cta_intent, 3), "signals": signals[:8]}
