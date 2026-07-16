"""Briefs de CMO por organizacion Y por PESTAÑA (scope) — la lectura de las cards
'Estado de...' de Mi Marca, Monitoreo, Tendencias y Estrategia.

Los ESCRIBE un LLM razonando como CMO senior y SOCIO de la marca:
constructivo, con criterio, nunca golpeador. Lote cadenciado → cachea en
`brand_cmo_brief` (PK org+scope); el dashboard solo LEE. Cobra creditos (kind='cmo_brief').

MEJORA 2026-07-14 (T-03 del rediseño dashboard): el payload ahora incluye los
CAPTIONS REALES de los posts top (propios y de competencia), no solo agregados
de etiquetas — el LLM puede citar lo concreto en vez de escribir genérico.
NOTA: este job queda como FALLBACK; la lectura principal del dashboard migra a
la Sesión Dashboard de VERA (vera-dashboard-session.service.js / shadow mode).

Uso:  .venv/bin/python -m app.tasks.cmo_brief [organization_id]
"""
import os
import json
import sys
import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("CMO_BRIEF_MODEL", "gpt-4o")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
PRICE_IN, PRICE_OUT = 2.5, 10.0  # gpt-4o por 1M tokens


# ── Fetchers ────────────────────────────────────────────────────────
def _get(table: str, params: dict) -> list:
    rows, off = [], 0
    with httpx.Client(timeout=30) as cli:
        while True:
            r = cli.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H,
                        params={**params, "offset": str(off), "limit": "1000"})
            b = r.json() if r.status_code == 200 else []
            if not b:
                break
            rows.extend(b)
            off += 1000
            if len(b) < 1000:
                break
    return rows


def _get_page(table: str, params: dict, limit: int) -> list:
    """Una sola página con limit explícito (para top-N sin paginar todo)."""
    with httpx.Client(timeout=30) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H,
                    params={**params, "limit": str(limit)})
        return r.json() if r.status_code == 200 else []


def _patterns(org: str, is_comp: bool) -> list:
    return _get("post_patterns", {
        "organization_id": f"eq.{org}", "is_competitor": f"eq.{'true' if is_comp else 'false'}",
        "classifier_version": "eq.llm-v3", "select": "topic,tone,engagement_total,brand_post_id"})


def _top_posts(org: str, is_comp: bool, n: int = 8) -> list:
    """Captions REALES de los posts top por engagement — la sustancia que los
    agregados de etiquetas destruyen. Da al LLM algo concreto que citar."""
    rows = _get_page("brand_posts", {
        "organization_id": f"eq.{org}",
        "is_competitor": f"eq.{'true' if is_comp else 'false'}",
        "select": "content,engagement_total,posted_at",
        "order": "engagement_total.desc.nullslast"}, n * 2)
    out = []
    for r in rows:
        c = (r.get("content") or "").strip().replace("\n", " ")
        if len(c) < 15:
            continue
        out.append({"caption": c[:240], "eng": r.get("engagement_total"),
                    "fecha": (r.get("posted_at") or "")[:10]})
        if len(out) >= n:
            break
    return out


def _agg(rows: list, key: str) -> list:
    d = {}
    for r in rows:
        k = r.get(key)
        if not k:
            continue
        e = d.setdefault(k, {"posts": 0, "eng": 0})
        e["posts"] += 1
        e["eng"] += int(r.get("engagement_total") or 0)
    out = [{"name": k, "posts": v["posts"], "eng_post": round(v["eng"] / v["posts"]) if v["posts"] else 0}
           for k, v in d.items()]
    out.sort(key=lambda x: -x["eng_post"])
    return out


def _health_verdict(org: str) -> str:
    try:
        rows = _get("brand_health_snapshots", {"organization_id": f"eq.{org}", "select": "verdict",
                                               "order": "computed_at.desc"})
        return (rows[0].get("verdict") if rows else "") or ""
    except Exception:
        return ""


# ── Data por scope ──────────────────────────────────────────────────
def _data_mi_marca(org):
    own, comp = _patterns(org, False), _patterns(org, True)
    if not own:
        return None
    return {"propio_tonos": _agg(own, "tone")[:6], "propio_temas": _agg(own, "topic")[:6],
            "categoria_tonos": _agg(comp, "tone")[:6], "categoria_temas": _agg(comp, "topic")[:6],
            "top_posts_propios": _top_posts(org, False, 8),
            "top_posts_categoria": _top_posts(org, True, 4)}


def _data_monitoreo(org):
    comp = _patterns(org, True)
    if not comp:
        return None
    own = _patterns(org, False)
    # top entidades por eng/post: brand_posts (entity_id, eng) + intelligence_entities (name, tipo)
    ents = {e["id"]: e for e in _get("intelligence_entities",
            {"organization_id": f"eq.{org}", "select": "id,name,metadata"})}
    bposts = _get("brand_posts", {"organization_id": f"eq.{org}", "is_competitor": "eq.true",
                                  "select": "entity_id,engagement_total"})
    ed = {}
    for p in bposts:
        eid = p.get("entity_id")
        if not eid or eid not in ents:
            continue
        e = ed.setdefault(eid, {"posts": 0, "eng": 0})
        e["posts"] += 1
        e["eng"] += int(p.get("engagement_total") or 0)
    top_ent = []
    for eid, v in ed.items():
        meta = ents[eid].get("metadata") or {}
        top_ent.append({"name": ents[eid].get("name"), "tipo": meta.get("tipo"),
                        "posts": v["posts"], "eng_post": round(v["eng"] / v["posts"]) if v["posts"] else 0})
    top_ent.sort(key=lambda x: -x["eng_post"])
    return {"top_entidades": top_ent[:8], "competencia_tonos": _agg(comp, "tone")[:6],
            "competencia_temas": _agg(comp, "topic")[:6], "propio_temas": _agg(own, "topic")[:5],
            "top_posts_competencia": _top_posts(org, True, 8)}


def _data_tendencias(org):
    tr = _get("trend_topics", {"organization_id": f"eq.{org}",
              "select": "keyword,category,velocity_score,relevance_score,sentiment",
              "order": "velocity_score.desc.nullslast"})
    if not tr:
        return None
    seen, top = set(), []
    for t in tr:
        k = (t.get("keyword") or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        top.append({"keyword": t.get("keyword"), "categoria": t.get("category"),
                    "velocidad": t.get("velocity_score"), "relevancia": t.get("relevance_score"),
                    "sentimiento": t.get("sentiment")})
        if len(top) >= 25:
            break
    return {"tendencias": top, "top_posts_propios": _top_posts(org, False, 4)}


def _data_estrategia(org):
    recs = _get("strategic_recommendations", {"organization_id": f"eq.{org}",
                "select": "title,description,tone,topic,format", "order": "generated_at.desc"})
    if not recs:
        return None
    own = _patterns(org, False)
    return {"recomendaciones": recs[:8],
            "lo_que_te_funciona": _agg(own, "topic")[:5] if own else [],
            "top_posts_propios": _top_posts(org, False, 5)}


# ── Prompts por scope (constructivos) ───────────────────────────────
_BASE = ("Eres un CMO senior y SOCIO de esta marca — con criterio, comercial, pero que IMPULSA. "
         "Escribe UNA lectura para la card del dashboard. Formato: un TITULAR corto (~10-14 palabras) "
         "+ un PARRAFO (2-3 frases). Tono: socio que muestra la jugada, especifico y motivador; "
         "JAMAS golpeador, JAMAS 'estas fallando', JAMAS generico ni 'chocho'. La marca debe sentir que "
         "le abren una oportunidad, no que la atacan. Ojo: NO compares cifras absolutas entre marcas "
         "(audiencias distintas), lee CODIGOS y POSICION. "
         "Tienes captions REALES de los posts top (top_posts_*): ANCLA tu lectura en lo concreto — "
         "el gancho, el tema, el angulo que aparece en esos captions — y nombralo. Una lectura que "
         "podria copy-pastearse a otra marca esta MAL. Español natural con tildes. "
         "Responde SOLO JSON: {\"headline\": \"...\", \"body\": \"...\"}\n\n")

SYSTEMS = {
    "mi_marca": _BASE + ("Card 'Estado de tu marca'. Con tonos/temas propios vs. la categoria Y los captions "
        "reales: reconoce la FORTALEZA real de la marca (citando el angulo concreto que le funciona) y nombra "
        "LA JUGADA de crecimiento = llevar la SUSTANCIA que ya le funciona (sus mejores temas) al CODIGO que "
        "premia la categoria (sus mejores tonos/formatos). El producto da permiso; el marketing da preferencia."),
    "monitoreo": _BASE + ("Card 'Estado del monitoreo'. Con las entidades que dominan el nicho, sus tonos/temas "
        "Y los captions reales de sus posts top: di quien marca el ritmo, QUE esta haciendo concretamente (cita "
        "el angulo de sus posts), cual es la amenaza o el aprendizaje mas relevante, y EL HUECO que la marca "
        "puede ocupar (un codigo/formato que nadie explota bien o que un competidor prueba y tu no). Orientado "
        "a la jugada, nunca alarmista."),
    "tendencias": _BASE + ("Card 'Pulso del nicho'. Con las tendencias detectadas (keywords, velocidad, relevancia, "
        "categoria): di hacia donde se mueve la conversacion del nicho AHORA y LA tendencia concreta que a la marca "
        "le conviene montar y por que encaja con su sustancia (usa top_posts_propios para saber cual es esa "
        "sustancia). Subirse temprano a una tendencia relevante = disponibilidad mental barata. Prioriza señales "
        "con velocidad Y relevancia altas, no ruido."),
    "estrategia": _BASE + ("Card de Estrategia. Con las recomendaciones estrategicas de Vera y lo que ya le funciona "
        "a la marca (incluidos sus captions top): nombra LA prioridad estrategica ahora (la jugada de mayor impacto) "
        "como el siguiente paso claro. Enfoque > dispersion: una jugada que rinde cuentas vale mas que cinco tacticas."),
}

KICKERS = {"mi_marca": "Estado de tu marca", "monitoreo": "Estado del monitoreo",
           "tendencias": "Pulso del nicho", "estrategia": "Prioridad estrategica"}
DATA_FN = {"mi_marca": _data_mi_marca, "monitoreo": _data_monitoreo,
           "tendencias": _data_tendencias, "estrategia": _data_estrategia}


def _call_llm(system: str, payload_json: str, verdict: str):
    user = f"Contexto: {verdict or 'sin dato'}\n\nDATA:\n{payload_json}"
    body = {"model": MODEL, "temperature": 0.4, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    with httpx.Client(timeout=90) as cli:
        r = cli.post("https://api.openai.com/v1/chat/completions",
                     headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                     json=body)
        r.raise_for_status()
        data = r.json()
    parsed = json.loads(data["choices"][0]["message"]["content"])
    u = data.get("usage", {})
    cost = round(u.get("prompt_tokens", 0) / 1e6 * PRICE_IN + u.get("completion_tokens", 0) / 1e6 * PRICE_OUT, 6)
    return parsed, cost


def generate_for_org_scope(org: str, scope: str):
    data = DATA_FN[scope](org)
    if not data:
        return None
    verdict = _health_verdict(org) if scope == "mi_marca" else ""
    parsed, cost = _call_llm(SYSTEMS[scope], json.dumps(data, ensure_ascii=False), verdict)
    headline, body = str(parsed.get("headline", "")).strip(), str(parsed.get("body", "")).strip()
    if not headline or not body:
        return None
    with httpx.Client(timeout=20) as cli:
        cli.post(f"{SUPABASE_URL}/rest/v1/brand_cmo_brief",
                 headers={**H, "Prefer": "resolution=merge-duplicates"},
                 json={"organization_id": org, "scope": scope, "headline": headline, "body": body,
                       "verdict": verdict, "model": MODEL, "meta": data})
    if cost > 0:
        try:
            from .media_orchestrator import charge_org
            charge_org(org, cost, "cmo_brief", {"model": MODEL, "scope": scope})
        except Exception:
            pass
    return {"headline": headline, "cost": cost}


def _orgs_with_own() -> list:
    rows = _get("post_patterns", {"is_competitor": "eq.false", "classifier_version": "eq.llm-v3",
                                  "select": "organization_id"})
    return sorted({x["organization_id"] for x in rows if x.get("organization_id")})


def main():
    orgs = [sys.argv[1]] if len(sys.argv) > 1 else _orgs_with_own()
    print(f"orgs: {len(orgs)}", flush=True)
    for org in orgs:
        for scope in ("mi_marca", "monitoreo", "tendencias", "estrategia"):
            try:
                res = generate_for_org_scope(org, scope)
                if res:
                    print(f"OK {org}/{scope} (${res['cost']}): {res['headline']}", flush=True)
                else:
                    print(f"SKIP {org}/{scope} (sin data)", flush=True)
            except Exception as e:
                print(f"FAIL {org}/{scope}: {str(e)[:180]}", flush=True)


if __name__ == "__main__":
    main()
