"""audience_demand — collector de DEMANDA DE BUSQUEDA via SerpApi (Google Trends).

Por cada seed keyword de la marca (brand_containers.palabras_clave + sub_nichos) en
su geo, pide a Google Trends las RELATED_QUERIES (top + rising) y guarda los terminos
descubiertos en `audience_demand_signals`. Enciende la seccion "Demanda de busqueda"
del dashboard Tendencias.

BRAND-SAFETY / RELEVANCIA (critico): Google Trends devuelve lo que la gente busca —
incluye memes, bromas virales, noticias sensacionalistas y terminos NSFW totalmente
ajenos a la marca. Un blocklist de palabras NUNCA alcanza. Por eso el filtro es de
RELEVANCIA POSITIVA con LLM: entiende que (p.ej.) WAKEUP = crema de mani / snacks
saludables / family-friendly, y deja pasar SOLO lo que pertenece a su tema/nicho y es
apropiado para una marca masiva. Todo lo demas (off-topic, NSFW, violencia, politica,
sensacionalismo) se descarta. Fail-closed: ante error o duda del gate, NO se inserta.

Fuente: SerpApi (engine=google_trends, data_type=RELATED_QUERIES). Free 250/mes.

Uso:  .venv/bin/python -m app.tasks.audience_demand [brand_container_id]
"""
import os
import re
import sys
import json
import datetime as dt

import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SERPAPI_KEY = os.environ.get("SERPAPI_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
FILTER_MODEL = os.environ.get("AUDIENCE_FILTER_MODEL", "claude-sonnet-4-6")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
H_ANTHROPIC = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}

DEMO_ORG = "a1000000-0000-0000-0000-000000000001"
MAX_SEEDS = int(os.environ.get("AUDIENCE_MAX_SEEDS", "8"))
MAX_TERMS_PER_KIND = int(os.environ.get("AUDIENCE_MAX_TERMS", "12"))
RETENTION_DAYS = int(os.environ.get("AUDIENCE_RETENTION_DAYS", "30"))

GEO_MAP = {
    "co": "CO", "colombia": "CO", "mx": "MX", "mexico": "MX", "méxico": "MX",
    "us": "US", "usa": "US", "estados unidos": "US", "usa latino": "US",
    "ar": "AR", "argentina": "AR", "pe": "PE", "peru": "PE", "perú": "PE",
    "cl": "CL", "chile": "CL", "ec": "EC", "ecuador": "EC",
    "es": "ES", "españa": "ES", "espana": "ES", "spain": "ES",
    "latinoamerica": "CO", "latinoamérica": "CO", "latam": "CO",
}
SEED_STOP = {"natural", "colombia", "saludable", "energia", "energía", "chocolate", "fibra"}

# Backstop NSFW de costo cero — SOLO se usa si el gate LLM no esta disponible
# (fail-closed degradado). El filtro real es de relevancia (LLM).
_NSFW = {"vagina", "pene", "sexo", "sexual", "porno", "porn", "xxx", "desnudo", "desnuda",
         "teta", "tetas", "culo", "puta", "puto", "coito", "orgasmo", "anal", "onlyfans",
         "droga", "drogas", "cocaina", "asesinato", "asesino", "suicidio", "arma"}
_TOKEN_RE = re.compile(r"[a-záéíóúñ]+", re.IGNORECASE)


def _get(table: str, params: dict) -> list:
    with httpx.Client(timeout=30) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H, params={**params, "limit": "1000"})
        return r.json() if r.status_code == 200 else []


def _resolve_geo(mercado: list) -> str:
    for raw in (mercado or []):
        k = str(raw).strip().lower()
        if k in GEO_MAP:
            return GEO_MAP[k]
    return ""


def _pick_seeds(bc: dict) -> list:
    raw = list(bc.get("palabras_clave") or []) + list(bc.get("sub_nichos") or [])
    seen, seeds = set(), []
    for t in raw:
        s = str(t).strip()
        low = s.lower()
        if not s or low in SEED_STOP or len(low) < 4 or low in seen:
            continue
        seen.add(low)
        seeds.append(s)
    seeds.sort(key=lambda s: (s.count(" "), len(s)))  # cabeza (cortos) primero
    return seeds[:MAX_SEEDS]


def _serpapi_related(seed: str, geo: str) -> dict:
    params = {"engine": "google_trends", "data_type": "RELATED_QUERIES", "q": seed, "api_key": SERPAPI_KEY}
    if geo:
        params["geo"] = geo
    with httpx.Client(timeout=60) as cli:
        r = cli.get("https://serpapi.com/search.json", params=params)
        try:
            return r.json()
        except Exception:
            return {"error": f"http {r.status_code}"}


def _brand_profile(bc: dict) -> str:
    parts = [
        f"Marca: {bc.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {bc.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(bc.get('sub_nichos') or []) or '—'}",
        f"Palabras clave de la marca: {', '.join(bc.get('palabras_clave') or []) or '—'}",
        f"Mercado: {', '.join(bc.get('mercado_objetivo') or []) or '—'}",
    ]
    if bc.get("palabras_prohibidas"):
        parts.append(f"Palabras prohibidas por la marca: {', '.join(bc['palabras_prohibidas'])}")
    return "\n".join(parts)


SYSTEM_GATE = (
    "Eres un filtro de RELEVANCIA y BRAND-SAFETY para una marca de consumo masivo. "
    "Recibes el perfil de la marca y una lista de terminos de busqueda (Google Trends). "
    "Tu trabajo: devolver SOLO los terminos que cumplen TODO esto: "
    "(1) pertenecen claramente al TEMA/CATEGORIA/NICHO de la marca (o a una ocasion de consumo "
    "adyacente legitima de esa categoria); "
    "(2) son apropiados para una marca masiva y family-friendly. "
    "DESCARTA sin excepcion cualquier termino: off-topic o ajeno a la categoria; sexual/NSFW; "
    "violento, crimen, tragedia o noticias sensacionalistas; politico o religioso; nombres de "
    "personas/famosos sin relacion con la categoria; memes o bromas virales. Ante CUALQUIER duda, "
    "DESCARTA (preferimos perder un termino bueno que dejar pasar uno malo). "
    "Responde EXCLUSIVAMENTE un JSON valido: {\"keep\": [\"termino exacto\", ...]} con los terminos "
    "(copiados textualmente de la lista) que conservas. Si ninguno aplica, {\"keep\": []}."
)


def _relevance_gate(profile: str, terms: list) -> set:
    """Devuelve el subconjunto de `terms` aprobado por el LLM. Lanza si no puede decidir."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY ausente")
    user = (f"PERFIL DE LA MARCA:\n{profile}\n\n"
            f"TERMINOS A EVALUAR ({len(terms)}):\n" + "\n".join(f"- {t}" for t in terms))
    body = {"model": FILTER_MODEL, "max_tokens": 2000,
            "system": SYSTEM_GATE, "messages": [{"role": "user", "content": user}]}
    with httpx.Client(timeout=120) as cli:
        r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:200]}")
    txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    m = re.search(r"\{.*\}", txt, re.DOTALL)
    if not m:
        raise RuntimeError(f"respuesta sin JSON: {txt[:160]}")
    keep = json.loads(m.group(0)).get("keep", [])
    approved = {str(k).strip().lower() for k in keep}
    # Solo aceptamos terminos que estaban en la lista original (evita alucinaciones).
    return {t for t in terms if t.lower() in approved}


def _fallback_safe(terms: list, lexicon: set) -> set:
    """Modo degradado si el gate LLM falla: NSFW-block + debe compartir token con el
    lexico de la marca (on-topic conservador). Fail-closed."""
    out = set()
    for t in terms:
        toks = set(_TOKEN_RE.findall(t.lower()))
        if toks & _NSFW:
            continue
        if toks & lexicon:  # comparte al menos una palabra del nicho
            out.add(t)
    return out


def _candidate_rows(bc_id: str, seed: str, geo: str, data: dict, today: dt.date) -> list:
    rq = data.get("related_queries") or {}
    expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=RETENTION_DAYS)).isoformat()
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    out = []
    for kind, sig_type, c_intent in (("rising", "rising_query", "high"), ("top", "related_query", "medium")):
        for i, it in enumerate(rq.get(kind, [])[:MAX_TERMS_PER_KIND], start=1):
            term = (it.get("query") or "").strip()
            if not term:
                continue
            out.append({
                "brand_container_id": bc_id, "signal_type": sig_type, "seed_keyword": seed,
                "discovered_term": term, "rank_position": i, "geo": geo or "GLOBAL",
                "language": "es", "commercial_intent": c_intent, "intent_category": "search_demand",
                "raw_payload": {"score": it.get("extracted_value"), "label": it.get("value"),
                                "kind": kind, "source": "serpapi_google_trends"},
                "fetched_at": now_iso, "fetch_date": today.isoformat(),
                "expires_at": expires, "vera_safe": True,
            })
    return out


def _replace(bc_id: str, rows: list):
    with httpx.Client(timeout=30) as cli:
        cli.delete(f"{SUPABASE_URL}/rest/v1/audience_demand_signals", headers=H,
                   params={"brand_container_id": f"eq.{bc_id}",
                           "signal_type": "in.(related_query,rising_query)"})
        for i in range(0, len(rows), 500):
            r = cli.post(f"{SUPABASE_URL}/rest/v1/audience_demand_signals",
                         headers={**H, "Prefer": "return=minimal"}, json=rows[i:i + 500])
            if r.status_code >= 300:
                print(f"    insert error {r.status_code}: {r.text[:200]}")


def main():
    if not SERPAPI_KEY:
        print("audience_demand: falta SERPAPI_KEY"); return
    only = sys.argv[1] if len(sys.argv) > 1 else None
    params = {"select": "id,organization_id,nombre_marca,nicho_core,palabras_clave,sub_nichos,mercado_objetivo,palabras_prohibidas"}
    if only:
        params["id"] = f"eq.{only}"
    containers = [c for c in _get("brand_containers", params) if c.get("organization_id") != DEMO_ORG]

    for bc in containers:
        geo = _resolve_geo(bc.get("mercado_objetivo"))
        seeds = _pick_seeds(bc)
        if not seeds:
            continue
        # 1. Recolecta candidatos (sin insertar).
        candidates, calls = [], 0
        for seed in seeds:
            data = _serpapi_related(seed, geo)
            calls += 1
            if data.get("error"):
                print(f"  {bc['id'][:8]} '{seed}': {data['error']}")
                continue
            candidates.extend(_candidate_rows(bc["id"], seed, geo, data, dt.date.today()))
        terms = sorted({c["discovered_term"] for c in candidates})
        if not terms:
            _replace(bc["id"], [])
            print(f"  {bc['id'][:8]}: sin candidatos")
            continue
        # 2. Gate de RELEVANCIA (LLM). Fail-closed: si falla, modo degradado on-topic.
        try:
            approved = _relevance_gate(_brand_profile(bc), terms)
            mode = "LLM"
        except Exception as e:
            lexicon = {w for kw in (list(bc.get("palabras_clave") or []) + list(bc.get("sub_nichos") or [])
                                    + [bc.get("nicho_core") or ""])
                       for w in _TOKEN_RE.findall(str(kw).lower()) if len(w) >= 4}
            approved = _fallback_safe(terms, lexicon)
            mode = f"FALLBACK ({str(e)[:60]})"
        # 3. Solo inserta lo aprobado.
        rows = [c for c in candidates if c["discovered_term"].lower() in {a.lower() for a in approved}]
        _replace(bc["id"], rows)
        dropped = len(terms) - len(approved)
        print(f"  {bc['id'][:8]} geo={geo or 'GLOBAL'} calls={calls} candidatos={len(terms)} "
              f"aprobados={len(approved)} descartados={dropped} filtro={mode} -> {len(rows)} filas")

    print("audience_demand: listo")


if __name__ == "__main__":
    main()
