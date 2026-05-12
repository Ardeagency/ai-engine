"""Persistencia de señales rankeadas en targeted_trend_signals.

Tabla legacy reusada (decisión de arquitectura — sin migración nueva).
Mapeo de columnas:
  trigger_keyword   ← query.keyword
  keyword_origin    ← signal.metadata.keyword_origin
  source            ← signal.source
  geo               ← signal.metadata.geo
  title             ← signal.text[:300]
  url               ← raw_payload.url
  raw_data          ← raw_payload completo + sub-scores
  match_strength    ← signal.final_score
  fetched_at        ← raw timestamp del signal
  fetch_date        ← hoy
  expires_at        ← now + 30d
  composed_query    ← query.keyword (igual a trigger por ahora)
  vera_safe         ← True (ya pasó normalizer)
  signal_intent     ← scored.signal_intent

Solo persistimos top-K (señales ya scored). Las raw filtradas no se guardan
para evitar saturar la tabla — quedan en external_api_cache.
"""
from __future__ import annotations
import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx

from .models import ScoredSignal

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

log = logging.getLogger(__name__)
RETENTION_DAYS = int(os.environ.get("TRENDS_SIGNAL_RETENTION_DAYS", "30"))


def _row_from_scored(s: ScoredSignal, brand_container_id: str) -> dict[str, Any]:
    md = s.metadata or {}
    raw_payload = md.get("raw_payload") or {}
    ts_iso = md.get("timestamp")
    fetched_at = ts_iso or datetime.now(timezone.utc).isoformat()
    expires = (datetime.now(timezone.utc) + timedelta(days=RETENTION_DAYS)).isoformat()
    return {
        "id": str(s.signal_id) if s.signal_id else str(uuid4()),
        "brand_container_id": brand_container_id,
        "trigger_keyword": (md.get("trigger_keyword") or s.text[:80])[:200],
        "keyword_origin": md.get("keyword_origin") or "niche",
        "source": s.source or "unknown",
        "geo": md.get("geo") or "CO",
        "title": (s.text or "")[:300],
        "url": raw_payload.get("url"),
        "raw_data": {
            **raw_payload,
            "scores": {
                "final": s.final_score,
                "semantic": s.semantic_relevance,
                "volume": s.volume_score,
                "growth": s.growth_score,
                "freshness": s.freshness_score,
                "commercial": s.commercial_score,
            },
        },
        "match_strength": s.final_score,
        "fetched_at": fetched_at,
        "fetch_date": date.today().isoformat(),
        "expires_at": expires,
        "composed_query": md.get("trigger_keyword") or s.text[:200],
        "vera_safe": True,
        "signal_intent": s.signal_intent,
    }


async def persist_scored_signals(scored: list[ScoredSignal],
                                  brand_container_id: str) -> list[str]:
    """Inserta señales rankeadas. Devuelve lista de IDs creados (best-effort)."""
    if not scored:
        return []
    rows = [_row_from_scored(s, brand_container_id) for s in scored]
    body = rows
    try:
        async with httpx.AsyncClient(timeout=20) as cli:
            r = await cli.post(
                f"{SUPABASE_URL}/rest/v1/targeted_trend_signals",
                headers={**H, "Prefer": "return=representation"},
                json=body,
            )
            if r.status_code >= 400:
                log.warning("persist signals failed status=%d body=%s",
                            r.status_code, r.text[:300])
                return []
            data = r.json()
            return [row["id"] for row in data if row.get("id")]
    except Exception as e:
        log.warning("persist signals exception: %s", e)
        return []
