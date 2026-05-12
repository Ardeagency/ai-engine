"""Geo resolver — strings descriptivos → ISO 3166-1 alpha-2 codes.

Fuente: tabla `country_aliases` (alias, iso_codes ARRAY, display_name, type).
Soporta countries (1 ISO), regions (N ISOs como 'Latinoamérica' → 9 países),
custom (ej. 'usa latino' → ['US']) e ISO directos pasados al input.

Uso:
    isos = await resolve_geos(["Colombia", "Latinoamérica", "USA Latino"])
    # → ["CO", "MX", "AR", "CL", "PE", "BR", "VE", "EC", "UY", "US"]

Si un valor no resuelve, se loguea warn y se descarta (no se devuelve el string
crudo, porque las APIs externas fallarían igual). Si la lista entera no resuelve
nada, el query_generator aplica fallback ["CO"].
"""
from __future__ import annotations
import logging
import os

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

log = logging.getLogger(__name__)


def _is_iso_code(value: str) -> bool:
    """Heurística: ISO alpha-2 = 2 chars, all uppercase."""
    v = value.strip()
    return len(v) == 2 and v.isupper() and v.isalpha()


async def resolve_geos(values: list[str]) -> list[str]:
    """Resolve lista de valores descriptivos a lista deduped de ISO codes.

    - Valores que ya son ISO (alpha-2 upper) se preservan tal cual.
    - Valores no-ISO se buscan en country_aliases (lowercased exact match).
    - Si un valor no resuelve, se loguea warn y se descarta.
    - Resultado deduplicado, orden preservado por primera aparición.
    """
    if not values:
        return []

    direct_iso: list[str] = []
    aliases: list[str] = []
    for v in values:
        if not v or not v.strip():
            continue
        if _is_iso_code(v):
            direct_iso.append(v.strip())
        else:
            aliases.append(v.strip().lower())

    by_alias: dict[str, list[str]] = {}
    if aliases:
        async with httpx.AsyncClient(timeout=10) as cli:
            in_clause = ",".join(f'"{a}"' for a in set(aliases))
            r = await cli.get(
                f"{SUPABASE_URL}/rest/v1/country_aliases",
                headers=H,
                params={"alias": f"in.({in_clause})",
                        "select": "alias,iso_codes"},
            )
        if r.status_code == 200:
            by_alias = {row["alias"]: (row.get("iso_codes") or []) for row in r.json()}
        else:
            log.warning("geo_resolver: batch lookup failed status=%d body=%s",
                        r.status_code, r.text[:200])

    out: list[str] = []
    seen: set[str] = set()
    for v in direct_iso:
        if v not in seen:
            seen.add(v)
            out.append(v)
    for a in aliases:
        isos = by_alias.get(a)
        if not isos:
            log.warning("geo_resolver: no alias found for %r", a)
            continue
        for iso in isos:
            if iso and iso not in seen:
                seen.add(iso)
                out.append(iso)
    return out


async def resolve_geo(value: str) -> list[str]:
    """Single-value variant of resolve_geos."""
    return await resolve_geos([value])
