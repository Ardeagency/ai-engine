"""Keyword Discovery Loop — flywheel de descubrimiento de terminos de alto valor.

Optimizacion del query_generator estatico: en vez de generar queries de un solo
tiro, ARRANCA de los nombres de productos/servicios (semilla), MIDE cada termino
con una fuente de senal enchufable (hoy Tavily), DESCUBRE terminos relacionados
reales de esos resultados, se QUEDA con los que superan a la semilla (fitness =
senal x relevancia), los REALIMENTA como nuevas semillas y PERSISTE todo en
trend_keyword_candidates para APRENDER y crecer entre corridas.

Gobernador de gasto (para no quemar creditos de Tavily):
- max_calls por ciclo = tope duro de llamadas a la fuente paga.
- cache (external_api_cache, TTL largo): un termino medido no se re-paga en dias.
- prefiltro de relevancia (embeddings, baratos) ANTES de gastar: solo el top-K
  por relevancia gasta una llamada (beam search).
- medicion por racimo: 1 llamada devuelve muchos resultados => de ahi salen los
  relacionados, sin llamadas extra.
- guarda mensual global: si se supera MONTHLY_CAP de llamadas, degrada (no revienta).
- convergencia: una rama deja de expandirse cuando sus hijos no superan al padre.

Fuente de senal ENCHUFABLE: SIGNAL_PROVIDER (env, default 'tavily'). Manana se
cambia a 'trends'/'newsapi'/'gdelt' sin tocar el loop.
"""
from __future__ import annotations

import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

import httpx

from . import cache
from .embeddings.openai_provider import OpenAIEmbeddingProvider
from .scorer import _get_or_compute_brand_vector, _cosine

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")
TAVILY_SEARCH_URL = "https://api.tavily.com/search"

# ── Gobernador de gasto (defaults conservadores; override por request/plan) ──
DEFAULT_MAX_CALLS = int(os.environ.get("KWLOOP_MAX_CALLS", "8"))     # por ciclo
DEFAULT_MAX_ROUNDS = int(os.environ.get("KWLOOP_MAX_ROUNDS", "2"))
DEFAULT_BEAM = int(os.environ.get("KWLOOP_BEAM", "4"))              # top-K por ronda
MONTHLY_CAP = int(os.environ.get("KWLOOP_MONTHLY_CAP", "800"))       # guarda global
TAVILY_TTL_S = int(os.environ.get("KWLOOP_TTL_S", str(10 * 24 * 3600)))  # 10 dias
TAVILY_MAX_RESULTS = 8
RELEVANCE_FLOOR = float(os.environ.get("KWLOOP_RELEVANCE_FLOOR", "0.15"))
CACHE_PROVIDER = "tavily_search"

TOP_SEED_PRODUCTS = int(os.environ.get("KWLOOP_SEED_PRODUCTS", "12"))
MAX_SEEDS = int(os.environ.get("KWLOOP_MAX_SEEDS", "30"))

# Stopwords GRAMATICALES (NO categoria — 'proteina' se conserva a proposito).
_STOP = set("""
de la el los las un una unos unas y o u que en a con por para su sus lo al del se es son
como mas más muy sobre entre este esta estos estas ese esa eso tu tus mi mis me te ya
""".split())

# Ruido de MARCA / FORMATO / SABOR / UNIDAD — se quita al limpiar semilla y relacionados.
# (ingredientes reales como maranon/almendras/huevo NO van aca: son tipo de producto.)
_NOISE = set("""
wake up wakeup shield arde sabor sabores kit pack bebida mezcla porcion porciones und unidad
vainilla chocolate cacao fresa toronja frutos rojos natural cookies cream mocha caramelo
edicion presentacion nuevo nueva original clasico premium x
""".split())

_UNIT_RE = re.compile(r"^\d+(?:[.,]\d+)?(?:g|gr|kg|mg|ml|l|oz|lb)?$")


_BRAND_PREFIX = ("wakeup", "wake", "shield")


def _is_noise_tok(t: str) -> bool:
    if t in _NOISE or bool(_UNIT_RE.match(t)) or t.isdigit():
        return True
    # tokens pegados tipo 'wakeup30g' o 'wakeupvainilla'
    return any(t.startswith(b) and t != b for b in _BRAND_PREFIX)


# ── Utilidades ───────────────────────────────────────────────────────────────
def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn")


def _normalize(term: str) -> str:
    t = _strip_accents((term or "").lower())
    t = re.sub(r"[^a-z0-9ñ ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _tokens(text: str) -> list[str]:
    return [w for w in _normalize(text).split()
            if len(w) > 2 and w not in _STOP and not _is_noise_tok(w)]


def _clean_seed(name: str) -> str | None:
    """SKU hiper-especifico -> nucleo de categoria.
    'Proteina De Huevo Wakeup 450g Vainilla' -> 'proteina huevo'."""
    toks = _tokens(name)
    if not toks:
        return None
    return " ".join(toks[:4])


async def _sb_get(cli: httpx.AsyncClient, path: str, **params) -> list[dict]:
    r = await cli.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=H, params=params)
    r.raise_for_status()
    return r.json()


# ── Semillas: nombres de productos/servicios + palabras clave ────────────────
async def _fetch_seeds(brand_container_id: str) -> tuple[str, list[str], str, str]:
    """Semillas de CATEGORIA (no SKUs): nucleos limpios de productos + palabras_clave
    + nicho_core + sub_nichos. Devuelve (organization_id, semillas, geo, lang)."""
    async with httpx.AsyncClient(timeout=10) as cli:
        rows = await _sb_get(
            cli, "brand_containers",
            id=f"eq.{brand_container_id}",
            select="organization_id,palabras_clave,nicho_core,sub_nichos,"
                   "mercado_objetivo,idiomas_contenido",
        )
        if not rows:
            raise ValueError(f"brand_container {brand_container_id} not found")
        brand = rows[0]
        org = brand["organization_id"]
        geo = (brand.get("mercado_objetivo") or ["CO"])[0]
        lang = (brand.get("idiomas_contenido") or ["es"])[0]
        products = await _sb_get(
            cli, "products",
            organization_id=f"eq.{org}",
            select="nombre_producto",
            order="updated_at.desc",
            limit=TOP_SEED_PRODUCTS,
        )

    seeds: list[str] = []
    seen: set[str] = set()

    def _add(raw: str | None):
        if not raw:
            return
        core = _clean_seed(raw)          # SIEMPRE limpia ruido/marca/unidad/sabor
        core = core.strip() if core else None
        if not core:
            return
        # descartar si quedo solo ruido/marca o 1 token demasiado generico corto
        if core in seen or core in _NOISE:
            return
        seen.add(core)
        seeds.append(core)

    # 1) nucleos de categoria desde nombres de producto (limpios)
    for p in products:
        _add(p.get("nombre_producto"))
    # 2) palabras clave de la marca (ya suelen ser de categoria)
    for kw in (brand.get("palabras_clave") or []):
        _add(kw)
    # 3) nicho + sub-nichos (categoria pura)
    _add(brand.get("nicho_core"))
    for sn in (brand.get("sub_nichos") or []):
        _add(sn)

    # priorizar semillas mas cortas (mas categoria, menos SKU)
    seeds.sort(key=lambda s: len(s.split()))
    return org, seeds[:MAX_SEEDS], geo, lang


# ── Fuente de senal (enchufable). Hoy: Tavily ────────────────────────────────
async def _measure_term(term: str, geo: str) -> dict[str, Any] | None:
    """Mide un termino. Cache-first. Devuelve payload {results:[...]} o None."""
    ckey = cache.make_cache_key(CACHE_PROVIDER, _normalize(term), geo)
    cached = await cache.get(ckey)
    if cached is not None:
        return {**cached, "_cached": True}
    if not TAVILY_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=25) as cli:
            r = await cli.post(
                TAVILY_SEARCH_URL,
                headers={"Authorization": f"Bearer {TAVILY_API_KEY}",
                         "Content-Type": "application/json"},
                json={"query": f"{term} {geo}".strip(),
                      "max_results": TAVILY_MAX_RESULTS,
                      "search_depth": "basic", "topic": "general"},
            )
        if r.status_code != 200:
            return None
        j = r.json()
        payload = {"results": j.get("results", []) or []}
        await cache.set_(ckey, payload, provider=CACHE_PROVIDER,
                         ttl_seconds=TAVILY_TTL_S)
        return {**payload, "_cached": False}
    except Exception:
        return None


def _signal_from(payload: dict[str, Any]) -> tuple[float, int]:
    """Senal 0..1 = mezcla de cantidad de resultados y relevancia media Tavily."""
    results = payload.get("results", []) or []
    n = len(results)
    if n == 0:
        return 0.0, 0
    scores = [float(r.get("score", 0) or 0) for r in results]
    avg = sum(scores) / len(scores) if scores else 0.0
    coverage = min(n / TAVILY_MAX_RESULTS, 1.0)
    return round(0.6 * avg + 0.4 * coverage, 4), n


def _related_terms(payload: dict[str, Any], seed_tokset: set[str],
                   seen: set[str], k: int) -> list[str]:
    """Descubre relacionados de CATEGORIA. Clave: (1) excluye n-gramas que sean
    subconjunto de la propia semilla (ruido intra-producto), (2) rankea por
    document-frequency = en cuantos RESULTADOS DISTINTOS aparece (senal de categoria
    amplia), no por repeticion dentro de una sola ficha de tienda."""
    df: dict[str, set[int]] = {}
    for idx, r in enumerate(payload.get("results", []) or []):
        toks = _tokens(f"{r.get('title','')} {r.get('content','')}")
        grams_here: set[str] = set()
        for i in range(len(toks) - 1):
            cands = [f"{toks[i]} {toks[i+1]}"]
            if i + 2 < len(toks):
                cands.append(f"{toks[i]} {toks[i+1]} {toks[i+2]}")
            for gram in cands:
                if gram in seen:
                    continue
                gt = set(gram.split())
                if gt <= seed_tokset:          # todo el gram esta en la semilla -> intra-producto
                    continue
                grams_here.add(gram)
        for gram in grams_here:
            df.setdefault(gram, set()).add(idx)
    # ranking: aparece en >=2 resultados distintos; ordenar por amplitud
    ranked = sorted(((g, len(idxs)) for g, idxs in df.items() if len(idxs) >= 2),
                    key=lambda kv: -kv[1])
    return [g for g, _ in ranked][:k]


# ── Persistencia (memoria del loop) ──────────────────────────────────────────
async def _persist(rows: list[dict]) -> None:
    if not rows:
        return
    async with httpx.AsyncClient(timeout=15) as cli:
        await cli.post(
            f"{SUPABASE_URL}/rest/v1/trend_keyword_candidates"
            "?on_conflict=brand_container_id,normalized_term",
            headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=rows,
        )


async def _month_calls() -> int:
    """Guarda global: cuantos terminos distintos se midieron este mes (proxy de gasto)."""
    start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0,
                                               second=0, microsecond=0).isoformat()
    try:
        async with httpx.AsyncClient(timeout=8) as cli:
            r = await cli.get(
                f"{SUPABASE_URL}/rest/v1/external_api_cache",
                headers={**H, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
                params={"provider": f"eq.{CACHE_PROVIDER}", "created_at": f"gte.{start}",
                        "select": "cache_key"},
            )
        cr = r.headers.get("content-range", "")
        return int(cr.split("/")[-1]) if "/" in cr else 0
    except Exception:
        return 0


# ── El loop ──────────────────────────────────────────────────────────────────
async def run_keyword_loop(brand_container_id: str, max_calls: int | None = None,
                           max_rounds: int | None = None, cycle_id: str | None = None
                           ) -> dict[str, Any]:
    max_calls = max_calls or DEFAULT_MAX_CALLS
    max_rounds = max_rounds or DEFAULT_MAX_ROUNDS
    beam = DEFAULT_BEAM

    org, seeds, geo, lang = await _fetch_seeds(brand_container_id)
    if not seeds:
        return {"ok": False, "reason": "no_seeds", "spent_calls": 0}

    month_before = await _month_calls()
    budget = max_calls
    if month_before >= MONTHLY_CAP:
        budget = 0  # guarda global: degrada, no gasta

    provider = OpenAIEmbeddingProvider()
    brand_vec = await _get_or_compute_brand_vector(brand_container_id, provider)

    async def _relevance(term: str) -> float:
        if not brand_vec:
            return 0.5
        v = await provider.embed_async(term)
        return round(max(0.0, _cosine(v, brand_vec)), 4) if v else 0.5

    seen: set[str] = set(_normalize(s) for s in seeds)
    # frontera inicial = semillas con su fitness-base (medidas a costo de presupuesto)
    frontier: list[dict] = [{"term": s, "seed": None, "generation": 0,
                             "parent_fitness": 0.0} for s in seeds]

    calls_used = 0
    persisted: list[dict] = []
    winners: list[dict] = []

    for rnd in range(max_rounds):
        if calls_used >= budget or not frontier:
            break
        # prefiltro por relevancia: solo el top-K gasta llamada
        for c in frontier:
            c["rel"] = await _relevance(c["term"])
        frontier.sort(key=lambda c: -c["rel"])
        batch = frontier[:min(beam, budget - calls_used)]

        next_frontier: list[dict] = []
        for c in batch:
            if calls_used >= budget:
                break
            payload = await _measure_term(c["term"], geo)
            if payload is None:
                continue
            if not payload.get("_cached"):
                calls_used += 1
            signal, nres = _signal_from(payload)
            rel = c["rel"]
            fitness = round(signal * rel, 4)
            promoted = (fitness > c["parent_fitness"]) and (rel >= RELEVANCE_FLOOR)

            persisted.append({
                "brand_container_id": brand_container_id,
                "organization_id": org,
                "cycle_id": cycle_id,
                "term": c["term"],
                "normalized_term": _normalize(c["term"]),
                "seed_term": c["seed"],
                "generation": c["generation"],
                "source": CACHE_PROVIDER,
                "signal_score": signal,
                "relevance": rel,
                "fitness": fitness,
                "num_results": nres,
                "is_promoted": promoted,
                "metadata": {"geo": geo, "round": rnd, "cached": payload.get("_cached", False)},
                "detected_at": datetime.now(timezone.utc).isoformat(),
            })
            if promoted:
                winners.append({"term": c["term"], "fitness": fitness,
                                "signal": signal, "relevance": rel, "num_results": nres})
                # descubrir relacionados => nuevas semillas de la siguiente ronda
                seed_tokset = set(_tokens(c["term"]))
                for rel_term in _related_terms(payload, seed_tokset, seen, k=beam):
                    seen.add(_normalize(rel_term))
                    next_frontier.append({"term": rel_term, "seed": c["term"],
                                          "generation": c["generation"] + 1,
                                          "parent_fitness": fitness})
        frontier = next_frontier

    await _persist(persisted)
    winners.sort(key=lambda w: -w["fitness"])
    return {
        "ok": True,
        "brand_container_id": brand_container_id,
        "geo": geo, "lang": lang,
        "seeds": len(seeds),
        "rounds": max_rounds,
        "spent_calls": calls_used,          # = creditos Tavily gastados este ciclo
        "budget": budget,
        "month_calls_before": month_before,
        "monthly_cap": MONTHLY_CAP,
        "measured": len(persisted),
        "promoted": len(winners),
        "top_winners": winners[:15],
        "embed_cost_usd": round(provider.last_cost_usd, 5),
    }
