"""PostAnalyzer — orquesta todas las tareas y compone el resultado para 1 post."""
from .tasks.sentiment import analyze_sentiment, detect_lang
from .tasks.emotion import analyze_emotion
from .tasks.topics import extract_topics
from .tasks.tone import tone_vector
from .tasks.intent import detect_intent
from .scoring import compute_impact_score, compute_risk_level


def analyze_post(content: str, metrics: dict | None = None, follower_count: int | None = None) -> dict:
    """
    Analiza 1 post. Devuelve dict con todas las dimensiones para UPDATE en brand_posts.
    """
    metrics = metrics or {}
    if not content or not content.strip():
        return {"error": "empty_content"}

    # 1. Idioma (1 detect, todos los demás lo reusan)
    lang = detect_lang(content)

    # 2. Análisis paralelos lógicamente (ejecución secuencial CPU-bound)
    sent = analyze_sentiment(content, lang)
    emo = analyze_emotion(content, lang if lang in ("es", "en") else "en")
    topics = extract_topics(content, top_n=5)
    tone = tone_vector(content, lang)
    intent = detect_intent(content, lang)

    # 3. Scoring compuesto
    impact = compute_impact_score(metrics, sent["score"], emo["intensity"], follower_count)
    risk = compute_risk_level(sent["label"], sent["score"], emo, hate_signals=[])

    return {
        "language": lang,
        "sentiment": {
            "label": sent["label"],
            "score": sent["score"],
            "probas": sent["probas"],
        },
        "emotion": {
            "dominant": emo["dominant"],
            "probas": emo["probas"],
            "intensity": emo["intensity"],
        },
        "topics": topics,
        "tone": tone,
        "intent": intent,
        "impact": impact,
        "risk": risk,
    }
