"""Modelos de datos del trends engine.

Dataclasses compartidas por todas las etapas del pipeline. Sin lógica.
Ref: trends-engine-blueprint sec. 7 (TrendQuery), 8 (RawSignal), 10 (ScoredSignal),
11 (TrendBrief).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID


KEYWORD_ORIGINS = ("product", "service", "audience_persona", "campaign",
                   "pillar", "competitor_vocabulary", "niche")

SIGNAL_INTENTS = ("content_opportunity", "audience_insight", "competitor_move",
                  "market_data", "risk_brand", "risk_category", "risk_competitor")

RECOMMENDED_ACTIONS = ("activa esto ya", "reserva presupuesto", "cambia plan trimestre")

TIME_WINDOWS = ("esta_semana", "30d", "60d", "trimestre")


@dataclass
class TrendQuery:
    keyword: str
    keyword_origin: str
    source_entity_id: UUID | None
    geo: str
    language: str
    target_apis: list[str] = field(default_factory=list)
    priority: int = 5


@dataclass
class RawSignal:
    text: str
    source: str
    geo: str
    language: str
    timestamp: datetime
    search_volume: int | None = None
    growth_pct: float | None = None
    commercial_intent: str | None = None
    rising: bool = False
    raw_payload: dict[str, Any] = field(default_factory=dict)
    query_id: str | None = None
    keyword_origin: str | None = None


@dataclass
class ScoredSignal:
    signal_id: UUID
    signal_intent: str
    final_score: float
    semantic_relevance: float
    volume_score: float
    growth_score: float
    freshness_score: float
    commercial_score: float
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TrendBrief:
    title: str
    description: str
    signal_intent: str
    recommended_action: str
    time_window: str
    confidence: str
    evidence_chain: list[dict[str, Any]]
    rationale_commercial: str
    anchor_product_name: str | None = None
    campaign_link_name: str | None = None
    target_persona: str | None = None
    recommended_network: str | None = None
    copy_seed: str | None = None
    visual_brief: str | None = None
    what_to_avoid: list[str] = field(default_factory=list)
