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


# Tasa de conversión USD → créditos. 1 crédito = $1 USD de Apify (cambio
# 2026-05-21, antes 0.10). El cobro es 1:1: $0.33 USD = 0.33 créditos.
# Display al usuario usa FLOOR del balance (ver v_org_credits_display).
USD_PER_CREDIT = float(os.environ.get("USD_PER_CREDIT", "1.0"))


async def _record_credit_usage(organization_id: str, kind: str, usd_cost: float,
                                metadata: dict[str, Any],
                                source_id: str | None = None) -> None:
    """Cobra a la org: (1) escribe ledger en credit_usage, (2) descuenta saldo
    en organization_credits. Best-effort — no tumba el ciclo si falla."""
    if usd_cost <= 0:
        return
    credits = float(usd_cost) / USD_PER_CREDIT
    body: dict[str, Any] = {
        "id": str(uuid4()),
        "organization_id": organization_id,
        "kind": kind,
        "credits_delta": -credits,
        "usd_cost": float(usd_cost),
        "source_table": "trend_query_jobs",
        "metadata": metadata,
    }
    if source_id:
        body["source_id"] = source_id
    try:
        async with httpx.AsyncClient(timeout=8) as cli:
            # 1) Ledger
            await cli.post(f"{SUPABASE_URL}/rest/v1/credit_usage",
                           headers=H, json=body)
            # 2) Descontar saldo en vivo. PostgREST no soporta expresiones SQL
            # en PATCH, así que GET → calc → PATCH (mismo patrón que el wrapper
            # Node lib/apify.client.js#chargeOrg). Sin guard de saldo mínimo
            # para mantener auditoría exacta (puede ir negativo).
            r = await cli.get(
                f"{SUPABASE_URL}/rest/v1/organization_credits",
                headers=H,
                params={"organization_id": f"eq.{organization_id}",
                         "select": "credits_available"},
            )
            rows = r.json() if r.status_code == 200 else []
            if rows:
                cur_balance = float(rows[0].get("credits_available") or 0)
                new_balance = round(cur_balance - credits, 4)
                await cli.patch(
                    f"{SUPABASE_URL}/rest/v1/organization_credits",
                    headers={**H, "Prefer": "return=minimal"},
                    params={"organization_id": f"eq.{organization_id}"},
                    json={"credits_available": new_balance,
                           "updated_at": datetime.now().isoformat()},
                )
    except Exception as e:
        log.warning("credit_usage charge failed kind=%s err=%s", kind, e)


class BaseCollector(ABC):
    """Interfaz que todo collector debe implementar."""

    provider: str            # clave única del provider, ej. "apify_tiktok"
    credit_kind: str         # kind para credit_usage (debe estar en CHECK)

    # Subclase puede declarar que soporta batch (1 actor run con N queries).
    # Si False, orchestrator hace 1 run por query (legacy).
    supports_batch: bool = False

    @abstractmethod
    async def fetch_raw(self, query: TrendQuery) -> tuple[list[RawSignal], float]:
        """Llama el API externo. Devuelve (signals_crudos, usd_cost_estimado)."""
        ...

    async def fetch_raw_batch(self, queries: list[TrendQuery]
                              ) -> tuple[dict[str, list[RawSignal]], float]:
        """Versión batch: 1 sola llamada al API externo con N queries.

        Devuelve (signals_por_query_keyword, usd_cost_total). Subclase que
        declara supports_batch=True debe implementarlo.
        """
        raise NotImplementedError(f"{self.provider} no implementa batch")

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

    async def collect_batch(self, queries: list[TrendQuery], *,
                            brand_container_id: str | None = None,
                            organization_id: str | None = None,
                            cycle_id: str | None = None
                            ) -> dict[str, list[RawSignal]]:
        """Batch: cache por query, 1 sola llamada externa para las uncached.

        Devuelve dict {query.keyword: list[RawSignal]}.
        Si supports_batch=False, hace fallback a N collect() individuales.
        """
        if not self.supports_batch:
            # Fallback legacy: 1 collect por query
            out: dict[str, list[RawSignal]] = {}
            for q in queries:
                out[q.keyword] = await self.collect(
                    q, brand_container_id=brand_container_id,
                    organization_id=organization_id, cycle_id=cycle_id,
                )
            return out

        # 1. Resolver cache por cada query — separar cached de pendientes
        cached_results: dict[str, list[RawSignal]] = {}
        pending: list[TrendQuery] = []
        for q in queries:
            ckey = cache.make_cache_key(self.provider, q.keyword, q.geo,
                                         extra=q.language or "")
            c = await cache.get(ckey)
            if c is not None:
                cached_results[q.keyword] = [_dict_to_signal(d)
                                              for d in (c.get("signals") or [])]
            else:
                pending.append(q)

        if not pending:
            log.info("collect_batch [%s]: %d queries todas cacheadas, 0 calls",
                     self.provider, len(queries))
            return cached_results

        # 2. 1 sola llamada batch para los pendientes
        log.info("collect_batch [%s]: %d pending de %d total → 1 run Apify",
                 self.provider, len(pending), len(queries))
        try:
            grouped, usd_cost = await self.fetch_raw_batch(pending)
        except Exception as e:
            log.warning("batch %s failed err=%s", self.provider, str(e)[:300])
            # Fallback: si batch falla, intentar 1×1 (preserva alguna data)
            for q in pending:
                try:
                    cached_results[q.keyword] = await self.collect(
                        q, brand_container_id=brand_container_id,
                        organization_id=organization_id, cycle_id=cycle_id,
                    )
                except Exception:
                    cached_results[q.keyword] = []
            return cached_results

        # 3. Normalizar y cachear cada resultado por query
        for q in pending:
            sigs = grouped.get(q.keyword, [])
            for s in sigs:
                s.source = s.source or self.provider
                s.geo = s.geo or q.geo
                s.language = s.language or q.language
                s.keyword_origin = s.keyword_origin or q.keyword_origin
            cached_results[q.keyword] = sigs
            ckey = cache.make_cache_key(self.provider, q.keyword, q.geo,
                                         extra=q.language or "")
            try:
                await cache.set_(
                    ckey,
                    {"signals": [_signal_to_dict(s) for s in sigs]},
                    provider=self.provider,
                    brand_container_id=brand_container_id,
                )
            except Exception as e:
                log.warning("cache set failed (batch) provider=%s err=%s",
                            self.provider, e)

        # 4. Registrar usd_cost total con metadata batch
        if organization_id and usd_cost > 0:
            await _record_credit_usage(
                organization_id, self.credit_kind, usd_cost,
                metadata={"provider": self.provider,
                          "batch": True,
                          "queries_count": len(pending),
                          "queries_sample": [q.keyword for q in pending[:5]],
                          "result_count": sum(len(v) for v in grouped.values())},
                source_id=cycle_id,
            )
        return cached_results
