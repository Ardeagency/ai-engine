"""Señal de demanda de la audiencia — clasifica la INTENCION de un comentario
(reglas + keywords, SIN LLM en el hot path). Complementa a sentiment.py: donde el
sentimiento mira polaridad, esto mira QUE quiere la audiencia. La clave del negocio:
un comentario de un competidor rara vez es "queja" — suele ser demanda insatisfecha
(no lo encuentro / cuando llega a mi pais) o peticion de producto (ojala fuera sin
gluten). Eso es inteligencia de oportunidad, no negatividad.

detect_audience_signal(text, lang) -> {"signal": <cat>|None, "confidence": float, "cue": str|None}
Categorias: demanda_distribucion | peticion_producto | amor_marca | queja | pregunta | None

Precedencia (una sola categoria por comentario): queja > demanda_distribucion >
peticion_producto > amor_marca > pregunta. La queja gana para no disfrazar una queja
real de oportunidad; luego la oportunidad (demanda/peticion) gana sobre el elogio.
"""
import re
import unicodedata as _ud

def _strip_accents(s):
    return "".join(c for c in _ud.normalize("NFD", s) if _ud.category(c) != "Mn")

def _norm(text):
    """minusculas, sin tildes, alargamientos colapsados: 'buenisimooo'->'buenisimo'."""
    return re.sub(r"(.)\1{2,}", r"\1", _strip_accents(str(text or "").lower()))

# ── QUEJA real: calidad / servicio / precio con molestia (unico negativo) ────────
QUEJA = (
    "no vuelvo a comprar", "no lo vuelvo a comprar", "nunca mas", "pesimo", "pesima",
    "horrible", "asqueroso", "que asco", "un asco", "malisimo", "malisima", "muy malo",
    "muy mala", "no sirve", "no funciona", "decepcion", "decepcionad", "estafa", "estafaron",
    "fraude", "timo", "robo", "roban", "basura", "porqueria", "verguenza", "lo peor",
    "peor compra", "llego roto", "llego dañado", "llego malo", "vino roto", "mal servicio",
    "pesima calidad", "mala calidad", "muy caro para", "carisimo", "sobrevalorado",
    "no lo recomiendo", "no la recomiendo", "waste of money", "terrible", "awful", "scam",
    "ripoff", "worst", "disgusting", "never again", "broke", "broken", "refund",
)

# ── DEMANDA no cubierta / distribucion: lo quieren pero no lo consiguen ───────────
DEMANDA = (
    "no lo encuentro", "no la encuentro", "no los encuentro", "no las encuentro",
    "no encuentro", "no consigo", "no lo consigo", "no la consigo", "no lo he encontrado", "no la he encontrado",
    "no la he podido encontrar", "no lo he podido encontrar", "no los he visto",
    "no lo he visto", "no la he visto", "donde lo consigo", "donde la consigo",
    "donde lo compro", "donde la compro", "donde lo venden", "donde se consigue",
    "donde puedo comprar", "donde puedo conseguir", "en que tiendas", "no queda",
    "ya no hay", "no hay en", "esta agotado", "estan agotados", "agotado", "sold out",
    "cuando llega a", "cuando llegan a", "cuando lo traen", "no llega a", "no ha llegado",
    "aun no llega", "todavia no llega", "llevo buscando", "llevo dias buscando",
    "no esta en", "no lo tienen en", "no lo venden en", "no vivo alla", "no vivo alli",
    "no estoy en", "en mi ciudad no", "en mi pais no", "aqui no llega", "aca no llega",
    "hasta cuando llega", "porfa traiganlo", "traiganlo a", "lo quiero pero no",
    # Distribucion / disponibilidad: la audiencia PIDE poder comprarlo
    "no los venden", "no lo venden", "no los vende", "no la venden", "no las venden",
    "por que no los venden", "porque no los venden", "como no los venden",
    "para cuando", "cuando vendran", "cuando los venden", "cuando los traen",
    "cuando llega", "vine a buscar", "vine a comprar", "vine a por", "vengo a comprar",
    "quiero comprarlo", "quiero comprarlos", "quiero comprarla", "quiero uno",
    "where to buy", "where can i", "out of stock", "not available", "cant find",
    "can't find", "when will it", "ship to", "available in",
)

# ── PETICION de producto: piden variante / feature / que vuelva algo ──────────────
PETICION = (
    "ojala fuera", "ojala tuviera", "ojala hicieran", "ojala sacaran", "ojala hubiera",
    "deberian hacer", "deberian sacar", "deberian tener", "podrian hacer", "podrian sacar",
    "seria bueno si", "seria mejor si", "estaria bueno", "hagan una", "hagan un",
    "saquen una", "saquen un", "que saquen", "que vuelvan", "que vuelva el", "que regrese",
    "porfavor que vuelvan", "quiero que saquen", "falta que", "hace falta",
    "please make", "wish it was", "wish it were", "should make", "bring back", "come back",
    "make a version", "need a", "we need a",
)
# Features de producto (para el 'cue' y como disparador de peticion cuando se
# mencionan en tono de deseo/carencia). "no es vegano" = piden que sea vegano.
FEATURES = {
    "sin gluten": ("sin gluten", "gluten free", "gluten-free"),
    "vegano": ("vegano", "vegana", "vegan", "no es vegano", "no es vegana"),
    "sin azucar": ("sin azucar", "sugar free", "sugar-free", "menos azucar"),
    "sin lactosa": ("sin lactosa", "lactose free", "deslactosad"),
    "keto": ("keto", "cetogenic"),
    "tamaño XL": ("tamaño xl", "tamano xl", "mas grande", "size xl", "familiar"),
    "sin conservantes": ("sin conservantes", "sin quimicos", "mas natural"),
}

# ── AMOR de marca: elogio / hype / defensa ───────────────────────────────────────
AMOR = (
    "amamos", "los amo", "las amo", "lo amo", "la amo", "amo esto", "amo este",
    "me encanta", "me encantan", "encanta", "obsesionad", "obsessed", "love this",
    "love it", "we love", "lo mejor", "la mejor", "el mejor", "brutal", "brutalisimo",
    "bestial", "una bestia", "tremendo", "una locura", "que locura", "chimba", "berraco",
    "verraco", "salvaje", "lo maximo", "buenisimo", "buenisima", "genial", "hermoso",
    "hermosa", "una belleza", "epico", "epica", "crack", "craack", "team ", "gracias por",
    "necesito esto en mi vida", "los admiro", "orgullo", "iconic", "iconico", "iconica",
    "the best", "so good", "amazing", "goat", "🐐",
)
AMOR_EMOJI = {"😍","🥰","😘","🤩","🔥","👏","💚","❤️","💖","💗","🙌","👑","💯","🥇","✨","💛","🧡","💜","💙"}

# Emojis de "lagrimas/ruego de emocion": SOLOS no definen la categoria (multiuso).
# Sirven de refuerzo cuando ya hay demanda/peticion/amor por el texto.
SOFT_EMOJI = {"😭","🥺","😩","🥹","🥲","😢"}

_QWORDS = ("cuando", "donde", "como", "cuanto", "que ", "cual", "quien", "hay ",
           "when", "where", "how", "what", "which", "does", "do you", "is it", "are")

def _hits(t, patterns):
    return [p for p in patterns if p in t]

def detect_audience_signal(text, lang="es"):
    raw = str(text or "")
    t = _norm(raw)
    if len(t.strip()) < 2:
        return {"signal": None, "confidence": 0.0, "cue": None}

    # 1) QUEJA real (gana: no disfrazar una queja de oportunidad)
    q = _hits(t, QUEJA)
    if q:
        return {"signal": "queja", "confidence": min(0.95, 0.6 + 0.1 * len(q)), "cue": None}

    # 2) DEMANDA no cubierta / distribucion
    d = _hits(t, DEMANDA)
    if d:
        conf = min(0.95, 0.6 + 0.1 * len(d))
        if any(e in raw for e in SOFT_EMOJI):
            conf = min(0.97, conf + 0.05)
        return {"signal": "demanda_distribucion", "confidence": round(conf, 3), "cue": None}

    # 3) PETICION de producto (por frase de deseo o por feature en tono de carencia)
    p = _hits(t, PETICION)
    feat_cue = None
    for label, variants in FEATURES.items():
        if any(v in t for v in variants):
            feat_cue = label
            break
    # "no es vegano" / "podria ser sin gluten" -> carencia de feature = peticion
    lacks_feature = feat_cue is not None and re.search(
        r"\b(no\s+es|no\s+tiene|no\s+trae|podria\s+ser|ojala|deberian|falta|sin\s+opcion)\b", t)
    if p or lacks_feature:
        conf = min(0.95, 0.6 + 0.1 * (len(p) + (1 if feat_cue else 0)))
        return {"signal": "peticion_producto", "confidence": round(conf, 3), "cue": feat_cue}
    # feature mencionada sola (ej. "sin gluten?") -> peticion suave con cue
    if feat_cue and ("?" in raw or feat_cue):
        return {"signal": "peticion_producto", "confidence": 0.55, "cue": feat_cue}

    # 4) AMOR de marca
    a = _hits(t, AMOR)
    ae = sum(1 for e in AMOR_EMOJI if e in raw)
    if a or ae >= 1:
        conf = min(0.95, 0.55 + 0.1 * (len(a) + ae))
        return {"signal": "amor_marca", "confidence": round(conf, 3), "cue": None}
    # Emocion desbordada (😭🥺😩) que YA paso los filtros de queja/demanda/peticion:
    # en un comentario de fan es adoracion/hype, no tristeza. Señal debil (contexto,
    # no el emoji solo). Si fuera queja o demanda, habria salido antes.
    if any(e in raw for e in SOFT_EMOJI):
        return {"signal": "amor_marca", "confidence": 0.5, "cue": None}

    # 5) PREGUNTA neutral (no cae en las anteriores)
    if "?" in raw or t.startswith(_QWORDS) or any(t.startswith(w) for w in _QWORDS):
        return {"signal": "pregunta", "confidence": 0.5, "cue": None}

    return {"signal": None, "confidence": 0.0, "cue": None}
