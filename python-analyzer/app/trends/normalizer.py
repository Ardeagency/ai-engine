"""Normalizador + filtros duros sin IA (Fase 3).

Pipeline de reglas, en orden:
  1. freshness        — descartar timestamp > MAX_AGE_DAYS
  2. min_text         — descartar texto < 6 chars
  3. anti_spam        — regex contra patrones spam comunes
  4. anti_prohibited  — palabras_prohibidas de la marca
  5. anti_blacklist   — classifier_blacklist global
  6. geo              — descartar geo no esperado (allow_list)
  7. dedupe           — texto normalizado: conserva el de mayor search_volume

Ref: blueprint sec. 9. Sin LLM (memoria: feedback_no_llm_in_background).
"""
from __future__ import annotations
import logging
import os
import re
from datetime import datetime, timedelta, timezone

import httpx

from .models import RawSignal

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

log = logging.getLogger(__name__)

MAX_AGE_DAYS = int(os.environ.get("TRENDS_MAX_AGE_DAYS", "30"))
MIN_TEXT_LEN = 6

SPAM_PATTERNS = [
    re.compile(r"\b(?:click|cliquea|haz click)\s+(?:aqui|here|now)\b", re.I),
    re.compile(r"\b(?:viagra|cialis|casino|porn|xxx)\b", re.I),
    re.compile(r"\b(?:gana|earn)\s+\$\d+\s+(?:al dia|per day|en casa)\b", re.I),
    re.compile(r"https?://\S+\s+https?://\S+\s+https?://\S+"),  # link spam
    re.compile(r"(.)\1{8,}"),  # 8+ chars repetidos seguidos
]


async def _fetch_brand_filters(brand_container_id: str) -> tuple[list[str], list[str]]:
    """Devuelve (palabras_prohibidas, mercados_geo_iso)."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_containers",
            headers=H,
            params={"id": f"eq.{brand_container_id}",
                    "select": "palabras_prohibidas,mercado_objetivo",
                    "limit": 1},
        )
        r.raise_for_status()
        rows = r.json()
    if not rows:
        return [], []
    return (rows[0].get("palabras_prohibidas") or [],
            rows[0].get("mercado_objetivo") or [])


async def _fetch_blacklist() -> set[str]:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/classifier_blacklist",
            headers=H, params={"select": "word"},
        )
        if r.status_code != 200:
            return set()
        return {(row.get("word") or "").lower().strip()
                for row in r.json() if row.get("word")}


def _normalize_text(text: str) -> str:
    return " ".join(text.lower().split())


def _is_fresh(s: RawSignal, cutoff: datetime) -> bool:
    if s.timestamp is None:
        return True
    ts = s.timestamp if s.timestamp.tzinfo else s.timestamp.replace(tzinfo=timezone.utc)
    return ts >= cutoff


def _is_spam(text: str) -> bool:
    return any(p.search(text) for p in SPAM_PATTERNS)


def _contains_word(text: str, words: set[str]) -> bool:
    norm = _normalize_text(text)
    return any(w in norm for w in words if w)


def _dedupe(signals: list[RawSignal]) -> list[RawSignal]:
    """Dedupe por texto normalizado. Conserva el de mayor search_volume."""
    by_key: dict[str, RawSignal] = {}
    for s in signals:
        key = _normalize_text(s.text)[:120]  # primeras 120 chars normalizadas
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = s
            continue
        ev = existing.search_volume or 0
        sv = s.search_volume or 0
        if sv > ev:
            by_key[key] = s
    return list(by_key.values())


async def normalize(signals: list[RawSignal], brand_container_id: str) -> list[RawSignal]:
    """Aplica filtros duros en orden. Sin IA. Devuelve list filtrada."""
    if not signals:
        return []

    prohibited_list, allowed_geos = await _fetch_brand_filters(brand_container_id)
    prohibited = {(p or "").lower().strip() for p in prohibited_list if p}
    blacklist = await _fetch_blacklist()
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)

    # geo allow-list: si la marca define mercado_objetivo, usar esos ISOs.
    # Si no, no filtrar por geo (permite todos).
    geo_allow: set[str] = set()
    if allowed_geos:
        from .geo_resolver import resolve_geos
        geo_allow = set(await resolve_geos(allowed_geos))

    out: list[RawSignal] = []
    drops = {"freshness": 0, "short": 0, "spam": 0, "prohibited": 0,
             "blacklist": 0, "geo": 0}

    for s in signals:
        text = (s.text or "").strip()
        if len(text) < MIN_TEXT_LEN:
            drops["short"] += 1
            continue
        if not _is_fresh(s, cutoff):
            drops["freshness"] += 1
            continue
        if _is_spam(text):
            drops["spam"] += 1
            continue
        if prohibited and _contains_word(text, prohibited):
            drops["prohibited"] += 1
            continue
        if blacklist and _contains_word(text, blacklist):
            drops["blacklist"] += 1
            continue
        if geo_allow and s.geo and s.geo not in geo_allow:
            drops["geo"] += 1
            continue
        out.append(s)

    out = _dedupe(out)
    log.info("normalizer: in=%d out=%d drops=%s", len(signals), len(out), drops)
    return out
