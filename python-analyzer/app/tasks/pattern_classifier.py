"""Pattern classifier determinístico — clasifica brand_posts en tone × topic × format × mood.

Reglas en cascada (más específica → más general). Sin LLM.
Inputs: brand_post + sentiment + emotion + tone_vector + intent + platform_native.
Output: { tone, topic, format, mood, *_confidence }
"""
import re


# ── Learned vocabulary loader (auto-actualiza desde Supabase) ────────────────
import os, time, httpx
_LEARNED_CACHE = {"loaded_at": 0, "vocab_by_dim": {}}
_LEARNED_TTL_SEC = 600  # 10 min cache

def _load_learned_vocabulary():
    """Carga vocabulario activo desde Supabase. Cache 10min."""
    if time.time() - _LEARNED_CACHE["loaded_at"] < _LEARNED_TTL_SEC:
        return _LEARNED_CACHE["vocab_by_dim"]
    try:
        url = os.environ["SUPABASE_URL"] + "/rest/v1/learned_vocabulary"
        headers = {"apikey": os.environ["SUPABASE_SERVICE_KEY"],
                   "Authorization": f"Bearer {os.environ['SUPABASE_SERVICE_KEY']}"}
        with httpx.Client(timeout=5) as cli:
            r = cli.get(url, headers=headers, params={
                "status": "eq.active",
                "select": "word,dimension,suggested_value",
            })
            rows = r.json() if r.status_code == 200 else []
        out = {}
        for row in rows:
            dim = row["dimension"]
            sug = row["suggested_value"]
            out.setdefault(dim, {}).setdefault(sug, set()).add(row["word"].lower())
        _LEARNED_CACHE["vocab_by_dim"] = out
        _LEARNED_CACHE["loaded_at"] = time.time()
        return out
    except Exception as e:
        print(f"[classifier] learned vocab load failed: {e}")
        return _LEARNED_CACHE.get("vocab_by_dim") or {}


def _check_learned_vocab(text_low: str, dimension: str) -> tuple[str, float] | None:
    """Si hay match en vocabulario aprendido, retorna (suggested_value, confidence)."""
    learned = _load_learned_vocabulary()
    dim_dict = learned.get(dimension) or {}
    for value, words in dim_dict.items():
        hits = sum(1 for w in words if w in text_low)
        if hits >= 2:  # 2+ palabras del mismo cluster aprendido
            return (value, min(1.0, 0.6 + hits * 0.1))
    return None


# ── DICCIONARIOS (ES + EN) ──────────────────────────────────────────────────
# Mantener equilibrio: cada concepto debe tener ≥3 términos por idioma porque
# competidores globales (Nike/Coca-Cola/Liquid Death/Monster/Red Bull) postean
# en inglés mientras nuestros clientes locales en español. Sin esto, los EN
# caen al default "casual/informativo" y perdemos señal de tono y tema.

CONFRONTATIONAL_WORDS = {
    # ES
    "contra", "versus", "no es verdad", "es hora de", "basta", "déjate de",
    # EN
    "vs", "against", "fight", "challenge", "ridiculous", "wrong", "false",
    "fake", "misleading", "shame", "stop", "wake up", "enough", "call out",
    "expose", "no more", "break the", "tired of", "say no",
}
IRONIC_MARKERS = {
    # ES
    "claro que", "sí, claro", "no me digas", "qué casualidad", "obviamente",
    # EN
    "obviously", "yeah right", "great job", "wonderful", "amazing", "perfect",
    "of course", "what a surprise", "shocking", "who would have thought",
    "totally normal", "real mature",
}
NOSTALGIC_MARKERS = {
    # ES
    "te acuerdas", "antiguos", "los noventas", "los 90", "los 2000",
    "como en los", "throwback", "memorias",
    # EN
    "remember when", "back in the day", "tbt", "throwback", "those were",
    "old school", "classic", "original", "the good old", "vintage",
    "nostalgia", "way back", "decades ago",
}
ASPIRATIONAL_MARKERS = {
    # ES
    "élite", "premium", "lujo", "exclusivo", "edición limitada", "para los que",
    "supera tus", "sé el mejor", "alcanza", "logra", "conviértete",
    # EN
    "live the", "be the", "achieve", "become", "luxury", "luxe", "exclusive",
    "limited edition", "elite", "premium", "be your best", "unleash",
    "push limits", "rise above", "next level", "world class", "legendary",
    "iconic", "greatness", "champion", "winning", "be more", "go further",
    "transcend", "elevate",
}
INTIMATE_MARKERS = {
    # ES
    "siento", "me cuesta", "vulnerab", "personal", "verdad sea dicha",
    "para ser sincero", "entre tú y yo", "lo confieso", "me cuesta admitir",
    # EN
    "i feel", "honestly", "vulnerab", "between us", "personal", "real talk",
    "tbh", "to be honest", "truth is", "i'll admit", "deep down",
    "from the heart", "no filter",
}
FUN_FACT_MARKERS = {
    # ES
    "sabías", "según", "estudios", "estadística", "dato curioso", "datos:",
    "investigaciones", "los expertos", "se ha demostrado",
    # EN
    "did you know", "fun fact", "data:", "studies show", "research shows",
    "fact:", "according to", "scientists found", "new study", "experts say",
    "stats", "actually,",
}
TUTORIAL_MARKERS = [
    r"\bstep\s*\d", r"\bpaso\s*\d", r"^\d+\.\s", r"\bfirst\b.*\bthen\b",
    r"\bprimero\b.*\bluego\b", r"\bhow\s+to\b", r"\bcómo\b", r"\btutorial\b",
    r"\bguide\b", r"\bguía\b", r"\bhere\'s\s+how\b", r"\baquí\s+te\s+muestro\b",
    r"\beasy\s+steps\b", r"\bpasos\s+fáciles\b",
]
PROMO_MARKERS = [
    r"\d+%\s*(off|descuento|dto)", r"\$\d+", r"\bsale\b", r"\boferta\b",
    r"\bcupón\b", r"\bcoupon\b", r"\bnow\s+only\b", r"\bedición\s+limitada\b",
    r"\bblack\s+friday\b", r"\bcyber\s+monday\b",
    r"\bdeals?\b", r"\bdiscount\b", r"\bfree\s+shipping\b", r"\bbuy\s+now\b",
    r"\bshop\s+now\b", r"\bcompra\s+ya\b", r"\bdisponible\s+ya\b",
    r"\blimited\s+time\b", r"\btiempo\s+limitado\b", r"\bdrops?\b",
    r"\bavailable\s+(today|now|on)\b",
]
COMPARISON_MARKERS = [
    r"\bvs\b", r"\bversus\b", r"\bA\s+vs\s+B\b", r"\bbetter\s+than\b",
    r"\bmejor\s+que\b", r"\bunlike\b", r"\ba\s+diferencia\s+de\b",
    r"\bcompared\s+to\b", r"\bin\s+comparison\b", r"\boutperforms?\b",
    r"\bbeats?\b\s+\w+", r"\bsupera\b", r"\bgana\s+contra\b",
]
COMEDY_MARKERS = {
    # ES
    "jaja", "jeje", "broma", "humor", "muerto de risa", "qué bobada",
    "estoy muerto", "no puedo más", "me mató",
    # EN
    "lol", "lmao", "lmfao", "rofl", "haha", "🤣", "😂", "💀", "💀💀",
    "prank", "joke", "comedy", "i can't", "i'm dead", "killed me",
    "no way", "this is gold", "send help", "weird flex",
}
EVENT_LIVE_MARKERS = {
    # ES
    "en vivo", "ahora mismo", "hoy", "esta noche", "este fin",
    "festival", "concierto", "evento", "carrera de hoy", "partido de hoy",
    # EN
    "live", "happening now", "right now", "today only", "tonight",
    "this weekend", "festival", "concert", "race day", "game day",
    "game time", "tipoff", "kickoff", "tip-off", "matchday",
    "watch live", "streaming now", "GP", "f1 race",
}
PARTNERSHIP_MARKERS = {
    # ES
    "con @", "junto a", "presentado por", "alianza con", "en colaboración",
    "colab", "x@", "feat",
    # EN
    "x ", " x ", "with @", "feat", "ft.", "powered by", "in partnership",
    "presented by", "collab", "collaboration with", "presents",
    "teaming up", "alongside", "brought to you by",
}
SPORT_EXTREME_TOKENS = {
    # Sport extremo
    "snowboard", "skate", "surf", "downhill", "freeride", "extreme",
    "skydive", "wingsuit", "parkour", "bmx", "motocross", "drift",
    "cliff", "vert", "trick", "stunt", "racing", "rally", "f1", "moto",
    # Mainstream sports (EN) — Nike/Coca-Cola los usan mucho
    "basketball", "football", "soccer", "tennis", "baseball", "nba", "nfl",
    "fifa", "world cup", "champions league", "olympic", "olympics",
    "athlete", "training", "workout", "match", "tournament", "playoffs",
    "finals", "grand slam", "marathon", "sprint", "championship",
    # Mainstream sports (ES)
    "baloncesto", "fútbol", "tenis", "béisbol", "mundial", "champions",
    "olímpicos", "atleta", "entrenamiento", "partido", "torneo", "maratón",
}
LIFESTYLE_MARKERS = {
    # ES
    "rutina", "vibras", "estado de ánimo", "energía", "bienestar",
    "autocuidado", "equilibrio", "consciente", "cotidiano", "día a día",
    # EN
    "morning routine", "vibe", "vibes", "mood", "energy", "wellness",
    "self care", "balance", "mindful", "everyday", "lifestyle",
    "daily", "rituals", "wellbeing", "feel good", "good vibes",
    "self-love", "main character", "soft life",
}
TESTIMONIAL_MARKERS = [
    # ES
    r"\b(verified|comprado|cliente)\b", r"\breview\b", r"\bopin\w+",
    r"\b(yo\s+lo|yo\s+la)\s+probé\b", r"\b(highly\s+recommend|recomiendo)\b",
    # EN
    r"\b5\s*stars?\b", r"\b\d{4,}\s*reviews?\b", r"\bi\s+tried\b",
    r"\bi\s+tested\b", r"\bworth\s+(the|every)\b", r"\bgame\s+changer\b",
    r"\blife\s+changing\b", r"\bobsess(ed|ing)\b",
    r"\b(buy|get)\s+this\b", r"\bafter\s+\d+\s+(weeks|months|days)\b",
]

# ── Triggers de tono celebratorio/alegre/entusiasta (EN+ES) ─────────────────
# Antes solo cabía en "default casual" porque ninguna regla matcheaba estos
# posts típicos de marca (felicitaciones a deportistas, lanzamientos hype, etc.)
CELEBRATORY_MARKERS = {
    # ES
    "felicidades", "felicitaciones", "lo lograron", "campeones", "victoria",
    "triunfo", "ganadores", "icónico", "histórico", "increíble",
    # EN
    "congrats", "congratulations", "champions", "victory", "wins", "winners",
    "iconic", "historic", "legendary", "incredible", "amazing",
    "the goat", "g.o.a.t", "best ever", "record-breaking", "world record",
    "first ever", "made history",
}
HYPE_MARKERS = {
    # ES
    "no puedes perdértelo", "imperdible", "épico", "alucinante", "brutal",
    # EN
    "let's go", "let's gooo", "let's f-ing go", "lfg", "hype", "fire",
    "insane", "crazy", "wild", "next level", "unreal", "this is huge",
    "world class", "absolutely",
}

# ── Triggers de TONO conversacional/cercano/curioso (EN+ES) ──────────────────
# Antes todo post que hablaba directo a la audiencia o hacía una pregunta caía
# al default "casual". Estos capturan la voz cercana típica de marcas de consumo
# (comida, bebida, lifestyle) que interpelan al seguidor.
CONVERSATIONAL_MARKERS = {
    # ES
    "cuéntame", "cuéntanos", "y tú", "¿tú", "qué opinas", "déjanos saber",
    "déjame saber", "dinos", "adivina", "te cuento", "hablemos",
    "comenta abajo", "comenta si", "etiqueta a", "etiqueta a alguien",
    # EN
    "let me know", "let us know", "tell me", "tell us", "what do you think",
    "you know what", "guess what", "let's talk", "drop a", "comment below",
    "comment if", "who else", "raise your hand", "tag someone", "tag a friend",
    "be honest",
}
CURIOUS_MARKERS = {
    # ES
    "sabías que", "te has preguntado", "imagínate", "adivina qué",
    "el secreto", "lo que no sabías", "descubre", "misterio", "por qué",
    # EN
    "did you know", "ever wondered", "imagine if", "the secret",
    "what you didn't know", "here's why", "the reason why", "guess what happens",
    "plot twist", "fun fact",
}

# ── Triggers de TEMA food / CPG / bienestar (EN+ES) ──────────────────────────
# La taxonomía nació orientada a marcas globales de deporte/hype y no tenía
# NADA de comida/consumo, así que recetas, claims de salud e ingredientes caían
# todos a "informativo". Estos son genéricos y sirven a cualquier marca de
# alimento, bebida, cuidado personal o wellness.
RECIPE_USE_MARKERS = {
    # ES
    "receta", "recetas", "ingredientes:", "prepara", "preparación",
    "úsalo en", "combínalo con", "combina con", "acompaña", "para untar",
    "hazlo en casa", "modo de uso", "cómo usar", "pruébalo con", "topping",
    # EN
    "recipe", "recipes", "how to make", "spread it on", "pair it with",
    "pairs with", "add it to", "add to your", "perfect with", "top it with",
    "try it with", "use it in", "homemade", "meal prep", "no-bake",
}
HEALTH_NUTRITION_MARKERS = {
    # ES
    "proteína", "proteínas", "sin azúcar", "sin azúcar añadida", "saludable",
    "natural", "vegano", "vegana", "keto", "sin gluten", "gluten free",
    "calorías", "fibra", "energía natural", "nutrición", "nutritivo",
    "bienestar", "sin conservantes", "orgánico", "bajo en",
    # EN
    "protein", "no sugar", "sugar free", "no added sugar", "healthy",
    "vegan", "plant based", "plant-based", "gluten free", "gluten-free",
    "calories", "fiber", "fibre", "nutrition", "nutritious", "wholesome",
    "clean energy", "no preservatives", "organic", "low in", "high in protein",
    "macros",
}
INGREDIENT_QUALITY_MARKERS = {
    # ES
    "ingredientes", "un solo ingrediente", "100%", "sin aditivos", "puro",
    "sin nada raro", "de verdad", "real", "materia prima", "sin químicos",
    "de origen", "hecho con", "elaborado con", "así se hace",
    # EN
    "ingredients", "single ingredient", "one ingredient", "no additives",
    "no fillers", "just peanuts", "just", "real ", "made with", "sourced",
    "farm to", "the good stuff", "nothing artificial", "clean label",
    "what's inside", "what's in it",
}
QUESTION_AUDIENCE_MARKERS = {
    # ES
    "¿cuál prefieres", "¿cuál es tu", "¿qué prefieres", "vota", "votación",
    "encuesta", "esto o aquello", "team ", "¿sí o no", "responde",
    "¿tú qué", "cuéntanos en", "opina",
    # EN
    "which one", "this or that", "would you rather", "vote", "poll",
    "pick one", "yes or no", "your favorite", "what's your", "a or b",
    "sound off", "let's settle",
}
SEASONAL_MARKERS = {
    # ES
    "navidad", "año nuevo", "halloween", "san valentín", "día de la madre",
    "día del padre", "día de", "temporada", "fiestas", "diciembre",
    "vacaciones", "regalo perfecto",
    # EN
    "christmas", "xmas", "new year", "halloween", "valentine", "mother's day",
    "father's day", "thanksgiving", "holiday season", "this season",
    "summer ", "back to school", "perfect gift", "gift guide",
}


def _has_any(text_low: str, words) -> int:
    """Return count of dict matches."""
    if isinstance(words, set):
        return sum(1 for w in words if w in text_low)
    return sum(1 for p in words if re.search(p, text_low, re.I))


def _has_any_regex(text: str, patterns) -> bool:
    return any(re.search(p, text, re.I) for p in patterns)


# ── CLASIFICADORES POR DIMENSIÓN ────────────────────────────────────────────

def classify_tone(post: dict) -> tuple[str, float]:
    """
    Devuelve (tone, confidence 0..1).
    Inputs esperados en `post`: content, tone_vector, sentiment, emotion, intent, platform_native.
    """
    text = post.get("content") or ""
    text_low = text.lower()
    tv = post.get("tone_vector") or {}
    sent = post.get("sentiment", {})
    emo = post.get("emotion", {})
    intent = post.get("intent", {})
    sentiment_score = sent.get("score") or 0
    sentiment_label = sent.get("label") or "NEU"
    dominant_emo = (emo.get("dominant") or "").lower()
    persuasion = tv.get("persuasion", 0)
    urgency = tv.get("urgency", 0)
    enthusiasm = tv.get("enthusiasm", 0)
    formality = tv.get("formality", 0.5)
    authority = tv.get("authority", 0.5)

    # Orden de prioridad: específicos primero, urgente/casual al final como red.
    # Antes "urgente" estaba en #1 con threshold bajo (urgency>0.5 OR buying>0.5)
    # → atrapaba todo post con "new"/"buy"/"drops". Lo bajamos al final y
    # subimos su exigencia (urgency>0.7 Y otra señal).

    # 1. Confrontacional / Provocador (Liquid Death cuando responde acusaciones)
    confront = _has_any(text_low, CONFRONTATIONAL_WORDS)
    if confront >= 2 or (confront >= 1 and sentiment_score < -0.4):
        return ("confrontacional", min(1.0, 0.5 + confront * 0.15))

    # 2. Irónico / Sarcástico
    ironic_hits = _has_any(text_low, IRONIC_MARKERS)
    if ironic_hits >= 1 and (sentiment_label == "NEG" or sentiment_score < -0.3):
        if "💀" in text or "🙄" in text or "😏" in text:
            return ("sarcástico", 0.78)
        return ("irónico", 0.72)

    # 3. Nostálgico
    if _has_any(text_low, NOSTALGIC_MARKERS) >= 1:
        return ("nostálgico", 0.80)

    # 4. Íntimo (primera persona, founder talk, vulnerable)
    # SUBIDO antes de urgente: "Hi Tim. It's Mike the LD founder" no es urgente.
    intim_hits = _has_any(text_low, INTIMATE_MARKERS)
    if intim_hits >= 1:
        return ("íntimo", min(1.0, 0.7 + intim_hits * 0.1))

    # 5. Celebratorio (felicitación a deportista, victoria, hito histórico)
    # SUBIDO: marcas postean MUCHO celebraciones de atletas/equipos.
    cele_hits = _has_any(text_low, CELEBRATORY_MARKERS)
    if cele_hits >= 1 and sentiment_score > 0.15:
        return ("celebratorio", min(1.0, 0.65 + cele_hits * 0.1))

    # 6. Aspiracional (premium/elite/luxury)
    if _has_any(text_low, ASPIRATIONAL_MARKERS) >= 1:
        return ("aspiracional", 0.75)

    # 7. Humorístico
    if dominant_emo in ("amusement",) or _has_any(text_low, COMEDY_MARKERS) >= 2:
        return ("humorístico", 0.80)

    # 8. Motivacional (persuasión + positivo)
    if persuasion > 0.5 and sentiment_score > 0.3:
        return ("motivacional", 0.72)

    # 9. Optimista (sentiment alto + future-oriented)
    if sentiment_score > 0.6 and any(w in text_low for w in ["future", "futuro", "tomorrow", "mañana", "we will", "iremos", "we can", "podemos"]):
        return ("optimista", 0.82)

    # 10. Alegre (emotion=joy + enthusiasm + sentiment +)
    if dominant_emo == "joy" or (enthusiasm > 0.5 and sentiment_score > 0.4):
        return ("alegre", 0.75)

    # 11. Entusiasta (hype/fire markers)
    hype_hits = _has_any(text_low, HYPE_MARKERS)
    if hype_hits >= 1:
        return ("entusiasta", min(1.0, 0.65 + hype_hits * 0.1))

    # 12. Urgente: BAJADO al final + threshold más exigente.
    # Antes: urgency>0.5 OR buying>0.5 (sobre-disparaba). Ahora: urgency>0.7
    # OR (buying>0.6 Y promo/launch keywords). Posts genéricos con "new"/"buy"
    # caerán mejor en producto_launch o promo_oferta.
    has_promo_signal = bool(re.search(r"\b(buy now|shop now|sale|oferta|drops?|now only)\b", text_low))
    if urgency > 0.7 or (intent.get("buying_intent", 0) > 0.6 and has_promo_signal):
        return ("urgente", 0.85)

    # 11. Educativo (formal + alta autoridad sin push de venta)
    if formality > 0.55 and authority > 0.5 and intent.get("buying_intent", 0) < 0.3:
        return ("educativo", 0.70)

    # 12. Autoritario (formal alta + urgency)
    if formality > 0.7:
        return ("autoritario", 0.65)

    # 13. Provocador (sentiment muy positivo o muy negativo, controversial)
    if abs(sentiment_score) > 0.7 and intent.get("cta_intent", 0) > 0.3:
        return ("provocador", 0.60)

    # 14. Curioso / intriga (teaser, "sabías que", plot twist) — antes → casual.
    if _has_any(text_low, CURIOUS_MARKERS) >= 1:
        return ("curioso", 0.68)

    # 15. Conversacional / cercano (habla directa, pregunta a la audiencia).
    # Rescata la voz de marca de consumo que interpela al seguidor; sin esto
    # todo caía a "casual" y el dashboard mostraba un solo tono dominante.
    convo = _has_any(text_low, CONVERSATIONAL_MARKERS)
    if convo >= 1 or (text.count("?") + text.count("¿")) >= 2:
        return ("conversacional", min(0.80, 0.6 + convo * 0.1))

    # Antes del default: revisar vocabulario aprendido
    learned = _check_learned_vocab(text_low, "tone")
    if learned:
        return learned

    # Default: casual
    return ("casual", 0.50)


def classify_topic(post: dict, network: str) -> tuple[str, float]:
    text = post.get("content") or ""
    text_low = text.lower()
    intent = post.get("intent", {})
    pn = post.get("platform_native", {})

    # 0. Deportes (atletas, equipos, partidos) — PRIORIDAD ALTA porque
    # Nike/Coca-Cola/Monster/Red Bull postean MUCHO sobre deportistas y
    # sino caía al default "informativo".
    sport_hits = _has_any(text_low, SPORT_EXTREME_TOKENS)
    if sport_hits >= 2:
        return ("deportes", min(1.0, 0.6 + sport_hits * 0.1))

    # 1. Promo / Oferta (requiere PROMO_MARKERS explícito, no solo buying_intent)
    promo_hit = _has_any(text_low, PROMO_MARKERS) if isinstance(PROMO_MARKERS, set) else _has_any_regex(text, PROMO_MARKERS)
    if promo_hit >= 1 or (intent.get("buying_intent", 0) > 0.7 and "$" in text):
        return ("promo_oferta", 0.85)

    # 1b. Fecha especial / temporada (navidad, san valentín, back to school…).
    # Antes del launch/producto porque un post estacional es su propia categoría.
    if _has_any(text_low, SEASONAL_MARKERS) >= 1:
        return ("fecha_especial", 0.78)

    # 2. Producto / Launch
    if any(w in text_low for w in [
        "new ", "launching", "drops", "available", "now available",
        "introducing", "presenting", "meet the", "say hello to",
        "lanzamos", "estrenamos", "presentando", "te presentamos",
        "ya disponible", "nuevo en", "esta colección", "this collection",
    ]):
        return ("producto_launch", 0.80)

    # 2b. Receta / uso del producto (comida, bebida, cuidado personal).
    # Va antes de tutorial: una receta es más específica que un how-to genérico.
    if _has_any(text_low, RECIPE_USE_MARKERS) >= 1:
        return ("receta_uso", 0.82)

    # 3. Tutorial
    if _has_any_regex(text, TUTORIAL_MARKERS):
        return ("tutorial", 0.85)

    # 3b. Salud / Nutrición (proteína, sin azúcar, vegano, calorías…).
    if _has_any(text_low, HEALTH_NUTRITION_MARKERS) >= 1:
        return ("salud_nutricion", 0.80)

    # 3c. Ingredientes / Calidad (qué lleva, un solo ingrediente, sin aditivos).
    if _has_any(text_low, INGREDIENT_QUALITY_MARKERS) >= 2:
        return ("ingredientes_calidad", 0.78)

    # 4. Datos curiosos / Fun facts
    if _has_any(text_low, FUN_FACT_MARKERS) >= 1:
        return ("datos_curiosos", 0.85)

    # 5. Comparación
    if _has_any_regex(text, COMPARISON_MARKERS):
        return ("comparison", 0.78)

    # 6. Behind the scenes
    if any(w in text_low for w in [
        "behind the scenes", "bts", "tras bambalinas", "making of", "process",
        "proceso", "detrás de cámaras", "detras de camaras", "así se hace",
        "asi se hace", "cómo se hace", "como se hace", "how it's made",
        "en la planta", "en la fábrica", "en la fabrica",
    ]):
        return ("behind_scenes", 0.80)

    # 7. Partnership
    if _has_any(text_low, PARTNERSHIP_MARKERS) >= 1 or any(t in text_low for t in [" x ", " ft "]):
        return ("partnership", 0.70)

    # 8. UGC / Repost
    if "regram" in text_low or "📍:" in text or "📷:" in text or "video by" in text_low or "via @" in text_low:
        return ("ugc_repost", 0.75)

    # 9. Evento / Live
    if _has_any(text_low, EVENT_LIVE_MARKERS) >= 1:
        return ("evento_live", 0.78)

    # 10. Deportes extremos
    sport_hits = _has_any(text_low, SPORT_EXTREME_TOKENS)
    if sport_hits >= 1:
        return ("deportes_extremos", min(1.0, 0.5 + sport_hits * 0.15))

    # 11. Comedia / pranks
    if _has_any(text_low, COMEDY_MARKERS) >= 2 or "prank" in text_low:
        return ("comedia_pranks", 0.75)

    # 11b. Pregunta a la audiencia / interactivo (encuesta, "cuál prefieres",
    # "esto o aquello"). Motor de engagement universal; antes → informativo.
    if _has_any(text_low, QUESTION_AUDIENCE_MARKERS) >= 1:
        return ("pregunta_audiencia", 0.75)

    # 12. Comunidad / fans
    if any(w in text_low for w in [
        "fam", "community", "comunidad", "fans", "you guys", "ustedes",
        "todos vamos", "shoutout", "shout out", "thank you all", "gracias a todos",
        "our community", "you all", "the team",
    ]):
        return ("comunidad_fans", 0.65)

    # 12b. Deportes (single hit) — fallback si solo 1 token de SPORT (la #0 ya
    # capturó los multi-hit con más confianza).
    if _has_any(text_low, SPORT_EXTREME_TOKENS) >= 1:
        return ("deportes", 0.65)

    # 13. Testimonial
    if _has_any_regex(text, TESTIMONIAL_MARKERS):
        return ("testimonial", 0.70)

    # 14. Lifestyle
    if _has_any(text_low, LIFESTYLE_MARKERS) >= 1:
        return ("lifestyle", 0.65)

    # 15. Call to action puro
    if intent.get("cta_intent", 0) > 0.5:
        return ("call_to_action", 0.70)

    # Antes del default: revisar vocabulario aprendido
    learned = _check_learned_vocab(text_low, "topic")
    if learned:
        return learned

    # Default: informativo
    return ("informativo", 0.55)


def classify_format(post: dict, network: str) -> str:
    """Determinístico desde metadata."""
    pn = post.get("platform_native", {})
    if not isinstance(pn, dict):
        pn = {}
    media = post.get("media_assets", {})
    # media_assets puede venir como lista de assets (reels/carruseles de IG:
    # [{type, permalink}, ...]) o como dict. Normalizamos a dict para que los
    # .get() de abajo no revienten ('list' object has no attribute 'get').
    if isinstance(media, list):
        media = {"images": media}
    elif not isinstance(media, dict):
        media = {}

    if network == "tiktok":
        # Detectar baile/sound trending
        music = (pn.get("tiktok") or {}).get("music") or {}
        if music.get("is_original") is False and post.get("engagement_total", 0) > 100_000:
            return "reel_baile"
        return "short_video"

    if network == "youtube":
        # Duración determina format
        dur = (media.get("duration") or "")
        # Parsing simple "MM:SS" o "HH:MM:SS"
        try:
            parts = [int(p) for p in dur.split(":")]
            secs = parts[-1] + (parts[-2] * 60 if len(parts) >= 2 else 0) + (parts[-3] * 3600 if len(parts) >= 3 else 0)
            return "short_video" if secs <= 60 else "long_video"
        except Exception:
            return "long_video"

    if network == "instagram":
        ig = pn.get("instagram") or {}
        ptype = (ig.get("product_type") or "").upper()
        if ptype == "REEL":
            # Si tiene música original o trend → baile/sound
            if ig.get("music_info"):
                return "reel_baile"
            return "short_video"
        if ptype == "STORY":
            return "story_temporal"
        # Carrusel?
        imgs = media.get("images") or []
        if len(imgs) > 1 or len(ig.get("child_posts") or []) > 1:
            return "carrusel_imgs"
        # Detectar tutorial-as-carrusel
        if _has_any_regex(post.get("content") or "", TUTORIAL_MARKERS):
            return "tutorial_steps"
        return "single_image"

    if network == "x":
        # X puede tener video o solo texto/imagen
        media_arr = (pn.get("x") or {}).get("media") or []
        if media_arr:
            mtype = media_arr[0].get("type") if isinstance(media_arr[0], dict) else ""
            if mtype == "video":
                return "short_video"
            return "single_image"
        return "single_image"  # texto solo se trata como single

    if network == "facebook":
        if (post.get("metrics") or {}).get("plays", 0) > 0 or (pn.get("facebook") or {}).get("flags", {}).get("is_video"):
            return "short_video"
        return "single_image"

    return "single_image"


def classify_mood(post: dict, tone: str, topic: str) -> str:
    """Mood derivado de tone + emotion + intent."""
    emo = post.get("emotion", {})
    sent_score = (post.get("sentiment") or {}).get("score") or 0
    enthusiasm = (post.get("tone_vector") or {}).get("enthusiasm") or 0

    dominant = (emo.get("dominant") or "").lower()
    # Reglas
    if tone in ("urgente", "promo_oferta") or topic == "evento_live": return "energético"
    if tone == "nostálgico": return "nostálgico"
    if tone in ("confrontacional", "provocador"): return "confrontante"
    if tone == "humorístico" or dominant == "amusement": return "divertido"
    if tone == "motivacional" or tone == "optimista": return "inspirador"
    if tone == "curioso": return "intrigante"
    if topic in ("tutorial", "informativo", "datos_curiosos", "receta_uso", "salud_nutricion", "ingredientes_calidad") and tone in ("educativo", "conversacional"): return "técnico"
    if dominant == "joy" and sent_score > 0.6: return "celebratorio"
    if topic == "behind_scenes" or tone == "íntimo": return "emotivo"
    if topic == "comparison" or tone in ("autoritario",): return "intrigante"
    if enthusiasm < 0.3 and sent_score < 0.3: return "calmo"
    return "divertido" if enthusiasm > 0.5 else "calmo"


def classify_post(brand_post_row: dict) -> dict:
    """
    Entry point. Toma un row de brand_posts (con enrichment poblado) y devuelve patrón.

    Espera campos:
      - content, network, metrics, engagement_total, followers_snapshot
      - sentiment_score (number), sentiment (jsonb), tone (string ya calculado por analyzer v1)
      - enrichment.tone_vector, enrichment.intent, enrichment.platform_native
    """
    network = brand_post_row.get("network")
    enrichment = brand_post_row.get("enrichment") or {}
    sentiment_inner = (brand_post_row.get("sentiment") or {})
    # El brand_posts.sentiment es jsonb con label,score,probas,emotion,intent,impact
    emo_obj = sentiment_inner.get("emotion") or {}
    intent_obj = sentiment_inner.get("intent") or {}
    impact_obj = sentiment_inner.get("impact") or {}

    enriched = {
        "content": brand_post_row.get("content") or "",
        "tone_vector": enrichment.get("tone_vector") or {},
        "sentiment": {
            "label": sentiment_inner.get("label"),
            "score": sentiment_inner.get("score") if sentiment_inner.get("score") is not None else brand_post_row.get("sentiment_score"),
        },
        "emotion": emo_obj,
        "intent": intent_obj,
        "platform_native": enrichment.get("platform_native") or {},
        "media_assets": brand_post_row.get("media_assets") or {},
        "metrics": brand_post_row.get("metrics") or {},
        "engagement_total": brand_post_row.get("engagement_total") or 0,
    }

    tone, t_conf = classify_tone(enriched)
    topic, top_conf = classify_topic(enriched, network)
    fmt = classify_format(enriched, network)
    mood = classify_mood(enriched, tone, topic)

    # Engagement rate normalized
    followers = brand_post_row.get("followers_snapshot") or 0
    eng_total = brand_post_row.get("engagement_total") or 0
    eng_rate = (eng_total / followers) if followers > 0 else 0

    return {
        "tone": tone,
        "topic": topic,
        "format": fmt,
        "mood": mood,
        "tone_confidence": t_conf,
        "topic_confidence": top_conf,
        "engagement_total": eng_total,
        "engagement_rate": round(eng_rate, 5),
        "sentiment_score": brand_post_row.get("sentiment_score"),
        "impact_score": (impact_obj.get("impact_score") if isinstance(impact_obj, dict) else None),
        "reach": (brand_post_row.get("metrics") or {}).get("views") or (brand_post_row.get("metrics") or {}).get("plays") or 0,
        "followers_at_capture": followers,
    }
