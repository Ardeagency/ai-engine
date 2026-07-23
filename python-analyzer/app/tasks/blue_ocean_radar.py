"""blue_ocean_radar — detector de OCEANOS AZULES para el tab Tendencias.

Un oceano azul = el mercado BUSCA algo que ni la marca ni su competencia cubren.
Cruza dos fuentes vivas del motor de Tendencias:

  · demanda   → audience_demand_signals (related/rising queries de SerpApi):
                lo que la gente escribe en Google. "El mercado habla."
  · cobertura → trend_topics del contenedor (keywords extraidas de lo que la marca
                y sus competidores YA postean). "Lo que el nicho ya dice."

El gap crudo es demanda que la cobertura no toca, pero medir eso con match exacto
es pobre (nadie escribe la frase literal). Por eso Vera lee la demanda + un resumen
de la cobertura + el perfil de marca y JUZGA, con contrato JSON tipado, cuales son
oceanos reales para ESTA marca y cual es el angulo para ganarlos. Solo los aprobados
(aplica=true, confianza != baja) llegan al tablero.

Idempotente: upsert por (organization_id, gap_key). Nunca revive lo descartado.

Uso:  .venv/bin/python -m app.tasks.blue_ocean_radar [organization_id]
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
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("AUDIENCE_FILTER_MODEL", "claude-sonnet-4-6")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
H_ANTHROPIC = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}

COVERAGE_DAYS = int(os.environ.get("BLUE_OCEAN_COVERAGE_DAYS", "60"))
MAX_OCEANS = int(os.environ.get("BLUE_OCEAN_MAX", "8"))

# Ruido de trend_topics: stopwords que no describen de que habla el nicho.
_STOP = {
    "estos", "espera", "algunos", "habias", "creias", "hablamos", "mientras",
    "nuestra", "habra", "esperanza", "llama", "visto", "datos", "enter", "death",
    "para", "como", "esta", "este", "todo", "todos", "cada", "mas", "muy", "que",
    "con", "por", "los", "las", "una", "uno", "del", "sus", "aqui", "eso",
}


def _get(table: str, params: dict) -> list:
    rows, off = [], 0
    with httpx.Client(timeout=60) as cli:
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


def _key(frase: str) -> str:
    """Normaliza una frase a su llave de dedupe: minusculas, sin tildes ni signos."""
    s = str(frase or "").lower().strip()
    for a, b in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ñ", "n")):
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _demanda(bc_id: str) -> list:
    """Terminos que la gente busca, con su intencion comercial."""
    filas = _get("audience_demand_signals", {
        "brand_container_id": f"eq.{bc_id}",
        "select": "discovered_term,seed_keyword,signal_type,commercial_intent",
    })
    vistos, out = set(), []
    for f in filas:
        t = str(f.get("discovered_term") or "").strip()
        k = _key(t)
        if not t or not k or k in vistos or len(t) > 60:
            continue
        vistos.add(k)
        out.append({
            "termino": t,
            "intencion": str(f.get("commercial_intent") or "medium").lower(),
            "tipo": f.get("signal_type"),
        })
    # Alta intencion primero: son las busquedas mas cerca de la compra.
    out.sort(key=lambda x: (x["intencion"] == "high", x["intencion"] == "medium"), reverse=True)
    return out[:60]


def _cobertura(bc_id: str, desde: dt.date) -> list:
    """De que habla YA el nicho (marca + competidores): top keywords de trend_topics."""
    filas = _get("trend_topics", {
        "brand_container_id": f"eq.{bc_id}",
        "detected_at": f"gte.{desde.isoformat()}",
        "select": "keyword",
    })
    conteo = {}
    for f in filas:
        k = str(f.get("keyword") or "").strip().lower()
        if len(k) < 4 or k in _STOP or not re.match(r"^[a-zñáéíóú]", k):
            continue
        conteo[k] = conteo.get(k, 0) + 1
    top = sorted(conteo.items(), key=lambda kv: kv[1], reverse=True)[:40]
    return [k for k, _ in top]


_SYSTEM = (
    "Eres estratega de contenido de una marca de consumo. Te doy: (1) su perfil, "
    "(2) DEMANDA: lo que la gente busca en Google en su nicho, (3) COBERTURA: las "
    "palabras de las que la marca y sus competidores YA hablan en redes. "
    "Un OCEANO AZUL es una demanda clara del mercado que la COBERTURA no atiende y "
    "que ESTA marca podria capitalizar con naturalidad: territorio con clientes "
    "buscando y sin nadie respondiendo. "
    "Agrupa la demanda en pocos oceanos accionables (no repitas una variante por fila). "
    "Descarta lo que ya esta cubierto por la cobertura, lo ajeno a la categoria, y lo "
    "generico sin oportunidad real. "
    "REGLAS DE FORMATO (duras): responde EXCLUSIVAMENTE un JSON valido, sin texto antes "
    "ni despues. 'oceano' es una frase corta (3-7 palabras) que nombra la oportunidad. "
    "Tu razonamiento va en 'angulo' (como ganar ese oceano, 8-16 palabras), NUNCA en 'oceano'. "
    "'terminos' son las busquedas reales (de la lista de DEMANDA) que forman el oceano. "
    "'intencion' = intencion comercial dominante del cluster (alta|media|baja). "
    "'confianza' = tu certeza de que es un oceano real y no esta ya cubierto (alta|media|baja); "
    "el sistema descarta las de confianza baja. 'aplica'=false si no le sirve a la marca. "
    "Esquema: {\"oceanos\":[{\"oceano\":\"...\",\"angulo\":\"...\",\"intencion\":\"alta\","
    "\"confianza\":\"alta\",\"aplica\":true,\"terminos\":[\"...\"]}]}. Maximo 6."
)


def _juzgar(perfil: str, demanda: list, cobertura: list) -> list:
    if not ANTHROPIC_API_KEY or not demanda:
        return []
    d = "\n".join(f"- {x['termino']} (intencion {x['intencion']})" for x in demanda)
    c = ", ".join(cobertura) or "(sin datos de cobertura)"
    user = f"PERFIL DE LA MARCA:\n{perfil}\n\nDEMANDA (lo que buscan):\n{d}\n\nCOBERTURA (de lo que ya se habla):\n{c}"
    body = {"model": MODEL, "max_tokens": 2000, "system": _SYSTEM,
            "messages": [{"role": "user", "content": user}]}
    try:
        with httpx.Client(timeout=90) as cli:
            r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
        if r.status_code >= 400:
            print(f"    [vera] Anthropic {r.status_code}: {r.text[:140]}")
            return []
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        start = txt.find("{")
        obj = json.JSONDecoder().raw_decode(txt[start:])[0] if start >= 0 else {}
        out = []
        for o in obj.get("oceanos", []):
            frase = str(o.get("oceano") or "").strip(" .,-–—")
            if not (3 <= len(frase) <= 80) or re.search(r"[/|;?]", frase):
                continue
            aplica = o.get("aplica")
            if not isinstance(aplica, bool):
                continue
            conf = str(o.get("confianza", "media")).strip().lower()
            if conf not in ("alta", "media", "baja"):
                conf = "media"
            intent = str(o.get("intencion", "media")).strip().lower()
            if intent not in ("alta", "media", "baja"):
                intent = "media"
            terminos = [str(t).strip() for t in (o.get("terminos") or []) if str(t).strip()][:8]
            out.append({
                "gap_phrase": frase[:120],
                "angle": str(o.get("angulo") or "").strip()[:200] or None,
                "intent": intent, "confianza": conf, "aplica": aplica,
                "demand_terms": terminos,
            })
        return out
    except Exception as e:  # noqa: BLE001 — el juicio es enhancement, fail-soft
        print(f"    [vera] error: {str(e)[:120]}")
        return []


def _perfil_marca(bc: dict) -> str:
    return "\n".join([
        f"Marca: {bc.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {bc.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(bc.get('sub_nichos') or []) or '—'}",
        f"Palabras clave: {', '.join((bc.get('palabras_clave') or [])[:12]) or '—'}",
        f"Mercado: {', '.join(bc.get('mercado_objetivo') or []) or '—'}",
    ])


def _ya_descartados(org_id: str) -> set:
    """Oceanos que el usuario ya descarto o marco como usados: no se re-proponen."""
    rows = _get("content_gaps", {
        "organization_id": f"eq.{org_id}", "status": "in.(used,dismissed)", "select": "gap_key"})
    return {r["gap_key"] for r in rows}


def _upsert(filas: list):
    if not filas:
        return
    with httpx.Client(timeout=60) as cli:
        r = cli.post(
            f"{SUPABASE_URL}/rest/v1/content_gaps",
            headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"},
            params={"on_conflict": "organization_id,gap_key"},
            json=filas,
        )
        if r.status_code >= 300:
            print(f"  upsert error {r.status_code}: {r.text[:200]}")


def main():
    hoy = dt.date.today()
    desde = hoy - dt.timedelta(days=COVERAGE_DAYS)
    only_org = sys.argv[1] if len(sys.argv) > 1 else None

    params = {"select": "id,organization_id,nombre_marca,nicho_core,sub_nichos,palabras_clave,mercado_objetivo"}
    if only_org:
        params["organization_id"] = f"eq.{only_org}"

    total_orgs = total_oceans = 0
    for bc in _get("brand_containers", params):
        org_id, bc_id = bc.get("organization_id"), bc.get("id")
        if not org_id or not bc_id:
            continue

        demanda = _demanda(bc_id)
        if not demanda:
            continue
        cobertura = _cobertura(bc_id, desde)
        oceanos = _juzgar(_perfil_marca(bc), demanda, cobertura)
        if not oceanos:
            continue

        descartados = _ya_descartados(org_id)
        filas, ahora = [], dt.datetime.now(dt.timezone.utc).isoformat()
        for o in oceanos:
            k = _key(o["gap_phrase"])
            if not k or k in descartados:
                continue
            score = 0.5 + (0.25 if o["intent"] == "alta" else 0.1 if o["intent"] == "media" else 0) \
                        + (0.2 if o["confianza"] == "alta" else 0)
            filas.append({
                "organization_id": org_id, "brand_container_id": bc_id,
                "gap_phrase": o["gap_phrase"], "gap_key": k, "angle": o["angle"],
                "demand_terms": o["demand_terms"], "intent": o["intent"],
                "confianza": o["confianza"], "aplica": o["aplica"],
                "relevance_score": round(min(0.95, score), 2),
                "last_seen_at": ahora,
            })
        filas = [f for f in filas if f["aplica"] is not False][:MAX_OCEANS]
        _upsert(filas)
        aprobados = sum(1 for f in filas if f["aplica"] is True)
        total_orgs += 1
        total_oceans += len(filas)
        print(f"  {org_id[:8]} -> {len(demanda)} demandas, {len(cobertura)} coberturas "
              f"-> {len(filas)} oceanos ({aprobados} aprobados por Vera)")

    print(f"blue_ocean_radar: {total_orgs} marcas, {total_oceans} oceanos (cobertura {COVERAGE_DAYS}d)")


if __name__ == "__main__":
    main()
