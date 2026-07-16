"""brand_safety — gate de RELEVANCIA + brand-safety para señales externas.

Las fuentes externas (Google Trends, News) devuelven lo que la gente busca/publica:
memes, bromas NSFW, crimenes, politica, sensacionalismo — todo ajeno a la marca. Un
blocklist NUNCA alcanza. El filtro correcto es de RELEVANCIA POSITIVA con LLM: entiende
la marca (p.ej. WAKEUP = crema de mani / snacks saludables / family-friendly) y deja
pasar SOLO lo que pertenece a su tema/nicho y es apropiado. Fail-closed: ante error o
duda, descarta.

Se usa en el trends engine (orchestrator, antes de persistir News en
targeted_trend_signals y de generar briefs) y replica la logica del collector de
demanda (app/tasks/audience_demand.py). Ver memoria feedback_brand_safety_relevance_gate.
"""
import os
import re
import json
import logging

import httpx

log = logging.getLogger("trends.brand_safety")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("AUDIENCE_FILTER_MODEL", "claude-sonnet-4-6")
H_SB = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
H_ANTHROPIC = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}

_NSFW = {"vagina", "pene", "sexo", "sexual", "porno", "porn", "xxx", "desnudo", "desnuda",
         "teta", "tetas", "culo", "puta", "puto", "coito", "orgasmo", "anal", "onlyfans",
         "droga", "drogas", "cocaina", "asesinato", "asesino", "suicidio", "arma", "narco"}
_TOKEN_RE = re.compile(r"[a-záéíóúñ]+", re.IGNORECASE)

SYSTEM_GATE = (
    "Eres un filtro de RELEVANCIA y BRAND-SAFETY para una marca de consumo masivo. "
    "Recibes el perfil de la marca y una lista de titulos/terminos de fuentes externas "
    "(noticias, busquedas). Devuelve SOLO los que cumplen TODO: "
    "(1) pertenecen claramente al TEMA/CATEGORIA/NICHO de la marca (o a una ocasion de "
    "consumo adyacente legitima de esa categoria); "
    "(2) son apropiados para una marca masiva y family-friendly. "
    "DESCARTA sin excepcion: off-topic o ajeno a la categoria; sexual/NSFW; violento, "
    "crimen, tragedia o noticias sensacionalistas; politico o religioso; personas/famosos "
    "sin relacion con la categoria; memes o bromas. Ante CUALQUIER duda, DESCARTA. "
    "Responde EXCLUSIVAMENTE JSON valido: {\"keep\": [\"texto exacto\", ...]} copiando "
    "textualmente de la lista los que conservas. Si ninguno aplica, {\"keep\": []}."
)


async def _fetch_brand(brand_container_id: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_containers", headers=H_SB,
            params={"id": f"eq.{brand_container_id}", "limit": "1",
                    "select": "id,nombre_marca,nicho_core,sub_nichos,palabras_clave,"
                              "mercado_objetivo,palabras_prohibidas"})
    rows = r.json() if r.status_code == 200 else []
    return rows[0] if rows else {}


def _profile(b: dict) -> str:
    parts = [
        f"Marca: {b.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {b.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(b.get('sub_nichos') or []) or '—'}",
        f"Palabras clave de la marca: {', '.join(b.get('palabras_clave') or []) or '—'}",
        f"Mercado: {', '.join(b.get('mercado_objetivo') or []) or '—'}",
    ]
    if b.get("palabras_prohibidas"):
        parts.append(f"Palabras prohibidas por la marca: {', '.join(b['palabras_prohibidas'])}")
    return "\n".join(parts)


async def _relevance_gate(profile: str, texts: list) -> set:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY ausente")
    user = (f"PERFIL DE LA MARCA:\n{profile}\n\nTEXTOS A EVALUAR ({len(texts)}):\n"
            + "\n".join(f"- {t}" for t in texts))
    body = {"model": MODEL, "max_tokens": 2000, "system": SYSTEM_GATE,
            "messages": [{"role": "user", "content": user}]}
    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:200]}")
    txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    m = re.search(r"\{.*\}", txt, re.DOTALL)
    if not m:
        raise RuntimeError("respuesta sin JSON")
    keep = {str(k).strip().lower() for k in json.loads(m.group(0)).get("keep", [])}
    return {t for t in texts if t.lower() in keep}


def _fallback(texts: list, lexicon: set) -> set:
    out = set()
    for t in texts:
        toks = set(_TOKEN_RE.findall((t or "").lower()))
        if toks & _NSFW:
            continue
        if toks & lexicon:
            out.add(t)
    return out


async def filter_safe_signals(scored: list, brand_container_id: str) -> list:
    """Filtra una lista de ScoredSignal dejando solo las on-topic y brand-safe.
    Fail-closed: si el LLM falla, usa NSFW-block + solape con el lexico del nicho."""
    if not scored:
        return scored
    texts = sorted({(getattr(s, "text", "") or "").strip() for s in scored if getattr(s, "text", "")})
    if not texts:
        return []
    brand = await _fetch_brand(brand_container_id)
    try:
        approved = await _relevance_gate(_profile(brand), texts)
        mode = "LLM"
    except Exception as e:  # noqa: BLE001 — fail-closed intencional
        lexicon = {w for kw in (list(brand.get("palabras_clave") or [])
                                + list(brand.get("sub_nichos") or [])
                                + [brand.get("nicho_core") or ""])
                   for w in _TOKEN_RE.findall(str(kw).lower()) if len(w) >= 4}
        approved = _fallback(texts, lexicon)
        mode = f"fallback ({str(e)[:60]})"
    approved_lc = {a.lower() for a in approved}
    kept = [s for s in scored if (getattr(s, "text", "") or "").strip().lower() in approved_lc]
    log.info("brand_safety[%s]: %d/%d señales aprobadas (filtro=%s)",
             brand_container_id[:8], len(kept), len(scored), mode)
    return kept
