"""Base collector con cache-first dispatch + credit_usage tracking.

Cada subclase implementa fetch_raw(query) → (signals, usd_cost). El método
collect() público maneja cache, persistencia de costo, y degradación graciosa
(devuelve [] en caso de error sin tumbar el ciclo).

Ref: blueprint sec. 8.
"""
from __future__ import annotations
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any
from uuid import uuid4

import httpx

from .. import cache
from ..models import RawSignal, TrendQuery

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

log = logging.getLogger(__name__)


def _signal_to_dict(s: RawSignal) -> dict[str, Any]:
    return {
        "text": s.text,
        "source": s.source,
        "geo": s.geo,
        "language": s.language,
        "timestamp": s.timestamp.isoformat() if s.timestamp else None,
        "search_volume": s.search_volume,
        "growth_pct": s.growth_pct,
        "commercial_intent": s.commercial_intent,
        "rising": s.rising,
        "raw_payload": s.raw_payload,
        "query_id": s.query_id,
        "keyword_origin": s.keyword_origin,
    }


def _dict_to_signal(d: dict[str, Any]) -> RawSignal:
    ts = d.get("timestamp")
    return RawSignal(
        text=d.get("text", ""),
        source=d.get("source", ""),
        geo=d.get("geo", ""),
        language=d.get("language", ""),
        timestamp=datetime.fromisoformat(ts) if ts else datetime.now(),  # type: ignore[arg-type]
        search_volume=d.get("search_volume"),
        growth_pct=d.get("growth_pct"),
        commercial_intent=d.get("commercial_intent"),
        rising=bool(d.get("rising", False)),
        raw_payload=d.get("raw_payload") or {},
        query_id=d.get("query_id"),
        keyword_origin=d.get("keyword_origin"),
    )


async def _record_credit_usage(organization_id: str, kind: str, usd_cost: float,
                                metadata: dict[str, Any],
                                source_id: str | None = None) -> None:
    """Best-effort registro de costo. No tumba el ciclo si la inserción falla."""
    if usd_cost <= 0:
        return
    body: dict[str, Any] = {
        "id": str(uuid4()),
        "organization_id": organization_id,
        "kind": kind,
        "credits_delta": -float(usd_cost),
        "usd_cost": float(usd_cost),
        "source_table": "trend_query_jobs",
        "metadata": metadata,
    }
    if source_id:
        body["source_id"] = source_id
    try:
        async with httpx.AsyncClient(timeout=8) as cli:
            await cli.post(f"{SUPABASE_URL}/rest/v1/credit_usage",
                           headers=H, json=body)
    except Exception as e:
        log.warning("credit_usage insert failed kind=%s err=%s", kind, e)


class BaseCollector(ABC):
    """Interfaz que todo collector debe implementar."""

    provider: str            # clave única del provider, ej. "apify_tiktok"
    credit_kind: str         # kind para credit_usage (debe estar en CHECK)

    @abstractmethod
    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        """Llama el API externo. Devuelve (signals_crudos, usd_cost_estimado)."""
        ...

    async def collect(self, query: TrendQuery, *,
                      brand_container_id: str | None = None,
                      organization_id: str | None = None,
                      cycle_id: str | None = None) -> list[RawSignal]:
        """Cache-first. Persiste resultado en external_api_cache y costo en credit_usage."""
        ckey = cache.make_cache_key(self.provider, query.keyword, query.geo,
                                     extra=query.language or "")
        cached = await cache.get(ckey)
        if cached is not None:
            sigs = cached.get("signals") or []
            return [_dict_to_signal(d) for d in sigs]

        try:
            signals, usd_cost = await self.fetch_raw(query)
        except Exception as e:
            log.warning("collector %s failed q=%r geo=%s err=%s",
                        self.provider, query.keyword, query.geo, str(e)[:200])
            return []

        for s in signals:
            s.source = s.source or self.provider
            s.geo = s.geo or query.geo
            s.language = s.language or query.language
            s.keyword_origin = s.keyword_origin or query.keyword_origin

        try:
            await cache.set_(
                ckey,
                {"signals": [_signal_to_dict(s) for s in signals]},
                provider=self.provider,
                brand_container_id=brand_container_id,
            )
        except Exception as e:
            log.warning("cache set failed provider=%s err=%s", self.provider, e)

        if organization_id and usd_cost > 0:
            await _record_credit_usage(
                organization_id, self.credit_kind, usd_cost,
                metadata={"provider": self.provider,
                          "query": query.keyword, "geo": query.geo,
                          "result_count": len(signals)},
                source_id=cycle_id,
            )
        return signals
