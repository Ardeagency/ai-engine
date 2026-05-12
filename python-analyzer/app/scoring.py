"""Scoring compuesto: impact_score, risk_level, viral_signals."""
import math


def normalize_log(value: float, target: float) -> float:
    """Normaliza con log para que valores grandes no dominen. Resultado 0..1."""
    if value <= 0 or target <= 0:
        return 0.0
    return min(1.0, math.log1p(value) / math.log1p(target))


def compute_impact_score(metrics: dict, sentiment_score: float, emotion_intensity: float, follower_count: int | None) -> dict:
    """
    Composite impact score 0..1.
      0.30 engagement_rate (likes+comments+shares / followers, normalized)
      0.25 viral_signals    (shares/retweets relative to likes)
      0.20 |sentiment_score| × sign  (impact = strength of feeling, signed)
      0.15 emotion_intensity (fuerza de la emoción dominante)
      0.10 reach proxy       (views/plays normalized log)
    """
    likes = int(metrics.get("likes") or 0)
    comments = int(metrics.get("comments") or metrics.get("replies") or 0)
    shares = int(metrics.get("shares") or metrics.get("retweets") or 0)
    saves = int(metrics.get("saves") or metrics.get("bookmarks") or 0)
    views = int(metrics.get("views") or metrics.get("plays") or 0)
    total_eng = likes + comments + shares + saves

    # 1. Engagement rate
    if follower_count and follower_count > 0:
        eng_rate = total_eng / follower_count
        eng_rate_norm = normalize_log(eng_rate * 1000, 100)  # 10% ER ≈ 1.0
    else:
        eng_rate_norm = normalize_log(total_eng, 50_000)

    # 2. Viral signals (shares/retweets ratio)
    viral = 0.0
    if likes > 100:
        viral = min(1.0, (shares / max(likes, 1)) * 5)  # 20% share ratio = 1.0

    # 3. Sentiment magnitude (no signo, solo fuerza)
    sent_mag = abs(sentiment_score or 0)

    # 4. Emotion intensity
    emo_int = float(emotion_intensity or 0)

    # 5. Reach
    reach_norm = normalize_log(views, 1_000_000)

    impact = (
        0.30 * eng_rate_norm +
        0.25 * viral +
        0.20 * sent_mag +
        0.15 * emo_int +
        0.10 * reach_norm
    )

    return {
        "impact_score": round(impact, 4),
        "components": {
            "engagement_rate_norm": round(eng_rate_norm, 4),
            "viral_signal": round(viral, 4),
            "sentiment_magnitude": round(sent_mag, 4),
            "emotion_intensity": round(emo_int, 4),
            "reach_norm": round(reach_norm, 4),
        },
        "raw": {"likes": likes, "comments": comments, "shares": shares, "saves": saves, "views": views, "total_engagement": total_eng},
    }


def compute_risk_level(sentiment_label: str, sentiment_score: float, emotion: dict, hate_signals: list) -> dict:
    """
    Devuelve { level: 'low'|'medium'|'high', flags: [...] }
    Reglas:
      - hate detectado → high
      - sentiment muy negativo (-0.7) + emoción anger > 0.5 → high
      - sentiment muy negativo + viralidad estimada → high
      - sentiment negativo (-0.4) → medium
      - resto → low
    """
    flags = []
    level = "low"

    if hate_signals:
        flags.extend(hate_signals)
        level = "high"

    anger = emotion.get("probas", {}).get("anger", 0) or emotion.get("probas", {}).get("Anger", 0)
    sadness = emotion.get("probas", {}).get("sadness", 0) or emotion.get("probas", {}).get("Sadness", 0)
    fear = emotion.get("probas", {}).get("fear", 0) or emotion.get("probas", {}).get("Fear", 0)

    if sentiment_score is not None:
        if sentiment_score <= -0.7:
            flags.append("very_negative")
            level = "high" if anger > 0.5 else max_lvl(level, "medium")
        elif sentiment_score <= -0.4:
            flags.append("negative")
            level = max_lvl(level, "medium")

    if anger > 0.6:
        flags.append("high_anger")
        level = max_lvl(level, "medium")

    return {"level": level, "flags": list(set(flags))}


def max_lvl(a: str, b: str) -> str:
    order = {"low": 0, "medium": 1, "high": 2}
    return a if order[a] >= order[b] else b
