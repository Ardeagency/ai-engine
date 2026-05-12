"""Collectors — recolectores por proveedor externo.

Cada collector implementa BaseCollector.fetch_raw(query) → (signals, usd_cost).
Auth, rate limiting y parsing son responsabilidad del collector. Cache + costo
los maneja BaseCollector.collect() automáticamente.

Stack MVP (sin DataForSEO):
  - apify_tiktok / apify_instagram / apify_reddit  (vía APIFY_API_TOKEN)
  - meta_ads_library                               (vía actor Apify)
  - newsapi                                        (vía NEWSAPI_KEY)

Para reactivar DataForSEO: agregar collectors/dataforseo.py + credenciales y
sumar 'dataforseo' a APIS_BY_ORIGIN en query_generator.py.

Ref: blueprint sec. 8.
"""
from __future__ import annotations

from .apify_instagram import ApifyInstagramCollector
from .apify_reddit import ApifyRedditCollector
from .apify_tiktok import ApifyTikTokCollector
from .meta_ads_library import MetaAdsLibraryCollector
from .newsapi import NewsApiCollector

# Registry: provider → collector class. Usado por orchestrator para dispatch.
COLLECTORS: dict[str, type] = {
    "apify_tiktok":     ApifyTikTokCollector,
    "apify_instagram":  ApifyInstagramCollector,
    "apify_reddit":     ApifyRedditCollector,
    "meta_ads_library": MetaAdsLibraryCollector,
    "newsapi":          NewsApiCollector,
}


def get_collector(provider: str):
    """Devuelve instancia del collector registrado, None si no existe."""
    cls = COLLECTORS.get(provider)
    return cls() if cls else None


__all__ = [
    "COLLECTORS",
    "get_collector",
    "ApifyInstagramCollector",
    "ApifyRedditCollector",
    "ApifyTikTokCollector",
    "MetaAdsLibraryCollector",
    "NewsApiCollector",
]
