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


# ── DICCIONARIOS ────────────────────────────────────────────────────────────
CONFRONTATIONAL_WORDS = {
    "vs", "against", "contra", "versus", "fight", "challenge", "ridiculous",
    "wrong", "no es verdad", "false", "fake", "misleading", "shame",
    "stop", "basta", "es hora de", "wake up",
}
IRONIC_MARKERS = {
    "obviously", "claro que", "yeah right", "sí, claro", "no me digas",
    "great job", "wonderful", "amazing", "perfect", "of course"  # combinado con NEG
}
NOSTALGIC_MARKERS = {
    "remember when", "back in the day", "te acuerdas", "throwback", "tbt",
    "those were", "antiguos", "old school", "classic", "original",
}
ASPIRATIONAL_MARKERS = {
    "live the", "be the", "achieve", "become", "élite", "premium", "lujo",
    "luxury", "exclusive", "limited edition", "luxe",
}
INTIMATE_MARKERS = {
    "i feel", "siento", "me cuesta", "honestly", "vulnerab", "between us",
    "personal", "real talk", "verdad sea dicha",
}
FUN_FACT_MARKERS = {
    "did you know", "sabías", "fun fact", "data:", "según", "studies show",
    "research shows", "estudios", "estadística", "fact:",
}
TUTORIAL_MARKERS = [
    r"\bstep\s*\d", r"\bpaso\s*\d", r"^\d+\.\s", r"\bfirst\b.*\bthen\b",
    r"\bprimero\b.*\bluego\b", r"\bhow\s+to\b", r"\bcómo\b", r"\btutorial\b",
]
PROMO_MARKERS = [
    r"\d+%\s*(off|descuento|dto)", r"\$\d+", r"\bsale\b", r"\boferta\b",
    r"\bcupón\b", r"\bcoupon\b", r"\bnow\s+only\b", r"\bedición\s+limitada\b",
    r"\bblack\s+friday\b", r"\bcyber\s+monday\b",
]
COMPARISON_MARKERS = [
    r"\bvs\b", r"\bversus\b", r"\bA\s+vs\s+B\b", r"\bbetter\s+than\b",
    r"\bmejor\s+que\b", r"\bunlike\b", r"\ba\s+diferencia\s+de\b",
]
COMEDY_MARKERS = {
    "lol", "lmao", "haha", "jaja", "jeje", "🤣", "😂", "💀", "prank",
    "joke", "broma", "comedy", "humor",
}
EVENT_LIVE_MARKERS = {
    "live", "en vivo", "happening now", "right now", "today only", "tonight",
    "this weekend", "este fin", "festival", "concert", "GP", "race day",
}
PARTNERSHIP_MARKERS = {
    "x ", "x@", " x ", "with @", "con @", "feat", "ft.", "powered by",
    "in partnership", "alianza con", "presented by",
}
SPORT_EXTREME_TOKENS = {
    "snowboard", "skate", "surf", "downhill", "freeride", "extreme",
    "skydive", "wingsuit", "parkour", "bmx", "motocross", "drift",
    "cliff", "vert", "trick", "stunt", "racing", "rally", "f1", "moto",
}
LIFESTYLE_MARKERS = {
    "morning routine", "rutina", "vibe", "mood", "energy", "wellness",
    "self care", "balance", "mindful", "everyday", "cotidiano",
}
TESTIMONIAL_MARKERS = [
    r"\b(verified|comprado|cliente)\b", r"\breview\b", r"\bopin\w+",
    r"\b(yo\s+lo|yo\s+la)\s+probé\b", r"\b(highly\s+recommend|recomiendo)\b",
]


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

    # 1. Urgente: alta urgencia o promo agresiva
    if urgency > 0.5 or intent.get("buying_intent", 0) > 0.5:
        return ("urgente", 0.85)

    # 2. Confrontacional / Provocador
    confront = _has_any(text_low, CONFRONTATIONAL_WORDS)
    if confront >= 2 or (confront >= 1 and sentiment_score < -0.4):
        return ("confrontacional", min(1.0, 0.5 + confront * 0.15))

    # 3. Irónico / Sarcástico (Liquid Death tier)
    ironic_hits = _has_any(text_low, IRONIC_MARKERS)
    if ironic_hits >= 1 and (sentiment_label == "NEG" or sentiment_score < -0.3):
        # Inversión sentimental = ironía
        if "💀" in text or "🙄" in text or "😏" in text:
            return ("sarcástico", 0.78)
        return ("irónico", 0.72)

    # 4. Nostálgico
    if _has_any(text_low, NOSTALGIC_MARKERS) >= 1:
        return ("nostálgico", 0.80)

    # 5. Aspiracional (con flag premium/luxe en taxonomía)
    if _has_any(text_low, ASPIRATIONAL_MARKERS) >= 1:
        return ("aspiracional", 0.75)

    # 6. Íntimo (primera persona vulnerable)
    if _has_any(text_low, INTIMATE_MARKERS) >= 1:
        return ("íntimo", 0.78)

    # 7. Humorístico
    if dominant_emo in ("amusement",) or _has_any(text_low, COMEDY_MARKERS) >= 2:
        return ("humorístico", 0.80)

    # 8. Motivacional (persuasión alta + sentiment positivo + emoción joy/optimism)
    if persuasion > 0.5 and sentiment_score > 0.3:
        return ("motivacional", 0.72)

    # 9. Optimista (sentiment alto positivo + future-oriented)
    if sentiment_score > 0.6 and any(w in text_low for w in ["future", "futuro", "tomorrow", "mañana", "we will", "iremos", "we can", "podemos"]):
        return ("optimista", 0.82)

    # 10. Alegre (emotion=joy + enthusiasm + sentiment +)
    if dominant_emo == "joy" or (enthusiasm > 0.5 and sentiment_score > 0.4):
        return ("alegre", 0.75)

    # 11. Educativo (formal + alta autoridad sin push de venta)
    if formality > 0.55 and authority > 0.5 and intent.get("buying_intent", 0) < 0.3:
        return ("educativo", 0.70)

    # 12. Autoritario (formal alta + urgency)
    if formality > 0.7:
        return ("autoritario", 0.65)

    # 13. Provocador (sentiment muy positivo o muy negativo, controversial)
    if abs(sentiment_score) > 0.7 and intent.get("cta_intent", 0) > 0.3:
        return ("provocador", 0.60)

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

    # 1. Promo / Oferta
    if _has_any(text_low, PROMO_MARKERS) >= 1 or intent.get("buying_intent", 0) > 0.6:
        return ("promo_oferta", 0.85)

    # 2. Producto / Launch
    if any(w in text_low for w in ["new", "launching", "drops", "available", "lanzamos", "estrenamos", "presentando"]):
        return ("producto_launch", 0.80)

    # 3. Tutorial
    if _has_any_regex(text, TUTORIAL_MARKERS):
        return ("tutorial", 0.85)

    # 4. Datos curiosos / Fun facts
    if _has_any(text_low, FUN_FACT_MARKERS) >= 1:
        return ("datos_curiosos", 0.85)

    # 5. Comparación
    if _has_any_regex(text, COMPARISON_MARKERS):
        return ("comparison", 0.78)

    # 6. Behind the scenes
    if any(w in text_low for w in ["behind the scenes", "bts", "tras bambalinas", "making of", "process", "proceso"]):
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

    # 12. Comunidad / fans
    if any(w in text_low for w in ["fam", "community", "comunidad", "fans", "you guys", "ustedes", "todos vamos"]):
        return ("comunidad_fans", 0.65)

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
    media = post.get("media_assets", {})

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
    if topic in ("tutorial", "informativo", "datos_curiosos") and tone == "educativo": return "técnico"
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
