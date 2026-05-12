"""Generador de queries dinámicas (Fase 2).

Compone queries en runtime desde la data de la marca usando 7 entidades
generadoras (product, service, audience_persona, campaign, pillar,
competitor_vocabulary, niche). Aplica filtros de seguridad antes de devolver.

Ref: blueprint sec. 4 (entidades), sec. 7 (lógica + reglas API).
"""
from __future__ import annotations
import os
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import httpx

from .geo_resolver import resolve_geos
from .models import TrendQuery

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

# Top N por entidad (blueprint sec. 7, llamadas compose_*_queries)
TOP_PRODUCTS = 10
TOP_SERVICES = 5
TOP_PERSONAS = 5
TOP_CAMPAIGNS = 3
TOP_PILLARS = 5
TOP_COMPETITOR_HASHTAGS = 5
TOP_COMPETITOR_TOPICS = 5
TOP_KEYWORDS_NICHE = 3
COMPETITOR_LOOKBACK_DAYS = 30
DEFAULT_PLAN_CAP = 100  # si la org no tiene subscription activa

# Reglas keyword_origin → APIs (stack MVP sin DataForSEO).
# Reactivar DataForSEO: agregar provider 'dataforseo' a las listas cuando haya
# credenciales (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD en .env).
APIS_BY_ORIGIN: dict[str, list[str]] = {
    "product":               ["meta_ads_library", "apify_tiktok", "newsapi"],
    "service":               ["meta_ads_library", "apify_tiktok"],
    "audience_persona":      ["apify_reddit", "apify_instagram"],
    "campaign":              ["meta_ads_library", "newsapi"],
    "pillar":                ["apify_tiktok", "apify_instagram"],
    "competitor_vocabulary": ["meta_ads_library", "apify_tiktok", "apify_instagram"],
    "niche":                 ["newsapi", "apify_reddit", "apify_tiktok"],
}


# ── Helpers de fetching ──────────────────────────────────────────────────────
async def _get(cli: httpx.AsyncClient, path: str, **params: Any) -> list[dict]:
    r = await cli.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=H, params=params)
    r.raise_for_status()
    return r.json()


async def fetch_brand_context(brand_container_id: str) -> dict[str, Any]:
    """Carga brand_container con todos los campos de filtros + scoping."""
    async with httpx.AsyncClient(timeout=10) as cli:
        rows = await _get(
            cli, "brand_containers",
            id=f"eq.{brand_container_id}",
            select=("id,organization_id,nicho_core,sub_nichos,palabras_clave,"
                    "palabras_prohibidas,mercado_objetivo,idiomas_contenido,nombre_marca"),
            limit=1,
        )
    if not rows:
        raise ValueError(f"brand_container {brand_container_id} not found")
    return rows[0]


async def fetch_blacklist() -> set[str]:
    """Carga classifier_blacklist global como set de palabras lowercased."""
    async with httpx.AsyncClient(timeout=10) as cli:
        rows = await _get(cli, "classifier_blacklist", select="word")
    return {(r.get("word") or "").lower().strip() for r in rows if r.get("word")}


async def get_plan_cap(organization_id: str) -> int:
    """Resuelve scraping_daily_cap del plan activo de la org. Default si no hay."""
    async with httpx.AsyncClient(timeout=10) as cli:
        subs = await _get(
            cli, "subscriptions",
            organization_id=f"eq.{organization_id}",
            status="eq.active",
            select="plan_id",
            order="updated_at.desc",
            limit=1,
        )
        if not subs:
            return DEFAULT_PLAN_CAP
        plan_id = subs[0]["plan_id"]
        plans = await _get(
            cli, "plans",
            id=f"eq.{plan_id}",
            select="scraping_daily_cap",
            limit=1,
        )
    if not plans or plans[0].get("scraping_daily_cap") is None:
        return DEFAULT_PLAN_CAP
    return int(plans[0]["scraping_daily_cap"])


async def fetch_products(organization_id: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as cli:
        return await _get(
            cli, "products",
            organization_id=f"eq.{organization_id}",
            select="id,nombre_producto,beneficios_principales,casos_de_uso,materiales_composicion",
            order="updated_at.desc",
            limit=limit,
        )


async def fetch_services(organization_id: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as cli:
        return await _get(
            cli, "services",
            organization_id=f"eq.{organization_id}",
            select="id,nombre_servicio,entregables,casos_de_uso",
            order="updated_at.desc",
            limit=limit,
        )


async def fetch_personas(brand_container_id: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as cli:
        return await _get(
            cli, "audience_personas",
            brand_container_id=f"eq.{brand_container_id}",
            select="id,name,dolores,deseos,gatillos_compra",
            order="updated_at.desc",
            limit=limit,
        )


async def fetch_active_campaigns(brand_container_id: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as cli:
        return await _get(
            cli, "campaign_briefs",
            brand_container_id=f"eq.{brand_container_id}",
            status="eq.active",
            select="id,nombre,oferta_principal,contexto_temporal,angulos_venta",
            order="updated_at.desc",
            limit=limit,
        )


async def fetch_pillars(brand_container_id: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as cli:
        return await _get(
            cli, "brand_narrative_pillars",
            brand_container_id=f"eq.{brand_container_id}",
            select="id,pillar_name,description,post_count",
            order="post_count.desc.nullslast",
            limit=limit,
        )


async def extract_competitor_vocabulary(
    brand_container_id: str, days_back: int = COMPETITOR_LOOKBACK_DAYS
) -> tuple[list[str], list[str]]:
    """Top hashtags + topics de posts de competidores en últimos N días."""
    since = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    async with httpx.AsyncClient(timeout=15) as cli:
        rows = await _get(
            cli, "brand_posts",
            brand_container_id=f"eq.{brand_container_id}",
            post_source="eq.competitor",
            captured_at=f"gte.{since}",
            select="hashtags,topics",
            limit=2000,
        )
    hashtags: Counter[str] = Counter()
    topics: Counter[str] = Counter()
    for r in rows:
        for h in (r.get("hashtags") or []):
            if h:
                hashtags[str(h).lstrip("#").lower().strip()] += 1
        for t in (r.get("topics") or []):
            if t:
                topics[str(t).lower().strip()] += 1
    top_h = [w for w, _ in hashtags.most_common(TOP_COMPETITOR_HASHTAGS) if w]
    top_t = [w for w, _ in topics.most_common(TOP_COMPETITOR_TOPICS) if w]
    return top_h, top_t


# ── Composers por entidad ────────────────────────────────────────────────────
def _q(keyword: str, origin: str, source_id: UUID | str | None,
       geo: str, language: str, priority: int = 5) -> TrendQuery:
    return TrendQuery(
        keyword=keyword.strip(),
        keyword_origin=origin,
        source_entity_id=UUID(str(source_id)) if source_id else None,
        geo=geo,
        language=language,
        target_apis=APIS_BY_ORIGIN.get(origin, []),
        priority=priority,
    )


def _first(arr: list[Any] | None) -> str | None:
    if not arr:
        return None
    v = arr[0]
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def compose_product_queries(p: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    name = (p.get("nombre_producto") or "").strip()
    if not name:
        return out
    pid = p["id"]
    out.append(_q(name, "product", pid, geo, lang, priority=8))
    benefit = _first(p.get("beneficios_principales"))
    if benefit:
        out.append(_q(f"{name} {benefit}", "product", pid, geo, lang, priority=7))
    material = _first(p.get("materiales_composicion"))
    if material:
        out.append(_q(f"{material} tendencia", "product", pid, geo, lang, priority=6))
    use_case = _first(p.get("casos_de_uso"))
    if use_case:
        out.append(_q(f"{use_case} mejor opción", "product", pid, geo, lang, priority=6))
    return out


def compose_service_queries(s: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    name = (s.get("nombre_servicio") or "").strip()
    if not name:
        return out
    sid = s["id"]
    out.append(_q(f"{name} cómo funciona", "service", sid, geo, lang, priority=7))
    deliverable = _first(s.get("entregables"))
    if deliverable:
        out.append(_q(f"{deliverable} precio", "service", sid, geo, lang, priority=6))
    use_case = _first(s.get("casos_de_uso"))
    if use_case:
        out.append(_q(f"{use_case} solución", "service", sid, geo, lang, priority=6))
    return out


def compose_persona_queries(p: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    pid = p["id"]
    pain = _first(p.get("dolores"))
    if pain:
        out.append(_q(f"cómo solucionar {pain}", "audience_persona", pid, geo, lang, priority=7))
    desire = _first(p.get("deseos"))
    if desire:
        out.append(_q(f"{desire} mejor", "audience_persona", pid, geo, lang, priority=6))
    trigger = _first(p.get("gatillos_compra"))
    if trigger:
        out.append(_q(f"comprar {trigger}", "audience_persona", pid, geo, lang, priority=6))
    return out


def compose_campaign_queries(c: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    name = (c.get("nombre") or "").strip()
    if not name:
        return out
    cid = c["id"]
    out.append(_q(name, "campaign", cid, geo, lang, priority=8))
    temporal = _first(c.get("contexto_temporal"))
    if temporal:
        out.append(_q(f"{name} {temporal}", "campaign", cid, geo, lang, priority=7))
    return out


def compose_pillar_queries(pl: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    name = (pl.get("pillar_name") or "").strip()
    if not name:
        return out
    pid = pl["id"]
    year = datetime.now(timezone.utc).year
    out.append(_q(f"{name} tendencia", "pillar", pid, geo, lang, priority=6))
    out.append(_q(f"{name} {year}", "pillar", pid, geo, lang, priority=6))
    return out


def compose_competitor_vocab_queries(hashtags: list[str], topics: list[str],
                                     geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    for h in hashtags:
        out.append(_q(h, "competitor_vocabulary", None, geo, lang, priority=7))
    for t in topics:
        out.append(_q(t, "competitor_vocabulary", None, geo, lang, priority=6))
    return out


def compose_niche_queries(brand: dict, geo: str, lang: str) -> list[TrendQuery]:
    out: list[TrendQuery] = []
    nicho = (brand.get("nicho_core") or "").strip()
    if nicho:
        out.append(_q(f"{nicho} tendencia hoy", "niche", brand["id"], geo, lang, priority=7))
    for sn in (brand.get("sub_nichos") or [])[:5]:
        if sn and sn.strip():
            out.append(_q(f"{sn.strip()} viral", "niche", brand["id"], geo, lang, priority=6))
    for kw in (brand.get("palabras_clave") or [])[:TOP_KEYWORDS_NICHE]:
        if kw and kw.strip():
            out.append(_q(f"{kw.strip()} tendencia", "niche", brand["id"], geo, lang, priority=5))
    return out


# ── Filtros de seguridad ─────────────────────────────────────────────────────
def _normalize(text: str) -> str:
    return " ".join(text.lower().split())


def _contains_any(text: str, words: set[str]) -> bool:
    norm = _normalize(text)
    return any(w in norm for w in words if w)


def filter_prohibited(queries: list[TrendQuery], prohibited: list[str] | None) -> list[TrendQuery]:
    if not prohibited:
        return queries
    pset = {(p or "").lower().strip() for p in prohibited if p}
    return [q for q in queries if not _contains_any(q.keyword, pset)]


def filter_blacklist(queries: list[TrendQuery], blacklist: set[str]) -> list[TrendQuery]:
    if not blacklist:
        return queries
    return [q for q in queries if not _contains_any(q.keyword, blacklist)]


def deduplicate(queries: list[TrendQuery]) -> list[TrendQuery]:
    """Dedupe por (keyword normalizada, geo). Conserva la más prioritaria."""
    by_key: dict[tuple[str, str], TrendQuery] = {}
    for q in queries:
        key = (_normalize(q.keyword), q.geo)
        existing = by_key.get(key)
        if existing is None or q.priority > existing.priority:
            by_key[key] = q
    return list(by_key.values())


def cap_total(queries: list[TrendQuery], cap: int) -> list[TrendQuery]:
    """Cap por priority desc, fallback al orden actual."""
    if cap <= 0 or len(queries) <= cap:
        return queries
    return sorted(queries, key=lambda q: q.priority, reverse=True)[:cap]


# ── Punto de entrada ──────────────────────────────────────────────────────────
async def generate_queries(brand_container_id: str, cycle_id: str | None = None
                           ) -> list[TrendQuery]:
    """Compone queries dinámicas para un ciclo. Ref: blueprint sec. 7."""
    brand = await fetch_brand_context(brand_container_id)
    organization_id = brand["organization_id"]
    raw_markets: list[str] = list(brand.get("mercado_objetivo") or ["CO"])
    geos = await resolve_geos(raw_markets)
    if not geos:
        geos = ["CO"]
    langs: list[str] = list(brand.get("idiomas_contenido") or ["es"])
    primary_lang = langs[0] if langs else "es"

    blacklist = await fetch_blacklist()
    cap = await get_plan_cap(organization_id)

    products  = await fetch_products(organization_id, TOP_PRODUCTS)
    services  = await fetch_services(organization_id, TOP_SERVICES)
    personas  = await fetch_personas(brand_container_id, TOP_PERSONAS)
    campaigns = await fetch_active_campaigns(brand_container_id, TOP_CAMPAIGNS)
    pillars   = await fetch_pillars(brand_container_id, TOP_PILLARS)
    comp_h, comp_t = await extract_competitor_vocabulary(brand_container_id)

    queries: list[TrendQuery] = []
    for geo in geos:
        lang = primary_lang
        for p in products:
            queries.extend(compose_product_queries(p, geo, lang))
        for s in services:
            queries.extend(compose_service_queries(s, geo, lang))
        for p in personas:
            queries.extend(compose_persona_queries(p, geo, lang))
        for c in campaigns:
            queries.extend(compose_campaign_queries(c, geo, lang))
        for pl in pillars:
            queries.extend(compose_pillar_queries(pl, geo, lang))
        queries.extend(compose_competitor_vocab_queries(comp_h, comp_t, geo, lang))
        queries.extend(compose_niche_queries(brand, geo, lang))

    queries = filter_prohibited(queries, brand.get("palabras_prohibidas"))
    queries = filter_blacklist(queries, blacklist)
    queries = deduplicate(queries)
    queries = cap_total(queries, cap)
    return queries
