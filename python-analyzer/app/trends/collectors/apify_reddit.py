"""Apify Reddit collector — conversación auténtica, dolores reales del nicho.

Actor por defecto: trudax~reddit-scraper-lite. Override con env
APIFY_ACTOR_REDDIT.
credit_kind: 'apify_scrape'.
"""
from __future__ import annotations
import os
from datetime import datetime, timezone

from ..models import RawSignal, TrendQuery
from . import _apify
from .base import BaseCollector

ACTOR = os.environ.get("APIFY_ACTOR_REDDIT", "trudax~reddit-scraper-lite")
RESULTS_PER_QUERY = int(os.environ.get("TRENDS_REDDIT_RESULTS", "20"))
COST_PER_RESULT_USD = 0.0010


def _to_signal(item: dict, query: TrendQuery) -> RawSignal | None:
    title = (item.get("title") or "").strip()
    body = (item.get("text") or item.get("body") or item.get("selftext") or "").strip()
    text = (title + (" — " + body if body else "")).strip()
    if not text:
        return None
    score = item.get("upVotes") or item.get("score") or item.get("ups") or 0
    comments = item.get("numberOfComments") or item.get("numComments") or 0
    ts_raw = item.get("createdAt") or item.get("created_utc") or item.get("created")
    try:
        if isinstance(ts_raw, (int, float)):
            ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
        elif ts_raw:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        else:
            ts = datetime.now(timezone.utc)
    except Exception:
        ts = datetime.now(timezone.utc)
    return RawSignal(
        text=text[:500],
        source="apify_reddit",
        geo=query.geo,
        language=query.language,
        timestamp=ts,
        search_volume=int(score) if score else None,
        rising=bool(score and int(score) > 1000),
        raw_payload={"score": score, "comments": comments,
                      "subreddit": item.get("subredditName") or item.get("subreddit"),
                      "url": item.get("url") or item.get("permalink")},
    )


class ApifyRedditCollector(BaseCollector):
    provider = "apify_reddit"
    credit_kind = "apify_scrape"

    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        actor_input = {
            "searches": [query.keyword],
            "maxItems": RESULTS_PER_QUERY,
            "scrollTimeout": 40,
            "skipComments": True,
            "skipUserPosts": False,
            "skipCommunity": False,
        }
        items = await _apify.run_actor(ACTOR, actor_input, timeout_s=90)
        signals: list[RawSignal] = []
        for it in items[:RESULTS_PER_QUERY]:
            s = _to_signal(it, query)
            if s:
                signals.append(s)
        usd_cost = len(signals) * COST_PER_RESULT_USD
        return signals, usd_cost
