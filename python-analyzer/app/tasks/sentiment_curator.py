"""Curador de léxico de sentimiento — camino FRÍO (semanal).
El LLM (Opus) revisa comentarios reales + el léxico actual y descubre jerga /
expresiones / emojis mal clasificados (regional LatAm, sarcasmo, spanglish) y los
fija en learned_vocabulary (dimension='sentiment'). El modelo rápido los aplica en
el camino caliente. NO puntúa comentarios con LLM (respeta 'no LLM en background').
"""
import os, json, httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("SENTIMENT_CURATOR_MODEL", "claude-opus-4-7")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json", "Prefer": "return=representation"}

SYSTEM = """Eres un experto en analisis de sentimiento de redes sociales en espanol latinoamericano y spanglish.
Te paso comentarios reales de marcas con la etiqueta que les puso un modelo base.
Detecta JERGA, expresiones, emojis y patrones donde la etiqueta esta MAL, o terminos de jerga
que conviene fijar en un lexico, considerando: variantes regionales (Colombia, Mexico, Argentina, etc.),
sarcasmo/ironia, emojis y su carga, y spanglish.
Reglas estrictas:
- Devuelve SOLO JSON valido, sin texto extra.
- Formato: {"entries":[{"term":"...","polarity":"POS"|"NEG","lang":"es"|"en","reason":"..."}]}
- term en minusculas, sin alargamientos (brutal, no brutaaaal). Palabra o expresion corta REUTILIZABLE.
- NO nombres propios, NO @menciones, NO frases unicas.
- Solo terminos con polaridad CLARA y generalizable. Si dudas, omite.
- Maximo 40 terminos."""

async def _fetch_candidates(limit_rows=600, sample=220):
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_post_comments", headers=H,
            params={"select": "content,sentiment", "order": "created_at.desc", "limit": str(limit_rows)})
    rows = r.json() if r.status_code == 200 else []
    seen, out = set(), []
    for c in rows:
        t = (c.get("content") or "").strip()
        if not t or len(t) > 220:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append({"text": t, "label": c.get("sentiment") or "?"})
        if len(out) >= sample:
            break
    return out

async def _existing_terms():
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/learned_vocabulary", headers=H,
            params={"select": "word", "dimension": "eq.sentiment", "limit": "5000"})
    return {x["word"] for x in (r.json() if r.status_code == 200 else [])}

async def _call_llm(system, user):
    headers = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    payload = {"model": MODEL, "max_tokens": 4000, "system": system, "messages": [{"role": "user", "content": user}]}
    async with httpx.AsyncClient(timeout=300) as cli:
        r = await cli.post("https://api.anthropic.com/v1/messages", headers=headers, json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"anthropic {r.status_code}: {r.text[:300]}")
    data = r.json()
    text = data["content"][0]["text"].strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip()), data.get("usage", {})

async def _insert_new(entries, existing):
    rows, seen = [], set()
    for e in entries:
        term = str(e.get("term", "")).strip().lower()
        pol = str(e.get("polarity", "")).upper()
        if not term or pol not in ("POS", "NEG") or term in existing or term in seen:
            continue
        seen.add(term)
        rows.append({"word": term, "dimension": "sentiment", "suggested_value": pol,
                     "language": e.get("lang", "es"), "status": "approved",
                     "notes": (e.get("reason") or "")[:300], "frequency": 1})
    if not rows:
        return 0
    async with httpx.AsyncClient(timeout=30) as cli:
        resp = await cli.post(f"{SUPABASE_URL}/rest/v1/learned_vocabulary",
            headers={**H, "Prefer": "return=minimal"}, json=rows)
        if resp.status_code >= 300:
            raise RuntimeError(f"insert {resp.status_code}: {resp.text[:200]}")
    return len(rows)

async def run_curation():
    existing = await _existing_terms()
    cands = await _fetch_candidates()
    if not cands:
        return {"status": "no_candidates", "added": 0}
    lines = "\n".join(f'- "{c["text"]}" [{c["label"]}]' for c in cands)
    user = f"Comentarios (texto [etiqueta_actual]):\n{lines}\n\nDevuelve el JSON de terminos de lexico."
    parsed, usage = await _call_llm(SYSTEM, user)
    entries = parsed.get("entries", []) if isinstance(parsed, dict) else []
    added = await _insert_new(entries, existing)
    return {"status": "ok", "candidates": len(cands), "proposed": len(entries), "added": added,
            "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
