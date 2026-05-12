"""Meta Ads Library collector — vía Apify (FB Ads Library scraper).

La API oficial de Meta Ads Library requiere FB access_token con permiso
ads_read. Como no lo tenemos, usamos un actor Apify que scrapea la web
pública de la biblioteca. Es legal y se considera read-only.

Actor por defecto: curious_coder~facebook-ads-library-scraper. Override
con env APIFY_ACTOR_META_ADS.
credit_kind: 'meta_ads_library_query' (extiende kind via v11 migration).
"""
from __future__ import annotations
import os
from datetime import datetime, timezone
from urllib.parse import quote

from ..models import RawSignal, TrendQuery
from . import _apify
from .base import BaseCollector

ACTOR = os.environ.get("APIFY_ACTOR_META_ADS",
                       "curious_coder~facebook-ads-library-scraper")
RESULTS_PER_QUERY = int(os.environ.get("TRENDS_META_ADS_RESULTS", "15"))
COST_PER_RESULT_USD = 0.0005


def _build_url(keyword: str, geo: str) -> str:
    g = (geo or "US").upper()
    q = quote(keyword)
    return (f"https://www.facebook.com/ads/library/?active_status=active"
            f"&ad_type=all&country={g}&q={q}&search_type=keyword_unordered")


def _to_signal(item: dict, query: TrendQuery) -> RawSignal | None:
    body = (item.get("ad_creative_body") or item.get("body") or
            (item.get("snapshot") or {}).get("body", {}).get("text") or "").strip()
    title = (item.get("ad_creative_link_title") or
             (item.get("snapshot") or {}).get("title") or "").strip()
    text = (title + (" — " + body if body else "")).strip() or body
    if not text:
        return None
    page_name = (item.get("page_name") or item.get("pageName") or
                 (item.get("snapshot") or {}).get("page_name") or "")
    impressions = item.get("impressions") or {}
    spend = item.get("spend") or {}
    ts_raw = item.get("ad_delivery_start_time") or item.get("startDateString")
    try:
        ts = (datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
              if ts_raw else datetime.now(timezone.utc))
    except Exception:
        ts = datetime.now(timezone.utc)
    commercial_intent = "transactional"  # toda ad pagada implica intent comercial
    return RawSignal(
        text=text[:500],
        source="meta_ads_library",
        geo=query.geo,
        language=query.language,
        timestamp=ts,
        commercial_intent=commercial_intent,
        rising=False,
        raw_payload={"page_name": page_name, "impressions": impressions,
                      "spend": spend,
                      "platforms": item.get("publisher_platforms") or
                                   item.get("publisherPlatform") or [],
                      "url": item.get("ad_snapshot_url") or item.get("url")},
    )


class MetaAdsLibraryCollector(BaseCollector):
    provider = "meta_ads_library"
    credit_kind = "meta_ads_library_query"

    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        actor_input = {
            "urls": [{"url": _build_url(query.keyword, query.geo)}],
            "count": RESULTS_PER_QUERY,
        }
        items = await _apify.run_actor(ACTOR, actor_input, timeout_s=90)
        signals: list[RawSignal] = []
        for it in items[:RESULTS_PER_QUERY]:
            s = _to_signal(it, query)
            if s:
                signals.append(s)
        usd_cost = len(signals) * COST_PER_RESULT_USD
        return signals, usd_cost
