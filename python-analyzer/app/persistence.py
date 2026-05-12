"""Lectura y escritura de brand_posts vía Supabase REST API."""
import os
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_KEY"]

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


async def fetch_post(post_uuid: str) -> dict | None:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=HEADERS,
            params={"id": f"eq.{post_uuid}", "select": "id,content,metrics,followers_snapshot,is_processed"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None


async def fetch_pending(limit: int = 50) -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=HEADERS,
            params={
                "is_processed": "is.false",
                "select": "id,content,metrics,followers_snapshot",
                "order": "captured_at.desc",
                "limit": str(limit),
            },
        )
        r.raise_for_status()
        return r.json()


async def update_post(post_uuid: str, analysis: dict) -> dict:
    """Mapea el resultado del analyzer a las columnas de brand_posts."""
    sent = analysis.get("sentiment", {})
    emo = analysis.get("emotion", {})
    risk = analysis.get("risk", {})
    impact = analysis.get("impact", {})

    payload = {
        "sentiment": {
            "label": sent.get("label"),
            "score": sent.get("score"),
            "probas": sent.get("probas"),
            "emotion": emo,
            "intent": analysis.get("intent"),
            "impact": impact,
        },
        "sentiment_text": sent.get("label"),
        "sentiment_score": sent.get("score"),
        # tone/topics removed — pattern_classifier writes 15-tone/16-topic taxonomy
        # to post_patterns table (deterministic, dictionary-backed).
        "risk_level": risk.get("level"),
        "flags": risk.get("flags", []),
        "is_processed": True,
        "classification_log": f"analyzer v1 | lang={analysis.get('language')} | impact={impact.get('impact_score')}",
        "enrichment": {
            "tone_vector": analysis.get("tone"),
            "language": analysis.get("language"),
            "topics_with_score": analysis.get("topics"),
            "intent": analysis.get("intent"),
            "impact_components": impact.get("components"),
        },
        "updated_at": "now()",
    }

    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.patch(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=HEADERS,
            params={"id": f"eq.{post_uuid}"},
            json=payload,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"supabase update {r.status_code}: {r.text[:200]}")
        return r.json()[0] if r.json() else {}
