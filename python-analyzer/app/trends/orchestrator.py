"""Orquestador del pipeline de Tendencias.

mock=True  → ciclo end-to-end con stubs (útil para validar plumbing y CI).
mock=False → ciclo real:
  1. query_generator.generate_queries
  2. collectors dispatch (cache-first, primer provider de target_apis)
  3. normalizer.normalize
  4. scorer.score_signals (top-K diverso)
  5. persistence.persist_scored_signals → targeted_trend_signals
  6. brief_generator.generate_briefs → strategic_recommendations + notification

Cost tracking: cada collector y el brief_generator escriben en credit_usage.
Al final sumamos por source_id=cycle_id para llenar trend_query_jobs.total_*.

Ref: blueprint sec. 6 (arquitectura) y sec. 14 (plan de fases).
"""
from __future__ import annotations
import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx

from .models import RawSignal, ScoredSignal, TrendBrief, TrendQuery

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

log = logging.getLogger(__name__)

CONCURRENCY = int(os.environ.get("TRENDS_COLLECTOR_CONCURRENCY", "4"))
QUERY_HARD_CAP = int(os.environ.get("TRENDS_QUERY_HARD_CAP", "60"))


# ── Mocks ────────────────────────────────────────────────────────────────────
async def _mock_query_generator(brand_container_id: str, cycle_id: str) -> list[TrendQuery]:
    return [
        TrendQuery(keyword="batidora portátil", keyword_origin="product",
                   source_entity_id=None, geo="CO", language="es",
                   target_apis=["apify_tiktok"], priority=8),
        TrendQuery(keyword="recetas saludables", keyword_origin="audience_persona",
                   source_entity_id=None, geo="CO", language="es",
                   target_apis=["apify_reddit"], priority=6),
        TrendQuery(keyword="electrodomésticos cocina", keyword_origin="niche",
                   source_entity_id=None, geo="CO", language="es",
                   target_apis=["newsapi"], priority=7),
    ]


async def _mock_collectors(queries: list[TrendQuery]) -> list[RawSignal]:
    now = datetime.now(timezone.utc)
    return [
        RawSignal(text=f"mock signal for '{q.keyword}'", source="mock",
                  geo=q.geo, language=q.language, timestamp=now,
                  search_volume=1500, growth_pct=25.0, rising=True,
                  keyword_origin=q.keyword_origin)
        for q in queries
    ]


async def _mock_normalizer(signals: list[RawSignal]) -> list[RawSignal]:
    return signals


async def _mock_scorer(signals: list[RawSignal]) -> list[ScoredSignal]:
    return [
        ScoredSignal(
            signal_id=uuid4(), signal_intent="content_opportunity",
            final_score=0.7, semantic_relevance=0.7, volume_score=0.6,
            growth_score=0.8, freshness_score=1.0, commercial_score=0.5,
            text=s.text, source=s.source,
        ) for s in signals
    ]


async def _mock_brief_generator(scored: list[ScoredSignal]) -> list[TrendBrief]:
    return [
        TrendBrief(
            title=f"[MOCK] Oportunidad: {s.text[:40]}",
            description="Brief generado por mock — sin llamada a LLM.",
            signal_intent=s.signal_intent,
            recommended_action="activa esto ya",
            time_window="esta_semana",
            confidence="media",
            evidence_chain=[{"signal_id": str(s.signal_id), "score": s.final_score}],
            rationale_commercial="Mock rationale.",
        ) for s in scored[:3]
    ]


# ── Persistencia trend_query_jobs ────────────────────────────────────────────
async def _resolve_organization_id(brand_container_id: str) -> str:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                          headers=H,
                          params={"id": f"eq.{brand_container_id}",
                                  "select": "organization_id", "limit": 1})
        r.raise_for_status()
        rows = r.json()
        if not rows:
            raise ValueError(f"brand_container {brand_container_id} not found")
        return rows[0]["organization_id"]


async def _create_job_row(brand_container_id: str, cycle_id: str,
                          organization_id: str) -> str:
    body = {
        "organization_id": organization_id,
        "brand_container_id": brand_container_id,
        "cycle_id": cycle_id,
        "status": "running",
    }
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(f"{SUPABASE_URL}/rest/v1/trend_query_jobs",
                           headers=H, json=body)
        r.raise_for_status()
        return r.json()[0]["id"]


async def _update_job_row(job_id: str, **patch: Any) -> None:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.patch(f"{SUPABASE_URL}/rest/v1/trend_query_jobs?id=eq.{job_id}",
                            headers={**H, "Prefer": "return=minimal"},
                            json=patch)
        r.raise_for_status()


async def _sum_cycle_cost(cycle_id: str) -> float:
    """Suma usd_cost de credit_usage donde source_id=cycle_id."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/credit_usage",
            headers=H,
            params={"source_id": f"eq.{cycle_id}", "select": "usd_cost"},
        )
    if r.status_code != 200:
        return 0.0
    return sum(float(row.get("usd_cost") or 0) for row in r.json())


# ── Real pipeline (mock=False) ───────────────────────────────────────────────
async def _run_collector(query: TrendQuery, brand_container_id: str,
                          organization_id: str, cycle_id: str
                          ) -> list[RawSignal]:
    """Despacha a primer provider de query.target_apis con tagging de cycle_id."""
    from .collectors import get_collector

    if not query.target_apis:
        return []
    provider = query.target_apis[0]
    coll = get_collector(provider)
    if coll is None:
        log.warning("no collector for provider=%s", provider)
        return []

    sigs = await coll.collect(
        query,
        brand_container_id=brand_container_id,
        organization_id=organization_id,
        cycle_id=cycle_id,
    )
    for s in sigs:
        s.query_id = s.query_id or query.keyword
    return sigs


async def _collect_all(queries: list[TrendQuery], brand_container_id: str,
                        organization_id: str, cycle_id: str) -> list[RawSignal]:
    """Agrupa queries por provider y usa collect_batch cuando el collector
    soporta batch (1 Apify run con N queries). Fallback a 1×1 para collectors
    sin batch.

    Antes: 1 Apify run por query → 30 queries = 30 runs.
    Ahora: 1 Apify run por provider → 30 queries = ~4 runs (uno por provider).
    """
    from .collectors import get_collector
    from collections import defaultdict

    # 1. Agrupar queries por provider (primer target_api)
    by_provider: dict[str, list[TrendQuery]] = defaultdict(list)
    for q in queries:
        if not q.target_apis:
            continue
        by_provider[q.target_apis[0]].append(q)

    # 2. Para cada provider, decidir batch vs 1×1
    out: list[RawSignal] = []
    sem = asyncio.Semaphore(CONCURRENCY)  # paralelismo entre providers

    async def _run_provider(provider: str, qs: list[TrendQuery]) -> list[RawSignal]:
        async with sem:
            coll = get_collector(provider)
            if coll is None:
                log.warning("no collector for provider=%s", provider)
                return []
            try:
                grouped = await coll.collect_batch(
                    qs,
                    brand_container_id=brand_container_id,
                    organization_id=organization_id,
                    cycle_id=cycle_id,
                )
            except Exception as e:
                log.warning("collect_batch failed provider=%s err=%s",
                            provider, str(e)[:200])
                return []
            sigs_out: list[RawSignal] = []
            for q in qs:
                for s in grouped.get(q.keyword, []):
                    s.query_id = s.query_id or q.keyword
                    sigs_out.append(s)
            return sigs_out

    results = await asyncio.gather(
        *[_run_provider(p, qs) for p, qs in by_provider.items()],
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, Exception):
            log.warning("collect_all (batch): provider failed err=%s", r)
            continue
        out.extend(r)
    return out


# ── Punto de entrada ──────────────────────────────────────────────────────────
async def run_cycle(brand_container_id: str, mock: bool = True,
                     max_queries: int | None = None) -> dict[str, Any]:
    """Corre un ciclo completo del pipeline.

    max_queries: override de TRENDS_QUERY_HARD_CAP (útil para smoke tests).
    """
    cycle_id = str(uuid4())
    organization_id = await _resolve_organization_id(brand_container_id)
    job_id = await _create_job_row(brand_container_id, cycle_id, organization_id)

    log.info("trends.run_cycle started job=%s brand=%s cycle=%s mock=%s",
             job_id, brand_container_id, cycle_id, mock)

    try:
        if mock:
            queries = await _mock_query_generator(brand_container_id, cycle_id)
            signals_raw = await _mock_collectors(queries)
            signals_filtered = await _mock_normalizer(signals_raw)
            scored = await _mock_scorer(signals_filtered)
            briefs = await _mock_brief_generator(scored)
            persisted_ids: list[str] = []
        else:
            from .query_generator import generate_queries
            from .normalizer import normalize
            from .scorer import score_signals
            from .brief_generator import generate_briefs
            from .persistence import persist_scored_signals

            queries = await generate_queries(brand_container_id, cycle_id)
            cap = max_queries if max_queries and max_queries > 0 else QUERY_HARD_CAP
            if len(queries) > cap:
                log.info("query cap applied: %d → %d", len(queries), cap)
                queries = sorted(queries, key=lambda q: q.priority, reverse=True)[:cap]

            signals_raw = await _collect_all(queries, brand_container_id,
                                               organization_id, cycle_id)
            signals_filtered = await normalize(signals_raw, brand_container_id)
            scored = await score_signals(signals_filtered, brand_container_id)

            # Inyectar trigger_keyword del query original en el metadata de cada scored
            # (best-effort: matching por texto que aparezca en signal.text)
            for s in scored:
                if not s.metadata.get("trigger_keyword"):
                    for q in queries:
                        if q.keyword.lower() in (s.text or "").lower():
                            s.metadata["trigger_keyword"] = q.keyword
                            break

            # Brand-safety: filtra señales off-topic/NSFW antes de persistir y de
            # generar briefs — evita que basura de fuentes externas llegue a la org.
            from .brand_safety import filter_safe_signals
            scored = await filter_safe_signals(scored, brand_container_id)

            # ANTI-SELF (decision JC 2026-07-15): los ads/posts de la PROPIA marca
            # que los collectors traen al buscar keywords del nicho (p.ej. su ad
            # en Meta Ads Library) NO son senal de mercado — la marca no compite
            # contra si misma. Se descartan por page_name/handle == nombre_marca.
            scored = _drop_own_brand_signals(scored, brand_container_id)

            persisted_ids = await persist_scored_signals(scored, brand_container_id)
            briefs = await generate_briefs(scored, brand_container_id, batch_id=cycle_id)

        total_cost = await _sum_cycle_cost(cycle_id) if not mock else 0.0

        await _update_job_row(
            job_id,
            status="completed",
            completed_at=datetime.now(timezone.utc).isoformat(),
            total_queries_generated=len(queries),
            total_queries_executed=len(queries),
            total_signals_collected=len(signals_raw),
            total_signals_passed_filter=len(signals_filtered),
            total_signals_scored=len(scored),
            total_briefs_generated=len(briefs),
            total_cost_usd=total_cost,
            metadata={"mode": "mock" if mock else "real",
                       "phase": 1 if mock else 5,
                       "persisted_signal_ids": persisted_ids[:50]},
        )
        log.info("trends.run_cycle completed job=%s briefs=%d cost=$%.4f",
                 job_id, len(briefs), total_cost)

        return {
            "ok": True,
            "job_id": job_id,
            "cycle_id": cycle_id,
            "mode": "mock" if mock else "real",
            "queries": len(queries),
            "signals_raw": len(signals_raw),
            "signals_filtered": len(signals_filtered),
            "scored": len(scored),
            "briefs": len(briefs),
            "total_cost_usd": total_cost,
        }
    except Exception as e:
        log.exception("trends.run_cycle failed job=%s", job_id)
        await _update_job_row(
            job_id,
            status="failed",
            completed_at=datetime.now(timezone.utc).isoformat(),
            error_message=str(e)[:500],
        )
        raise


def _normalize_brand_token(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


_BRAND_NAME_CACHE: dict = {}


def _drop_own_brand_signals(scored, brand_container_id: str):
    """Descarta senales cuyo page_name/handle es la propia marca (anti-self)."""
    try:
        name = _BRAND_NAME_CACHE.get(brand_container_id)
        if name is None:
            import httpx as _hx
            r = _hx.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                        headers=H,
                        params={"id": f"eq.{brand_container_id}",
                                "select": "nombre_marca"}, timeout=15)
            rows = r.json() if r.status_code == 200 else []
            name = (rows[0].get("nombre_marca") if rows else "") or ""
            _BRAND_NAME_CACHE[brand_container_id] = name
        token = _normalize_brand_token(name)
        if not token or len(token) < 4:
            return scored
        kept, dropped = [], 0
        for s in scored:
            page = _normalize_brand_token(
                (s.raw_payload or {}).get("page_name", "") if hasattr(s, "raw_payload") and s.raw_payload else
                (s.metadata or {}).get("page_name", ""))
            if page and (token in page or page in token):
                dropped += 1
                continue
            kept.append(s)
        if dropped:
            log.info("anti-self: %d senal(es) de la propia marca descartadas (%s)",
                     dropped, name)
        return kept
    except Exception as e:  # nunca bloquear el ciclo por este filtro
        log.warning("anti-self filter fallo (no bloquea): %s", e)
        return scored
