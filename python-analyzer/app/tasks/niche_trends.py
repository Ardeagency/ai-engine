"""niche_trends — SEÑALES EN TENDENCIA del nicho (lente externa de Tendencias).

NO es analisis de competencia (eso vive en Competencia). Aqui detectamos que esta
haciendo BOOM AHORA en la audiencia del nicho de la marca (ej. "el Mundial") y que
la marca puede APROVECHAR con contenido. Fuente externa: Google Trends via SerpApi
(Trending Now del pais + rising de la categoria del nicho). Un LLM sintetiza lo crudo
en señales limpias, aprovechables y brand-safe (agrupa "francia-españa"+"delantero"
-> "Mundial de futbol"). Semanal, cacheado.

Uso:  .venv/bin/python -m app.tasks.niche_trends [brand_container_id]
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
MODEL = os.environ.get("AUDIENCE_FILTER_MODEL", "claude-sonnet-4-6")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
H_ANTHROPIC = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}

DEMO_ORG = "a1000000-0000-0000-0000-000000000001"
GEO_MAP = {"co": "CO", "colombia": "CO", "mx": "MX", "mexico": "MX", "méxico": "MX",
           "us": "US", "usa": "US", "estados unidos": "US", "ar": "AR", "argentina": "AR",
           "pe": "PE", "peru": "PE", "cl": "CL", "chile": "CL", "es": "ES", "españa": "ES",
           "latinoamerica": "CO", "latinoamérica": "CO"}
# Categorias de Google Trends que NO sirven al nicho (se descartan antes del LLM).
BAD_CATS = {"Politics", "Law and Government"}


def _get(table, params):
    with httpx.Client(timeout=30) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H, params={**params, "limit": "1000"})
        return r.json() if r.status_code == 200 else []


def _geo(mercado):
    for raw in (mercado or []):
        k = str(raw).strip().lower()
        if k in GEO_MAP:
            return GEO_MAP[k]
    return "CO"


def _trending_now(geo):
    try:
        with httpx.Client(timeout=60) as cli:
            r = cli.get("https://serpapi.com/search.json",
                        params={"engine": "google_trends_trending_now", "geo": geo, "api_key": SERPAPI_KEY})
        items = r.json().get("trending_searches", []) if r.status_code == 200 else []
    except Exception:
        return []
    out = []
    for it in items[:30]:
        cats = {c.get("name") for c in (it.get("categories") or [])}
        if cats & BAD_CATS:
            continue
        out.append({"query": it.get("query"), "volume": it.get("search_volume"),
                    "categories": sorted(cats)})
    return out


def _rising(seed, geo):
    try:
        with httpx.Client(timeout=60) as cli:
            r = cli.get("https://serpapi.com/search.json",
                        params={"engine": "google_trends", "data_type": "RELATED_QUERIES",
                                "q": seed, "geo": geo, "api_key": SERPAPI_KEY})
        rq = r.json().get("related_queries", {}) if r.status_code == 200 else {}
    except Exception:
        return []
    return [{"query": x.get("query"), "growth": x.get("value")} for x in (rq.get("rising") or [])[:8]]


SYSTEM = (
    "Eres un estratega de contenido de marca. Recibes el perfil de una marca de consumo y "
    "una lista de TENDENCIAS que estan calientes AHORA en su pais (busquedas trending del pais "
    "+ terminos que suben en su categoria). Identifica las SEÑALES que ESTA marca puede APROVECHAR "
    "con contenido: momentos culturales, eventos o temas que su audiencia esta viviendo (un mundial, "
    "una fecha, un tema viral RELEVANTE a su nicho o a una ocasion de consumo). AGRUPA lo relacionado "
    "en un TEMA claro (ej. varios partidos/jugadores -> 'Mundial de futbol'). DESCARTA lo que no aplica "
    "al nicho, lo sensible (politica, crimen, tragedia, salud grave) y lo NSFW. Para cada señal da: "
    "theme (nombre corto del momento/tema), why (como la marca lo aprovecha, 6-12 palabras, concreto), "
    "momentum ('alto' o 'medio'). Responde EXCLUSIVAMENTE JSON: {\"signals\":[{\"theme\":\"\",\"why\":\"\",\"momentum\":\"\"}]} "
    "con maximo 6, ordenadas de mas a menos aprovechable. Si nada aplica, {\"signals\":[]}."
)


def _synthesize(profile, trending, rising):
    if not ANTHROPIC_API_KEY:
        return []
    tr = "\n".join(f"- {t['query']} (vol {t.get('volume','?')}, {'/'.join(t.get('categories') or []) or 's/cat'})" for t in trending)
    ri = "\n".join(f"- {r['query']} ({r.get('growth','')})" for r in rising)
    user = (f"PERFIL DE LA MARCA:\n{profile}\n\n"
            f"TRENDING NOW EN EL PAIS:\n{tr or '(nada)'}\n\n"
            f"TERMINOS QUE SUBEN EN LA CATEGORIA:\n{ri or '(nada)'}")
    body = {"model": MODEL, "max_tokens": 1200, "system": SYSTEM, "messages": [{"role": "user", "content": user}]}
    try:
        with httpx.Client(timeout=120) as cli:
            r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
        if r.status_code >= 400:
            print(f"    [llm] {r.status_code}: {r.text[:120]}"); return []
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        m = re.search(r"\{.*\}", txt, re.DOTALL)
        sigs = json.loads(m.group(0)).get("signals", []) if m else []
        out = []
        for s in sigs[:6]:
            th = str(s.get("theme", "")).strip()
            if th and str(s.get("momentum", "")).lower() in ("alto", "medio"):
                out.append({"theme": th, "why": str(s.get("why", "")).strip()[:160],
                            "momentum": s.get("momentum").lower()})
        return out
    except Exception as e:
        print(f"    [llm] error: {str(e)[:100]}"); return []


def _brand_profile(bc):
    return "\n".join([
        f"Marca: {bc.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {bc.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(bc.get('sub_nichos') or []) or '—'}",
        f"Mercado: {', '.join(bc.get('mercado_objetivo') or []) or '—'}",
    ])


def _seeds(bc):
    s = [bc.get("nicho_core")] + list(bc.get("sub_nichos") or [])
    return [x for x in dict.fromkeys([str(t).strip() for t in s if t and str(t).strip()])][:3]


def _store(org_id, bc_id, geo, signals):
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    today = dt.date.today().isoformat()
    rows = [{
        "organization_id": org_id, "brand_container_id": bc_id,
        "keyword": s["theme"], "source": "google_trends_niche", "scope": "niche_trend",
        "category": s["momentum"], "velocity_score": 9 if s["momentum"] == "alto" else 6,
        "relevance_score": 0.9, "sentiment": {},
        "metadata": {"why": s["why"], "momentum": s["momentum"], "geo": geo},
        "detected_at": now,
    } for s in signals]
    with httpx.Client(timeout=30) as cli:
        cli.delete(f"{SUPABASE_URL}/rest/v1/trend_topics", headers=H,
                   params={"organization_id": f"eq.{org_id}", "scope": "eq.niche_trend"})
        if rows:
            cli.post(f"{SUPABASE_URL}/rest/v1/trend_topics",
                     headers={**H, "Prefer": "return=minimal"}, json=rows)
    return len(rows)


def main():
    if not SERPAPI_KEY:
        print("niche_trends: falta SERPAPI_KEY"); return
    only = sys.argv[1] if len(sys.argv) > 1 else None
    params = {"select": "id,organization_id,nombre_marca,nicho_core,sub_nichos,mercado_objetivo"}
    if only:
        params["id"] = f"eq.{only}"
    containers = [c for c in _get("brand_containers", params) if c.get("organization_id") != DEMO_ORG]
    for bc in containers:
        geo = _geo(bc.get("mercado_objetivo"))
        trending = _trending_now(geo)
        rising = []
        for sd in _seeds(bc):
            rising.extend(_rising(sd, geo))
        signals = _synthesize(_brand_profile(bc), trending, rising)
        n = _store(bc["organization_id"], bc["id"], geo, signals)
        print(f"  {bc['id'][:8]} geo={geo} trending={len(trending)} rising={len(rising)} -> {n} señales")
        for s in signals:
            print(f"      · [{s['momentum']}] {s['theme']} — {s['why']}")
    print("niche_trends: listo")


if __name__ == "__main__":
    main()
