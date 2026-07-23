"""profile_radar — detector de PERFILES RECOMENDADOS para monitorear.

Reemplaza al viejo detector de "marcas emergentes", que colgaba del clasificador
(subsistema eliminado; su ultimo dato es del 2026-05-06). Este se apoya SOLO en
fuentes vivas del motor de Tendencias:

  · mention       → @handles que aparecen en el contenido ya scrapeado de los
                    perfiles que la marca ya vigila. Costo cero: la data ya se pago.
  · search_demand → related/rising queries de audience_demand_signals (SerpApi)
                    que parecen nombre de marca y no un termino generico.

Los candidatos crudos son ruido puro ("cristiano", "amazon", "chicles sin azucar"),
asi que Vera los juzga con un contrato JSON tipado —igual que world_calendar— y
solo los aprobados (aplica=true) llegan al tablero. Sin LLM disponible los
candidatos quedan guardados SIN juicio: el RPC no los muestra, pero tampoco se
pierde el trabajo de deteccion.

Idempotente: upsert por (organization_id, handle_key, discovery_source). Nunca
revive lo que el usuario ya adopto o descarto.

Uso:  .venv/bin/python -m app.tasks.profile_radar [organization_id]
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

LOOKBACK_DAYS = int(os.environ.get("PROFILE_RADAR_LOOKBACK_DAYS", "120"))
MAX_CANDIDATES = int(os.environ.get("PROFILE_RADAR_MAX_CANDIDATES", "40"))

MENTION_RE = re.compile(r"@([A-Za-z0-9._]{3,30})")

# Cuentas que aparecen en cualquier nicho y nunca son "un competidor emergente":
# plataformas, retailers gigantes y celebridades globales. Se filtran antes de
# gastar un token de LLM.
RUIDO = {
    "instagram", "facebook", "tiktok", "youtube", "twitter", "x", "threads",
    "whatsapp", "spotify", "amazon", "target", "walmart", "shopify", "google",
    "apple", "netflix", "cristiano", "leomessi", "therock", "kyliejenner",
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


def _key(handle: str) -> str:
    """Normaliza un @handle a su llave de dedupe. Los puntos y guiones bajos del
    FINAL se caen: en el texto suelen ser puntuacion de la frase, no del handle
    ('mira a @drinkpoppi.' no es una cuenta distinta de @drinkpoppi)."""
    k = re.sub(r"[^a-z0-9._]", "", str(handle or "").strip().lstrip("@").lower())
    return k.strip("._")


# ── Fuente 1: menciones en el contenido ya scrapeado ────────────────────────
def _candidatos_por_mencion(bc_id: str, desde: dt.date) -> dict:
    posts = _get("brand_posts", {
        "brand_container_id": f"eq.{bc_id}",
        "captured_at": f"gte.{desde.isoformat()}",
        "select": "content,network,profile_handle",
    })
    out = {}
    for p in posts:
        for raw in MENTION_RE.findall(p.get("content") or ""):
            k = _key(raw)
            if not k or k in RUIDO or len(k) < 3:
                continue
            c = out.setdefault(k, {
                "handle": k, "platform": p.get("network"),
                "veces": 0, "quien_lo_menciona": set(),
            })
            c["veces"] += 1
            if p.get("profile_handle"):
                c["quien_lo_menciona"].add(p["profile_handle"])
    for c in out.values():
        c["quien_lo_menciona"] = sorted(c["quien_lo_menciona"])
    return out


# ── Fuente 2: demanda de busqueda que parece nombre de marca ────────────────
def _candidatos_por_demanda(bc_id: str) -> dict:
    filas = _get("audience_demand_signals", {
        "brand_container_id": f"eq.{bc_id}",
        "select": "discovered_term,seed_keyword,signal_type,geo,commercial_intent",
    })
    out = {}
    for f in filas:
        termino = str(f.get("discovered_term") or "").strip()
        if not termino or len(termino) > 40:
            continue
        k = _key(termino.replace(" ", ""))
        if not k or k in RUIDO:
            continue
        c = out.setdefault(k, {
            "handle": None, "display_name": termino, "platform": None,
            "veces": 0, "semillas": set(), "geo": f.get("geo"),
        })
        c["veces"] += 1
        if f.get("seed_keyword"):
            c["semillas"].add(f["seed_keyword"])
    for c in out.values():
        c["semillas"] = sorted(c["semillas"])
    return out


# ── Juicio de Vera: contrato JSON tipado, sin texto libre ───────────────────
_SYSTEM = (
    "Eres el radar de competencia de una marca de consumo. Recibes su perfil y una lista de "
    "CANDIDATOS crudos extraidos automaticamente: menciones (@cuenta) que aparecen en el contenido "
    "del nicho, y terminos que la gente busca en Google. La mayoria es RUIDO. "
    "Tu trabajo: decidir cuales son de verdad una MARCA, NEGOCIO o CREADOR del nicho que a esta "
    "marca le conviene vigilar, y cuales no. "
    "aplica=false para: personas famosas sin relacion con la categoria, plataformas y retailers "
    "genericos, terminos descriptivos que no son una marca ('chicles sin azucar'), cuentas de la "
    "propia marca, y cualquier cosa de la que no estes seguro. "
    "REGLAS DE FORMATO (duras): responde EXCLUSIVAMENTE un JSON valido, sin texto antes ni despues. "
    "'candidato' debe ser el identificador EXACTO que recibiste, copiado literal. Tu razonamiento "
    "va en 'motivo', NUNCA dentro de otro campo. 'nombre' es como se llama la marca en limpio "
    "(sin arrobas ni comentarios), o null si no lo sabes. "
    "'confianza' es tu certeza real de que existe y es del nicho: 'baja' si estas adivinando. "
    "Esquema: {\"candidatos\":[{\"candidato\":\"exacto\",\"nombre\":\"Marca X\",\"aplica\":true,"
    "\"confianza\":\"alta\",\"motivo\":\"6-12 palabras: por que vigilarla\"}]}."
)


def _juzgar(perfil: str, candidatos: list) -> dict:
    """{clave: (aplica, nombre, confianza, motivo)}. Fail-soft: {} si el LLM no responde."""
    if not ANTHROPIC_API_KEY or not candidatos:
        return {}
    lineas = []
    for c in candidatos:
        ev = []
        if c.get("veces"):
            ev.append(f"visto {c['veces']}x")
        if c.get("quien_lo_menciona"):
            ev.append("mencionado por " + ", ".join(c["quien_lo_menciona"][:3]))
        if c.get("semillas"):
            ev.append("buscado junto a " + ", ".join(c["semillas"][:3]))
        etiqueta = c["clave"] if c["origen"] == "mention" else (c.get("display_name") or c["clave"])
        lineas.append(f"- {etiqueta} ({c['origen']}; {'; '.join(ev) or 'sin evidencia'})")
    user = f"PERFIL DE LA MARCA:\n{perfil}\n\nCANDIDATOS:\n" + "\n".join(lineas)
    body = {"model": MODEL, "max_tokens": 2000, "system": _SYSTEM,
            "messages": [{"role": "user", "content": user}]}
    try:
        with httpx.Client(timeout=90) as cli:
            r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
        if r.status_code >= 400:
            print(f"    [vera] Anthropic {r.status_code}: {r.text[:140]}")
            return {}
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        start = txt.find("{")
        obj = json.JSONDecoder().raw_decode(txt[start:])[0] if start >= 0 else {}
        out = {}
        for it in obj.get("candidatos", []):
            k = _key(str(it.get("candidato", "")).replace(" ", ""))
            if not k:
                continue
            aplica = it.get("aplica")
            if not isinstance(aplica, bool):
                continue
            conf = str(it.get("confianza", "media")).strip().lower()
            if conf not in ("alta", "media", "baja"):
                conf = "media"
            nombre = str(it.get("nombre") or "").strip() or None
            # Un nombre con arroba, barra o comentario = el modelo se salio del contrato.
            if nombre and (len(nombre) > 60 or re.search(r"[@/|?]", nombre)):
                nombre = None
            out[k] = (aplica, nombre, conf, str(it.get("motivo") or "").strip()[:160])
        return out
    except Exception as e:  # noqa: BLE001 — el juicio es enhancement, fail-soft
        print(f"    [vera] error: {str(e)[:120]}")
        return {}


def _perfil_marca(bc: dict) -> str:
    return "\n".join([
        f"Marca: {bc.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {bc.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(bc.get('sub_nichos') or []) or '—'}",
        f"Palabras clave: {', '.join((bc.get('palabras_clave') or [])[:12]) or '—'}",
        f"Mercado: {', '.join(bc.get('mercado_objetivo') or []) or '—'}",
    ])


def _ya_conocidos(org_id: str) -> set:
    """Lo que ya se vigila + lo que el usuario ya adopto o descarto: no se re-propone."""
    ya = set()
    for e in _get("intelligence_entities", {"organization_id": f"eq.{org_id}", "select": "target_identifier,name"}):
        for v in (e.get("target_identifier"), e.get("name")):
            k = _key(str(v or "").replace(" ", ""))
            if k:
                ya.add(k)
    for r in _get("profile_recommendations", {
            "organization_id": f"eq.{org_id}", "status": "in.(added,dismissed)", "select": "handle_key"}):
        ya.add(r["handle_key"])
    return ya


def _upsert(filas: list):
    if not filas:
        return
    with httpx.Client(timeout=60) as cli:
        r = cli.post(
            f"{SUPABASE_URL}/rest/v1/profile_recommendations",
            headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"},
            params={"on_conflict": "organization_id,handle_key,discovery_source"},
            json=filas,
        )
        if r.status_code >= 300:
            print(f"  upsert error {r.status_code}: {r.text[:200]}")


def main():
    hoy = dt.date.today()
    desde = hoy - dt.timedelta(days=LOOKBACK_DAYS)
    only_org = sys.argv[1] if len(sys.argv) > 1 else None

    params = {"select": "id,organization_id,nombre_marca,nicho_core,sub_nichos,palabras_clave,mercado_objetivo"}
    if only_org:
        params["organization_id"] = f"eq.{only_org}"

    total_orgs = total_props = 0
    for bc in _get("brand_containers", params):
        org_id, bc_id = bc.get("organization_id"), bc.get("id")
        if not org_id or not bc_id:
            continue

        ya = _ya_conocidos(org_id)
        crudos = []
        for k, c in _candidatos_por_mencion(bc_id, desde).items():
            if k not in ya:
                crudos.append({**c, "clave": k, "origen": "mention"})
        for k, c in _candidatos_por_demanda(bc_id).items():
            if k not in ya:
                crudos.append({**c, "clave": k, "origen": "search_demand"})
        if not crudos:
            continue

        # Primero los que mas gente distinta menciona: la evidencia manda.
        crudos.sort(key=lambda c: (len(c.get("quien_lo_menciona") or []), c.get("veces", 0)), reverse=True)
        crudos = crudos[:MAX_CANDIDATES]
        juicio = _juzgar(_perfil_marca(bc), crudos)

        filas = []
        for c in crudos:
            aplica, nombre, conf, motivo = juicio.get(c["clave"], (None, None, None, None))
            if aplica is False:
                continue                      # no aplica -> no se guarda (ni ocupa tablero)
            distintos = len(c.get("quien_lo_menciona") or []) or (1 if c.get("veces") else 0)
            filas.append({
                "organization_id": org_id,
                "brand_container_id": bc_id,
                "handle": c.get("handle"),
                "handle_key": c["clave"],
                "display_name": nombre or c.get("display_name"),
                "platform": c.get("platform"),
                "discovery_source": c["origen"],
                "evidence": {
                    "veces": c.get("veces", 0),
                    "quien_lo_menciona": c.get("quien_lo_menciona") or [],
                    "semillas": c.get("semillas") or [],
                    "geo": c.get("geo"),
                },
                "mentions_count": c.get("veces", 0),
                "distinct_sources": distintos,
                "aplica": aplica,
                "motivo": motivo,
                "confianza": conf,
                "relevance_score": round(min(0.95, 0.4 + 0.15 * distintos + (0.2 if conf == "alta" else 0)), 2),
                "last_seen_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            })
        _upsert(filas)
        aprobados = sum(1 for f in filas if f["aplica"] is True)
        sin_juicio = sum(1 for f in filas if f["aplica"] is None)
        total_orgs += 1
        total_props += len(filas)
        print(f"  {org_id[:8]} -> {len(crudos)} candidatos, {len(filas)} guardados "
              f"({aprobados} aprobados por Vera, {sin_juicio} sin juicio)")

    print(f"profile_radar: {total_orgs} marcas, {total_props} recomendaciones (ventana {LOOKBACK_DAYS}d)")


if __name__ == "__main__":
    main()
