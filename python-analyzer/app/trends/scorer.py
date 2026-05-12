"""Scorer semántico con embeddings (Fase 4).

Pipeline:
  1. Compone brand_identity_text desde brand_container.
  2. Embed brand identity → cachea 7 días en external_api_cache.
  3. Embed batch todos los signal.text con OpenAI text-embedding-3-small.
  4. Cosine similarity = semantic_relevance.
  5. Sub-scores normalizados [0,1]: volume, growth, freshness, commercial.
  6. final_score = weighted sum.
  7. signal_intent = rule-based classification (source + patterns).
  8. Top-K con diversidad: max N por signal_intent.

Sin LLM (memoria: feedback_no_llm_in_background). Embeddings sancionados.
Ref: blueprint sec. 10.
"""
from __future__ import annotations
import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx

from . import cache
from .embeddings.openai_provider import OpenAIEmbeddingProvider
from .models import RawSignal, ScoredSignal

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

log = logging.getLogger(__name__)

TOP_K = int(os.environ.get("TRENDS_TOP_K", "10"))
MAX_PER_INTENT = int(os.environ.get("TRENDS_MAX_PER_INTENT", "4"))
BRAND_IDENTITY_TTL_S = 7 * 24 * 3600

# Pesos del final_score (suman 1.0)
W_SEMANTIC   = 0.45
W_VOLUME     = 0.15
W_GROWTH     = 0.15
W_FRESHNESS  = 0.15
W_COMMERCIAL = 0.10


# ── Brand identity ───────────────────────────────────────────────────────────
async def _fetch_brand(brand_container_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_containers",
            headers=H,
            params={"id": f"eq.{brand_container_id}",
                    "select": ("id,nombre_marca,nicho_core,sub_nichos,palabras_clave,"
                               "mercado_objetivo,idiomas_contenido"),
                    "limit": 1},
        )
        r.raise_for_status()
        rows = r.json()
    if not rows:
        raise ValueError(f"brand_container {brand_container_id} not found")
    return rows[0]


def _compose_brand_identity_text(brand: dict) -> str:
    parts = []
    if brand.get("nombre_marca"):
        parts.append(f"Marca: {brand['nombre_marca']}")
    if brand.get("nicho_core"):
        parts.append(f"Nicho: {brand['nicho_core']}")
    if brand.get("sub_nichos"):
        sn = ", ".join(s for s in brand["sub_nichos"][:5] if s)
        if sn:
            parts.append(f"Sub-nichos: {sn}")
    if brand.get("palabras_clave"):
        kw = ", ".join(k for k in brand["palabras_clave"][:10] if k)
        if kw:
            parts.append(f"Palabras clave: {kw}")
    return ". ".join(parts) or "marca sin contexto"


async def _get_or_compute_brand_vector(
    brand_container_id: str, provider: OpenAIEmbeddingProvider,
) -> list[float]:
    ckey = cache.make_cache_key("brand_identity_embedding",
                                  brand_container_id, "", provider.model)
    cached = await cache.get(ckey)
    if cached and cached.get("vector"):
        return cached["vector"]

    brand = await _fetch_brand(brand_container_id)
    text = _compose_brand_identity_text(brand)
    vec = await provider.embed_async(text)
    if vec:
        await cache.set_(
            ckey,
            {"vector": vec, "text": text, "model": provider.model,
             "computed_at": datetime.now(timezone.utc).isoformat()},
            provider="brand_identity_embedding",
            brand_container_id=brand_container_id,
            ttl_seconds=BRAND_IDENTITY_TTL_S,
        )
    return vec


# ── Math helpers ─────────────────────────────────────────────────────────────
def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _norm_volume(v: int | None) -> float:
    if not v or v <= 0:
        return 0.0
    # log10 norm: 100 → 0.5, 10k → ~0.75, 1M → 1.0
    return min(1.0, math.log10(v) / 6.0)


def _norm_growth(s: RawSignal) -> float:
    if s.rising:
        return 0.85
    if s.growth_pct is None:
        return 0.4
    if s.growth_pct >= 50:
        return 1.0
    if s.growth_pct >= 20:
        return 0.7
    if s.growth_pct >= 0:
        return 0.5
    return 0.2


def _norm_freshness(s: RawSignal) -> float:
    if s.timestamp is None:
        return 0.5
    ts = s.timestamp if s.timestamp.tzinfo else s.timestamp.replace(tzinfo=timezone.utc)
    age_d = (datetime.now(timezone.utc) - ts).days
    if age_d <= 7:
        return 1.0
    if age_d <= 14:
        return 0.7
    if age_d <= 30:
        return 0.5
    return 0.3


def _norm_commercial(s: RawSignal) -> float:
    intent = (s.commercial_intent or "").lower()
    if intent == "transactional":
        return 1.0
    if intent == "commercial":
        return 0.85
    if intent == "informational":
        return 0.4
    return 0.5


# ── Intent classification (rule-based) ──────────────────────────────────────
INTENT_PATTERNS = [
    ("risk_competitor",     re.compile(r"\b(competidor|rival|vs |alternativa a)\b", re.I)),
    ("risk_brand",          re.compile(r"\b(scam|estafa|peligro|denuncia|reclamo)\b", re.I)),
    ("audience_insight",    re.compile(r"\b(c[oó]mo (?:hago|puedo|saber)|qu[eé] (?:hacer|elegir)|pregunta|opini[oó]n|me pas[oó])\b", re.I)),
    ("competitor_move",     re.compile(r"\b(lanz(?:a|ó|amos)|nuevo lanzamiento|launching)\b", re.I)),
    ("market_data",         re.compile(r"\b(mercado|industria|sector|reporte|estudio|informe|crece|crecimiento)\b", re.I)),
]

SOURCE_DEFAULT_INTENT = {
    "apify_reddit":     "audience_insight",
    "apify_tiktok":     "content_opportunity",
    "apify_instagram":  "content_opportunity",
    "meta_ads_library": "competitor_move",
    "newsapi":          "market_data",
}


def _classify_intent(s: RawSignal) -> str:
    text = s.text or ""
    for intent, pat in INTENT_PATTERNS:
        if pat.search(text):
            return intent
    return SOURCE_DEFAULT_INTENT.get(s.source, "content_opportunity")


# ── Top-K con diversidad ─────────────────────────────────────────────────────
def _diverse_top_k(scored: list[ScoredSignal], k: int, max_per_intent: int
                   ) -> list[ScoredSignal]:
    by_intent: dict[str, int] = {}
    out: list[ScoredSignal] = []
    for s in sorted(scored, key=lambda x: x.final_score, reverse=True):
        if len(out) >= k:
            break
        if by_intent.get(s.signal_intent, 0) >= max_per_intent:
            continue
        out.append(s)
        by_intent[s.signal_intent] = by_intent.get(s.signal_intent, 0) + 1
    # Si quedó corto por max_per_intent, rellenar sin restricción.
    if len(out) < k:
        used_ids = {id(s) for s in out}
        for s in sorted(scored, key=lambda x: x.final_score, reverse=True):
            if len(out) >= k:
                break
            if id(s) not in used_ids:
                out.append(s)
    return out


# ── Punto de entrada ─────────────────────────────────────────────────────────
async def score_signals(signals: list[RawSignal], brand_container_id: str
                        ) -> list[ScoredSignal]:
    """Rankea señales con embeddings + sub-scores. Devuelve top-K diverso."""
    if not signals:
        return []

    provider = OpenAIEmbeddingProvider()
    brand_vec = await _get_or_compute_brand_vector(brand_container_id, provider)
    if not brand_vec:
        log.warning("scorer: brand vector empty, semantic_relevance will be 0")

    texts = [s.text for s in signals]
    sig_vecs = await provider.embed_batch_async(texts)

    scored: list[ScoredSignal] = []
    for s, v in zip(signals, sig_vecs):
        sem = _cosine(brand_vec, v) if brand_vec and v else 0.0
        sem = max(0.0, min(1.0, (sem + 1.0) / 2.0))  # [-1,1] → [0,1]
        vol  = _norm_volume(s.search_volume)
        gro  = _norm_growth(s)
        fre  = _norm_freshness(s)
        com  = _norm_commercial(s)
        final = (W_SEMANTIC * sem + W_VOLUME * vol + W_GROWTH * gro
                 + W_FRESHNESS * fre + W_COMMERCIAL * com)
        intent = _classify_intent(s)
        scored.append(ScoredSignal(
            signal_id=uuid4(),
            signal_intent=intent,
            final_score=round(final, 4),
            semantic_relevance=round(sem, 4),
            volume_score=round(vol, 4),
            growth_score=round(gro, 4),
            freshness_score=round(fre, 4),
            commercial_score=round(com, 4),
            text=s.text,
            source=s.source,
            metadata={
                "geo": s.geo, "language": s.language,
                "keyword_origin": s.keyword_origin,
                "raw_payload": s.raw_payload,
                "timestamp": s.timestamp.isoformat() if s.timestamp else None,
            },
        ))

    top = _diverse_top_k(scored, TOP_K, MAX_PER_INTENT)
    log.info("scorer: in=%d scored=%d top=%d cost_usd=%.6f",
             len(signals), len(scored), len(top), provider.last_cost_usd)
    # Preserva el costo del provider en el último item (para tracking aguas arriba)
    if top:
        top[0].metadata["embedding_cost_usd"] = provider.last_cost_usd
        top[0].metadata["embedding_tokens"] = provider._last_tokens
    return top
