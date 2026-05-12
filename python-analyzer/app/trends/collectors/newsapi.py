"""NewsAPI collector — niche/news angles vía https://newsapi.org/.

API gratuita (100 req/día en developer plan, 24h delay). Requiere NEWSAPI_KEY
en .env. credit_kind: 'dataforseo_query' (reutilizamos el kind 'news' del
constraint hasta agregar 'newsapi_query').
"""
from __future__ import annotations
import os
from datetime import datetime, timezone

import httpx

from ..models import RawSignal, TrendQuery
from .base import BaseCollector

NEWSAPI_KEY = os.environ.get("NEWSAPI_KEY", "")
PAGE_SIZE = int(os.environ.get("TRENDS_NEWSAPI_RESULTS", "15"))
ENDPOINT = "https://newsapi.org/v2/everything"


def _to_signal(item: dict, query: TrendQuery) -> RawSignal | None:
    title = (item.get("title") or "").strip()
    desc = (item.get("description") or "").strip()
    text = (title + (" — " + desc if desc else "")).strip()
    if not text:
        return None
    ts_raw = item.get("publishedAt")
    try:
        ts = (datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
              if ts_raw else datetime.now(timezone.utc))
    except Exception:
        ts = datetime.now(timezone.utc)
    return RawSignal(
        text=text[:500],
        source="newsapi",
        geo=query.geo,
        language=query.language,
        timestamp=ts,
        rising=False,
        raw_payload={"url": item.get("url"),
                      "source_name": (item.get("source") or {}).get("name"),
                      "author": item.get("author")},
    )


class NewsApiCollector(BaseCollector):
    provider = "newsapi"
    credit_kind = "dataforseo_query"

    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        if not NEWSAPI_KEY:
            return [], 0.0
        params = {
            "q": query.keyword,
            "language": query.language or "es",
            "sortBy": "publishedAt",
            "pageSize": str(PAGE_SIZE),
        }
        headers = {"X-Api-Key": NEWSAPI_KEY}
        async with httpx.AsyncClient(timeout=15) as cli:
            r = await cli.get(ENDPOINT, params=params, headers=headers)
        if r.status_code != 200:
            return [], 0.0
        data = r.json()
        items = data.get("articles") or []
        signals: list[RawSignal] = []
        for it in items[:PAGE_SIZE]:
            s = _to_signal(it, query)
            if s:
                signals.append(s)
        return signals, 0.0  # NewsAPI free tier: $0
