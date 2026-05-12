"""Helper compartido para collectors Apify (TikTok / Instagram / Reddit / Meta Ads).

Apify cobra por "platform usage units" + storage. Estimación rough por resultado:
  tiktok            ~$0.0003/post
  instagram         ~$0.0020/post
  reddit_lite       ~$0.0010/post
  facebook_ads_lib  ~$0.0005/ad
"""
from __future__ import annotations
import logging
import os
from typing import Any

import httpx

APIFY_TOKEN = os.environ.get("APIFY_API_TOKEN", "")
APIFY_BASE = "https://api.apify.com/v2"

log = logging.getLogger(__name__)


async def run_actor(actor_id: str, actor_input: dict[str, Any],
                     timeout_s: int = 90) -> list[dict[str, Any]]:
    """Run-sync helper. Devuelve [] si falla. Actor IDs en formato user~name."""
    if not APIFY_TOKEN:
        log.warning("APIFY_API_TOKEN not set, skipping actor=%s", actor_id)
        return []
    url = f"{APIFY_BASE}/acts/{actor_id}/run-sync-get-dataset-items"
    params = {"token": APIFY_TOKEN, "timeout": str(timeout_s)}
    async with httpx.AsyncClient(timeout=timeout_s + 10) as cli:
        r = await cli.post(url, params=params, json=actor_input)
    if r.status_code >= 400:
        log.warning("apify actor=%s failed status=%d body=%s",
                    actor_id, r.status_code, r.text[:200])
        return []
    try:
        data = r.json()
    except Exception:
        return []
    return data if isinstance(data, list) else []
