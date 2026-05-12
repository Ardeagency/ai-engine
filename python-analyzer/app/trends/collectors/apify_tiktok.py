"""Apify TikTok collector — keyword/hashtag trends.

Actor por defecto: clockworks~free-tiktok-scraper. Override con env
APIFY_ACTOR_TIKTOK si quieres usar otro actor.
credit_kind: 'apify_scrape'.
"""
from __future__ import annotations
import os
from datetime import datetime, timezone

from ..models import RawSignal, TrendQuery
from . import _apify
from .base import BaseCollector

ACTOR = os.environ.get("APIFY_ACTOR_TIKTOK", "clockworks~free-tiktok-scraper")
RESULTS_PER_QUERY = int(os.environ.get("TRENDS_TIKTOK_RESULTS", "15"))
COST_PER_RESULT_USD = 0.0003


def _to_signal(item: dict, query: TrendQuery) -> RawSignal | None:
    text = (item.get("text") or item.get("desc") or "").strip()
    if not text:
        return None
    plays = item.get("playCount") or (item.get("stats") or {}).get("playCount") or 0
    likes = item.get("diggCount") or (item.get("stats") or {}).get("diggCount") or 0
    create_ts = item.get("createTimeISO") or item.get("createTime")
    try:
        ts = (datetime.fromisoformat(str(create_ts).replace("Z", "+00:00"))
              if create_ts else datetime.now(timezone.utc))
    except Exception:
        ts = datetime.now(timezone.utc)
    hashtags = [h.get("name") for h in (item.get("hashtags") or []) if isinstance(h, dict)]
    return RawSignal(
        text=text[:500],
        source="apify_tiktok",
        geo=query.geo,
        language=query.language,
        timestamp=ts,
        search_volume=int(plays) if plays else None,
        rising=bool(plays and int(plays) > 100_000),
        raw_payload={"likes": likes, "plays": plays,
                      "url": item.get("webVideoUrl") or item.get("videoUrl"),
                      "hashtags": hashtags},
    )


class ApifyTikTokCollector(BaseCollector):
    provider = "apify_tiktok"
    credit_kind = "apify_scrape"

    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        actor_input = {
            "searchQueries": [query.keyword],
            "resultsPerPage": RESULTS_PER_QUERY,
            "shouldDownloadVideos": False,
            "shouldDownloadCovers": False,
            "shouldDownloadSlideshowImages": False,
        }
        items = await _apify.run_actor(ACTOR, actor_input, timeout_s=90)
        signals: list[RawSignal] = []
        for it in items[:RESULTS_PER_QUERY]:
            s = _to_signal(it, query)
            if s:
                signals.append(s)
        usd_cost = len(signals) * COST_PER_RESULT_USD
        return signals, usd_cost
