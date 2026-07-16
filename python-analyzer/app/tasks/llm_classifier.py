"""Clasificador LLM multi-etiqueta — reemplaza el keyword pattern_classifier
para tono/tema/mood/sentimiento. Data-driven desde `pattern_taxonomy`.

Flujo por post:
  1. Descripcion de imagen (REUSA media_orchestrator.describe_media + cache + billing).
  2. Top comentarios (para el sentimiento de la AUDIENCIA).
  3. Un LLM (OpenAI) clasifica multi-etiqueta, VALIDADO contra pattern_taxonomy
     (los valores fuera de la biblioteca se descartan → ese es el filtro).

El FORMATO y la MATEMATICA de engagement siguen siendo deterministicos
(pattern_classifier.classify_post). Aqui solo va lo subjetivo.

Governor: `select_governed()` limita posts por org segun scraping_daily_cap del
plan, para que el costo nunca escale sin control.
"""
import os
import json
import time
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("PATTERN_LLM_MODEL", "gpt-4o-mini")

H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
     "Content-Type": "application/json"}

DIMS = ["topic", "tone", "mood", "sentiment"]
MAX_PER_DIM = 2          # multi-etiqueta: hasta 2 por dimension
MAX_COMMENTS = 15        # top comentarios por post para el sentimiento de audiencia

_TAX_CACHE = {"loaded_at": 0, "data": None}
_TAX_TTL = 600           # 10 min


# ────────────────────────────────────────────────────────────────────
# Taxonomia (biblioteca) — cacheada
# ────────────────────────────────────────────────────────────────────
def load_taxonomy() -> dict:
    now = time.time()
    if _TAX_CACHE["data"] and now - _TAX_CACHE["loaded_at"] < _TAX_TTL:
        return _TAX_CACHE["data"]
    out = {d: [] for d in DIMS}
    with httpx.Client(timeout=20) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/pattern_taxonomy", headers=H,
                    params={"select": "dimension,value,display_es",
                            "dimension": f"in.({','.join(DIMS)})"})
        for row in (r.json() if r.status_code == 200 else []):
            d = row["dimension"]
            if d in out:
                out[d].append({"value": row["value"],
                               "label": row.get("display_es") or row["value"]})
    _TAX_CACHE["data"] = out
    _TAX_CACHE["loaded_at"] = now
    return out


def _valid_sets(tax: dict) -> dict:
    return {d: {x["value"] for x in tax[d]} for d in DIMS}


# ────────────────────────────────────────────────────────────────────
# Governor — tope de posts por org segun el plan
# ────────────────────────────────────────────────────────────────────
def _org_caps(org_ids: list) -> dict:
    """{org_id: scraping_daily_cap} leyendo subscriptions -> plans."""
    caps = {}
    if not org_ids:
        return caps
    ids = ",".join(set(o for o in org_ids if o))
    with httpx.Client(timeout=15) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/subscriptions", headers=H,
                    params={"organization_id": f"in.({ids})",
                            "select": "organization_id,plan_id,status"})
        subs = r.json() if r.status_code == 200 else []
        pr = cli.get(f"{SUPABASE_URL}/rest/v1/plans", headers=H,
                     params={"select": "id,scraping_daily_cap"})
        plan_cap = {p["id"]: (p.get("scraping_daily_cap") or 100)
                    for p in (pr.json() if pr.status_code == 200 else [])}
    for s in subs:
        if s.get("status") == "active":
            caps[s["organization_id"]] = plan_cap.get(s.get("plan_id"), 100)
    return caps


def select_governed(posts: list, global_max: int = 200) -> list:
    """Filtra el lote respetando el cap diario por org del plan + un tope global."""
    org_ids = [p.get("organization_id") for p in posts]
    caps = _org_caps(org_ids)
    used = {}
    out = []
    for p in posts:
        if len(out) >= global_max:
            break
        org = p.get("organization_id")
        cap = caps.get(org, 100)
        if used.get(org, 0) >= cap:
            continue
        used[org] = used.get(org, 0) + 1
        out.append(p)
    return out


# ────────────────────────────────────────────────────────────────────
# Contexto por post: descripcion de imagen + comentarios
# ────────────────────────────────────────────────────────────────────
def _post_description(post_row: dict) -> str:
    """Descripcion de imagen: reusa la guardada en media_assets, o la genera
    via media_orchestrator (cache + billing por org)."""
    ma = post_row.get("media_assets")
    if isinstance(ma, dict):
        d = ma.get("description") or ma.get("descriptions")
        if d:
            return d if isinstance(d, str) else " ; ".join(str(x) for x in d)[:600]
    try:
        from .media_helpers import extract_image_urls
        from .media_orchestrator import describe_media
        urls, _mtype = extract_image_urls(ma, post_row.get("network", ""))
        if not urls:
            return ""
        res = describe_media(urls[0], "image", _org_for(post_row))
        return (res.get("description") or "")[:600]
    except Exception:
        return ""


def fetch_top_comments(post_id: str, limit: int = MAX_COMMENTS) -> list:
    with httpx.Client(timeout=15) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/brand_post_comments", headers=H,
                    params={"brand_post_id": f"eq.{post_id}",
                            "select": "content,metrics",
                            "order": "posted_at.desc",
                            "limit": str(limit * 3)})
        rows = r.json() if r.status_code == 200 else []

    def likes(c):
        m = c.get("metrics") or {}
        try:
            return int(m.get("likes", 0) or 0)
        except Exception:
            return 0

    rows.sort(key=likes, reverse=True)
    out = []
    for c in rows[:limit]:
        t = (c.get("content") or "").strip()
        if t:
            out.append(t[:180])
    return out


# ────────────────────────────────────────────────────────────────────
# Prompt + llamada al LLM
# ────────────────────────────────────────────────────────────────────
def build_prompt(posts_ctx: list, tax: dict) -> tuple:
    def dim_block(d):
        return "\n".join(f"- {x['value']}: {x['label']}" for x in tax[d])

    system = (
        "Eres un analista de contenido de marca. Clasificas publicaciones en 4 dimensiones "
        "USANDO EXCLUSIVAMENTE los valores permitidos (el identificador antes de ':'). "
        "NUNCA inventes valores nuevos ni traduzcas los identificadores.\n\n"
        f"TEMAS (topic):\n{dim_block('topic')}\n\n"
        f"TONOS (tone):\n{dim_block('tone')}\n\n"
        f"MOODS (mood):\n{dim_block('mood')}\n\n"
        f"SENTIMIENTOS QUE EVOCA EL CONTENIDO (sentiment):\n{dim_block('sentiment')}\n\n"
        "Para cada post devuelve hasta 2 topics, 2 tones, 2 moods y 2 sentiments, los mas "
        "dominantes, ordenados por relevancia, cada uno con confidence 0-1.\n"
        "Ademas, leyendo los COMENTARIOS, estima el sentimiento de la AUDIENCIA: "
        "audience = {pos, neu, neg} como fracciones que suman 1, y dominant "
        "(positivo|neutral|negativo). Si el post no tiene comentarios, audience = null. "
        "El sentimiento de audiencia SALE DE LOS COMENTARIOS, no del texto del post.\n"
        "Responde SOLO un objeto JSON con esta forma exacta:\n"
        '{"results":[{"i":0,"topics":[{"value":"..","confidence":0.9}],'
        '"tones":[{"value":"..","confidence":0.8}],"moods":[...],"sentiments":[...],'
        '"audience":{"pos":0.7,"neu":0.2,"neg":0.1,"dominant":"positivo"}}]}'
    )

    lines = []
    for i, p in enumerate(posts_ctx):
        lines.append(json.dumps({
            "i": i,
            "text": (p["text"] or "")[:500],
            "image_description": (p["image"] or "")[:600],
            "comments": p["comments"],
        }, ensure_ascii=False))
    user = "POSTS A CLASIFICAR:\n" + "\n".join(lines)
    return system, user


# Precio por 1M tokens (input, output). Sync chat completions.
PRICING = {"gpt-4o-mini": (0.15, 0.60), "gpt-4o": (2.50, 10.0)}

_ORG_CACHE = {}


def _org_for(post_row: dict):
    """Resuelve organization_id desde brand_container_id (cacheado)."""
    bid = post_row.get("brand_container_id")
    if not bid:
        return None
    if bid in _ORG_CACHE:
        return _ORG_CACHE[bid]
    org = None
    try:
        with httpx.Client(timeout=15) as cli:
            r = cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers", headers=H,
                        params={"id": f"eq.{bid}", "select": "organization_id"})
            rows = r.json() if r.status_code == 200 else []
            org = rows[0]["organization_id"] if rows else None
    except Exception:
        org = None
    _ORG_CACHE[bid] = org
    return org


def _usage_cost(model: str, usage: dict):
    pin, pout = PRICING.get(model, PRICING["gpt-4o-mini"])
    it = int(usage.get("prompt_tokens", 0) or 0)
    ot = int(usage.get("completion_tokens", 0) or 0)
    return round(it / 1e6 * pin + ot / 1e6 * pout, 6), it, ot


def _log_and_bill(model: str, usage: dict, posts: list) -> None:
    """Registra tokens (monitoreo) y COBRA el costo del LLM a los creditos de
    cada org, prorrateado por cantidad de posts del chunk."""
    cost, it, ot = _usage_cost(model, usage)
    try:
        with httpx.Client(timeout=10) as cli:
            cli.post(f"{SUPABASE_URL}/rest/v1/pattern_llm_usage", headers=H,
                     json={"model": model, "input_tokens": it, "output_tokens": ot,
                           "usd_cost": cost, "post_count": len(posts)})
    except Exception:
        pass
    if cost <= 0 or not posts:
        return
    per = cost / len(posts)
    counts = {}
    for p in posts:
        org = _org_for(p)
        if org:
            counts[org] = counts.get(org, 0) + 1
    try:
        from .media_orchestrator import charge_org
        for org, cnt in counts.items():
            charge_org(org, round(per * cnt, 6), "pattern_llm_classify",
                       {"posts": cnt, "model": model})
    except Exception:
        pass


def call_openai(system: str, user: str) -> dict:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY missing")
    payload = {
        "model": MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    with httpx.Client(timeout=120) as cli:
        r = cli.post("https://api.openai.com/v1/chat/completions",
                     headers={"Authorization": f"Bearer {OPENAI_API_KEY}",
                              "Content-Type": "application/json"},
                     json=payload)
        r.raise_for_status()
        data = r.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return json.loads(content), usage


def _clean(items, valid: set, maxn: int = MAX_PER_DIM) -> list:
    """Descarta valores fuera de la biblioteca (el filtro de veracidad)."""
    out = []
    seen = set()
    for it in (items or []):
        if isinstance(it, dict):
            v = str(it.get("value", "")).strip().lower()
            c = it.get("confidence", 0.7)
        else:
            v = str(it).strip().lower()
            c = 0.7
        if v and v in valid and v not in seen:
            try:
                c = round(float(c), 3)
            except Exception:
                c = 0.7
            out.append({"value": v, "confidence": c})
            seen.add(v)
        if len(out) >= maxn:
            break
    return out


# ────────────────────────────────────────────────────────────────────
# Orquestacion del lote
# ────────────────────────────────────────────────────────────────────
CHUNK = 12  # posts por llamada al LLM (taxonomia amortizada, prompt acotado)


def classify_batch(posts: list) -> dict:
    """posts: filas de brand_posts. Devuelve {post_id: {campos multi-etiqueta}}.
    Procesa en sub-lotes de CHUNK para no mandar un prompt gigante ni saturar la API."""
    if not posts:
        return {}
    tax = load_taxonomy()
    valid = _valid_sets(tax)
    out = {}
    for start in range(0, len(posts), CHUNK):
        sub = posts[start:start + CHUNK]
        _classify_chunk(sub, tax, valid, out)
    return out


def _classify_chunk(posts: list, tax: dict, valid: dict, out: dict) -> None:
    ctx = []
    for p in posts:
        ctx.append({
            "id": p["id"],
            "text": p.get("content") or "",
            "image": _post_description(p),
            "comments": fetch_top_comments(p["id"]),
        })

    system, user = build_prompt(ctx, tax)
    parsed, usage = call_openai(system, user)
    _log_and_bill(MODEL, usage, posts)
    by_i = {r.get("i"): r for r in parsed.get("results", [])}

    for i, p in enumerate(posts):
        r = by_i.get(i, {}) or {}
        topics = _clean(r.get("topics"), valid["topic"])
        tones = _clean(r.get("tones"), valid["tone"])
        moods = _clean(r.get("moods"), valid["mood"])
        sents = _clean(r.get("sentiments"), valid["sentiment"])

        audience = None
        aud = r.get("audience")
        if isinstance(aud, dict) and ctx[i]["comments"]:
            def f(k):
                try:
                    return round(float(aud.get(k, 0) or 0), 3)
                except Exception:
                    return 0.0
            audience = {"pos": f("pos"), "neu": f("neu"), "neg": f("neg"),
                        "dominant": aud.get("dominant"),
                        "n_comments": len(ctx[i]["comments"])}

        out[p["id"]] = {
            "topics": topics, "tones": tones, "moods": moods, "sentiments": sents,
            "audience_sentiment": audience,
            # top picks para compatibilidad con el dashboard actual
            "topic": topics[0]["value"] if topics else None,
            "tone": tones[0]["value"] if tones else None,
            "mood": moods[0]["value"] if moods else None,
            "sentiment_evoked": sents[0]["value"] if sents else None,
            "topic_confidence": topics[0]["confidence"] if topics else None,
            "tone_confidence": tones[0]["confidence"] if tones else None,
        }
    return out
