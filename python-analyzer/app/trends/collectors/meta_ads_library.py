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
    supports_batch = True   # 1 Apify run con N URLs en lugar de N runs separados

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

    async def fetch_raw_batch(self, queries: list[TrendQuery]
                              ) -> tuple[dict[str, list[RawSignal]], float]:
        """1 Apify run con todas las URLs juntas. Apify procesa cada URL
        secuencialmente y devuelve items con el `url` original en el payload
        (campo `url` o `ad_snapshot_url`). Re-mapeamos items → query original.
        """
        if not queries:
            return {}, 0.0

        # Construir URLs y mapa url→query para re-atribución
        urls_payload = []
        url_to_query: dict[str, TrendQuery] = {}
        for q in queries:
            u = _build_url(q.keyword, q.geo)
            urls_payload.append({"url": u})
            url_to_query[u] = q

        actor_input = {
            "urls": urls_payload,
            "count": RESULTS_PER_QUERY * len(queries),  # cap total proporcional
        }
        # Timeout más alto: N URLs procesadas secuencialmente toman más tiempo
        items = await _apify.run_actor(ACTOR, actor_input,
                                        timeout_s=min(60 + 30 * len(queries), 600))

        # Agrupar items por keyword. Apify devuelve `url` del input en cada
        # item (en `inputUrl` o como query param dentro de algún campo).
        # Estrategia de matching:
        #   1) Si item tiene `inputUrl` o `url` que matchea uno de los inputs → directo
        #   2) Si item tiene `searchTerm`/`q` que matchea query.keyword (case-insensitive)
        #   3) Fallback: distribución round-robin entre queries (preserva data)
        grouped: dict[str, list[RawSignal]] = {q.keyword: [] for q in queries}
        unmatched: list[dict] = []

        for it in items:
            matched_q: TrendQuery | None = None

            # Match 1: inputUrl directo
            input_url = (it.get("inputUrl") or it.get("input_url") or
                          it.get("sourceUrl") or it.get("source_url"))
            if input_url and input_url in url_to_query:
                matched_q = url_to_query[input_url]

            # Match 2: por keyword en searchTerm o query del item
            if matched_q is None:
                search_term = (it.get("searchTerm") or it.get("q") or
                                it.get("query") or "").lower()
                if search_term:
                    for q in queries:
                        if q.keyword.lower() == search_term or q.keyword.lower() in search_term:
                            matched_q = q
                            break

            if matched_q is not None:
                s = _to_signal(it, matched_q)
                if s:
                    grouped[matched_q.keyword].append(s)
            else:
                unmatched.append(it)

        # Round-robin de unmatched para no perder datos (Apify a veces no
        # devuelve el inputUrl en cada item). Asignar usando query.geo como tiebreaker.
        if unmatched:
            import logging
            logging.getLogger(__name__).info(
                "meta_ads_library batch: %d items sin match directo, round-robin",
                len(unmatched))
            for i, it in enumerate(unmatched):
                q = queries[i % len(queries)]
                # Cap por keyword para no saturar uno solo
                if len(grouped[q.keyword]) >= RESULTS_PER_QUERY:
                    continue
                s = _to_signal(it, q)
                if s:
                    grouped[q.keyword].append(s)

        # Cap final por query
        for k in list(grouped.keys()):
            grouped[k] = grouped[k][:RESULTS_PER_QUERY]

        total_results = sum(len(v) for v in grouped.values())
        usd_cost = total_results * COST_PER_RESULT_USD
        return grouped, usd_cost
