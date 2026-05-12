"""Wrapper sobre external_api_cache con TTL configurable.

Patrón:
  cache_key = sha1(provider + ":" + query + ":" + geo + ":" + extra)
  TTL: 24h trends, 6h news, 12h SERPs (configurable por provider).

Ref: blueprint sec. 5 regla 6 ("Cache agresivo").
"""
from __future__ import annotations
import hashlib
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# TTL por provider en segundos
TTL_DEFAULTS: dict[str, int] = {
    "dataforseo_trends": 24 * 3600,
    "dataforseo_news":    6 * 3600,
    "dataforseo_serp":   12 * 3600,
    "dataforseo_amazon": 12 * 3600,
    "meta_ads_library":  24 * 3600,
    "apify_tiktok":      12 * 3600,
    "apify_instagram":   12 * 3600,
    "apify_reddit":      12 * 3600,
    "default":           24 * 3600,
}


def make_cache_key(provider: str, query: str, geo: str = "", extra: str = "") -> str:
    raw = f"{provider}:{query}:{geo}:{extra}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


async def get(cache_key: str) -> dict[str, Any] | None:
    """Devuelve payload si hay hit válido (no expirado), None si miss."""
    now_iso = datetime.now(timezone.utc).isoformat()
    async with httpx.AsyncClient(timeout=8) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/external_api_cache",
            headers=H,
            params={
                "cache_key": f"eq.{cache_key}",
                "expires_at": f"gt.{now_iso}",
                "select": "payload",
                "limit": 1,
            },
        )
        if r.status_code != 200:
            return None
        rows = r.json()
        return rows[0]["payload"] if rows else None


async def set_(cache_key: str, payload: dict[str, Any], provider: str,
               brand_container_id: str | None = None,
               ttl_seconds: int | None = None) -> None:
    """Upsert por cache_key (PK) con TTL del provider."""
    ttl = ttl_seconds or TTL_DEFAULTS.get(provider, TTL_DEFAULTS["default"])
    expires = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()
    body = {
        "cache_key": cache_key,
        "provider": provider,
        "brand_container_id": brand_container_id,
        "payload": payload,
        "expires_at": expires,
    }
    async with httpx.AsyncClient(timeout=8) as cli:
        await cli.post(
            f"{SUPABASE_URL}/rest/v1/external_api_cache?on_conflict=cache_key",
            headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=body,
        )
