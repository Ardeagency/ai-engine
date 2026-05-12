"""Orquesta describir media con cache global vía Supabase."""
import hashlib
import os
import httpx

from .image_describer import describe_image, describe_carousel, url_hash
from .video_describer import describe_video_url

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json", "Prefer": "return=representation"}


def cache_lookup(uhash: str) -> dict | None:
    with httpx.Client(timeout=10) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/media_descriptions_cache",
                    headers=H, params={"url_hash": f"eq.{uhash}", "select": "*"})
        rows = r.json() if r.status_code == 200 else []
        return rows[0] if rows else None


def cache_save(uhash: str, url: str, media_type: str, result: dict, organization_id: str | None):
    with httpx.Client(timeout=10) as cli:
        cli.post(f"{SUPABASE_URL}/rest/v1/media_descriptions_cache",
                 headers={**H, "Prefer": "resolution=ignore-duplicates"},
                 json={
                     "url_hash": uhash, "url": url, "media_type": media_type,
                     "description": result["description"], "model": result["model"],
                     "tokens_used": (result.get("tokens_in", 0) + result.get("tokens_out", 0)),
                     "usd_cost": result.get("usd_cost", 0),
                     "organization_id": organization_id,
                 })


def cache_increment_reuse(uhash: str):
    with httpx.Client(timeout=10) as cli:
        # No hay UPDATE atomic increment via REST API simple — usamos el endpoint con valor calculado
        existing = cache_lookup(uhash)
        if existing:
            cli.patch(f"{SUPABASE_URL}/rest/v1/media_descriptions_cache",
                      headers=H, params={"url_hash": f"eq.{uhash}"},
                      json={"reused_count": (existing.get("reused_count") or 0) + 1})


def charge_org(organization_id: str, usd_cost: float, kind: str, metadata: dict):
    """Cobra créditos por descripción de media (1 cr = $0.10)."""
    if not organization_id or not usd_cost:
        return
    credits = round(usd_cost * 10, 4)
    with httpx.Client(timeout=10) as cli:
        # Lee balance
        r = cli.get(f"{SUPABASE_URL}/rest/v1/organization_credits",
                    headers=H, params={"organization_id": f"eq.{organization_id}", "select": "credits_available"})
        row = r.json()[0] if r.json() else None
        if not row:
            return
        bal = float(row["credits_available"])
        # Update + ledger
        cli.patch(f"{SUPABASE_URL}/rest/v1/organization_credits",
                  headers=H, params={"organization_id": f"eq.{organization_id}"},
                  json={"credits_available": bal - credits})
        cli.post(f"{SUPABASE_URL}/rest/v1/credit_usage",
                 headers=H, json={
                     "organization_id": organization_id, "kind": kind,
                     "credits_delta": -credits, "usd_cost": usd_cost,
                     "source_table": "media_descriptions_cache",
                     "source_id": metadata.get("url_hash"),
                     "metadata": metadata,
                 })


def describe_media(url: str, media_type: str, organization_id: str | None = None) -> dict:
    """
    Entry point: cache-aware describe.
    media_type ∈ {'image', 'video', 'carousel'}.
    Para carrusel pasar URL como '|||'.join(urls).
    """
    if not url:
        return {"error": "no_url"}

    if media_type == "carousel":
        urls = [u for u in url.split("|||") if u]
        uhash = hashlib.sha256("|||".join(sorted(urls)).encode()).hexdigest()
    else:
        uhash = url_hash(url)

    # 1. Cache lookup
    cached = cache_lookup(uhash)
    if cached:
        cache_increment_reuse(uhash)
        return {
            "description": cached["description"], "model": cached["model"],
            "cached": True, "url_hash": uhash, "usd_cost": 0,
        }

    # 2. Generate
    if media_type == "image":
        result = describe_image(url)
        kind = "claude_describe"
    elif media_type == "carousel":
        result = describe_carousel(urls)
        kind = "claude_describe"
    elif media_type == "video":
        result = describe_video_url(url)
        kind = "gemini_describe"
    else:
        return {"error": f"unknown media_type: {media_type}"}

    if "error" in result:
        return {**result, "url_hash": uhash}

    # 3. Cache + cobro
    cache_save(uhash, url, media_type, result, organization_id)
    charge_org(organization_id, result["usd_cost"], kind,
               {"url_hash": uhash, "media_type": media_type, "model": result["model"], "url": url[:200]})

    return {**result, "cached": False, "url_hash": uhash}
