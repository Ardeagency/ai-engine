"""Apify Instagram collector — hashtag trends.

Actor por defecto: apify~instagram-hashtag-scraper. Override con env
APIFY_ACTOR_INSTAGRAM.
credit_kind: 'apify_scrape'.
"""
from __future__ import annotations
import os
import re
from datetime import datetime, timezone

from ..models import RawSignal, TrendQuery
from . import _apify
from .base import BaseCollector

ACTOR = os.environ.get("APIFY_ACTOR_INSTAGRAM", "apify~instagram-hashtag-scraper")
RESULTS_PER_QUERY = int(os.environ.get("TRENDS_INSTAGRAM_RESULTS", "15"))
COST_PER_RESULT_USD = 0.0020


def _to_hashtag(keyword: str) -> str:
    cleaned = re.sub(r"[^\w]+", "", keyword.lower(), flags=re.UNICODE)
    return cleaned[:60] or keyword.replace(" ", "").lower()


def _to_signal(item: dict, query: TrendQuery) -> RawSignal | None:
    text = (item.get("caption") or item.get("text") or "").strip()
    if not text:
        return None
    likes = item.get("likesCount") or 0
    comments = item.get("commentsCount") or 0
    plays = item.get("videoPlayCount") or item.get("videoViewCount") or 0
    ts_raw = item.get("timestamp") or item.get("takenAtTimestamp")
    try:
        if isinstance(ts_raw, (int, float)):
            ts = datetime.fromtimestamp(ts_raw, tz=timezone.utc)
        elif ts_raw:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        else:
            ts = datetime.now(timezone.utc)
    except Exception:
        ts = datetime.now(timezone.utc)
    return RawSignal(
        text=text[:500],
        source="apify_instagram",
        geo=query.geo,
        language=query.language,
        timestamp=ts,
        search_volume=int(plays) if plays else (int(likes) if likes else None),
        rising=bool(plays and int(plays) > 50_000),
        raw_payload={"likes": likes, "comments": comments, "plays": plays,
                      "url": item.get("url"),
                      "hashtags": item.get("hashtags") or []},
    )


class ApifyInstagramCollector(BaseCollector):
    provider = "apify_instagram"
    credit_kind = "apify_scrape"

    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        actor_input = {
            "hashtags": [_to_hashtag(query.keyword)],
            "resultsLimit": RESULTS_PER_QUERY,
        }
        items = await _apify.run_actor(ACTOR, actor_input, timeout_s=90)
        signals: list[RawSignal] = []
        for it in items[:RESULTS_PER_QUERY]:
            s = _to_signal(it, query)
            if s:
                signals.append(s)
        usd_cost = len(signals) * COST_PER_RESULT_USD
        return signals, usd_cost
