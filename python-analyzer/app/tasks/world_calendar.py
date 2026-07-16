"""world_calendar — populador GRATIS de real_world_signals (signal_type='holiday').

Genera los festivos proximos (siguiente ventana de dias) para los paises objetivo
de cada marca (brand_containers.mercado_objetivo), usando la libreria offline
`holidays` — sin ninguna API de pago. Alimenta la seccion "Sincronizacion con el
mundo" del dashboard Tendencias y la card de evento del hero.

Idempotente: por org borra los 'holiday' futuros y reinserta el set fresco.

Uso:  .venv/bin/python -m app.tasks.world_calendar [organization_id]
"""
import os
import re
import sys
import json
import datetime as dt

import httpx
import holidays as holidays_lib
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TAG_MODEL = os.environ.get("AUDIENCE_FILTER_MODEL", "claude-sonnet-4-6")
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
H_ANTHROPIC = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}

LOOKAHEAD_DAYS = int(os.environ.get("CALENDAR_LOOKAHEAD_DAYS", "120"))

# mercado_objetivo es texto libre -> ISO country code para la libreria holidays.
COUNTRY_MAP = {
    "colombia": "CO", "co": "CO",
    "mexico": "MX", "méxico": "MX", "mx": "MX",
    "estados unidos": "US", "usa": "US", "us": "US", "usa latino": "US",
    "united states": "US", "eeuu": "US", "ee.uu.": "US",
    "argentina": "AR", "ar": "AR",
    "peru": "PE", "perú": "PE", "pe": "PE",
    "chile": "CL", "cl": "CL",
    "ecuador": "EC", "ec": "EC",
    "españa": "ES", "espana": "ES", "spain": "ES", "es": "ES",
    "brasil": "BR", "brazil": "BR", "br": "BR",
    "venezuela": "VE", "ve": "VE",
    "panama": "PA", "panamá": "PA", "pa": "PA",
    "guatemala": "GT", "gt": "GT",
    "costa rica": "CR", "cr": "CR",
    "uruguay": "UY", "uy": "UY",
    "paraguay": "PY", "py": "PY",
    "bolivia": "BO", "bo": "BO",
    "republica dominicana": "DO", "república dominicana": "DO", "dominican republic": "DO", "do": "DO",
}
# Regiones fuzzy -> conjunto representativo.
REGION_MAP = {
    "latinoamerica": ["CO", "MX", "AR"], "latinoamérica": ["CO", "MX", "AR"],
    "latam": ["CO", "MX", "AR"], "america latina": ["CO", "MX", "AR"],
    "centroamerica": ["GT", "CR", "PA"], "centroamérica": ["GT", "CR", "PA"],
    "hispano": ["CO", "MX", "US"], "hispanos": ["CO", "MX", "US"],
}


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


def _resolve_geos(mercado: list) -> set:
    geos = set()
    for raw in (mercado or []):
        k = str(raw).strip().lower()
        if k in COUNTRY_MAP:
            geos.add(COUNTRY_MAP[k])
        elif k in REGION_MAP:
            geos.update(REGION_MAP[k])
    return geos


# Geos donde preferimos el nombre del festivo en espanol.
SPANISH_GEOS = {"CO", "MX", "AR", "PE", "CL", "EC", "ES", "VE", "PA", "GT",
                "CR", "UY", "PY", "BO", "DO"}


def _upcoming_holidays(geo: str, today: dt.date, horizon: dt.date) -> list:
    years = sorted({today.year, horizon.year})
    cal = None
    if geo in SPANISH_GEOS:
        try:
            cal = holidays_lib.country_holidays(geo, years=years, language="es")
        except (NotImplementedError, KeyError, TypeError):
            cal = None
    if cal is None:
        try:
            cal = holidays_lib.country_holidays(geo, years=years)
        except (NotImplementedError, KeyError):
            return []
    out = []
    for d, name in cal.items():
        if today <= d <= horizon:
            out.append((d, name))
    return out


def _rows_for_container(org_id: str, bc_id: str, geos: set, today: dt.date, horizon: dt.date) -> list:
    rows = []
    seen = set()
    for geo in sorted(geos):
        for d, name in _upcoming_holidays(geo, today, horizon):
            key = (geo, d.isoformat(), name)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "organization_id": org_id,
                "brand_container_id": bc_id,
                "signal_type": "holiday",
                "signal_subtype": "public_holiday",
                "geo": geo,
                "event_date": d.isoformat(),
                "event_name": name,
                "event_description": None,
                "days_until": (d - today).days,
                "source_name": "holidays-lib",
                "source_url": None,
                "relevance_score": 0.6,
                "raw_data": {"country": geo, "kind": "public_holiday"},
                "measured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "fetch_date": today.isoformat(),
                "expires_at": (dt.datetime.combine(d, dt.time()) + dt.timedelta(days=1))
                              .replace(tzinfo=dt.timezone.utc).isoformat(),
            })
    return rows


def _brand_profile(bc: dict) -> str:
    return "\n".join([
        f"Marca: {bc.get('nombre_marca') or '(sin nombre)'}",
        f"Nicho/categoria: {bc.get('nicho_core') or '(no definido)'}",
        f"Sub-nichos: {', '.join(bc.get('sub_nichos') or []) or '—'}",
        f"Palabras clave: {', '.join((bc.get('palabras_clave') or [])[:12]) or '—'}",
    ])


_TAG_SYSTEM = (
    "Eres un estratega de contenido de marca. Recibes el perfil de una marca de consumo y "
    "una lista de FECHAS/FESTIVOS proximos. Para CADA fecha decide si a ESTA marca le conviene "
    "activar contenido/campana en esa fecha: "
    "verdict='utilizar' si es una ocasion claramente provechosa y coherente con la categoria, "
    "audiencia y tono de la marca (una ocasion de consumo o cultural que la marca puede capitalizar "
    "con naturalidad); verdict='descartar' si NO le aporta (fecha solemne, luctuosa, religiosa sensible, "
    "ajena a la categoria, o donde activar se veria forzado u oportunista). Da una razon MUY breve "
    "(4-8 palabras). Responde EXCLUSIVAMENTE JSON valido: "
    "{\"results\":[{\"event\":\"nombre exacto\",\"verdict\":\"utilizar|descartar\",\"reason\":\"...\"}]}."
)


def _classify_holidays(profile: str, names: list) -> dict:
    """Devuelve {nombre_lower: (verdict, reason)}. Fail-soft: {} si el LLM no responde."""
    if not ANTHROPIC_API_KEY or not names:
        return {}
    user = f"PERFIL DE LA MARCA:\n{profile}\n\nFECHAS PROXIMAS:\n" + "\n".join(f"- {n}" for n in names)
    body = {"model": TAG_MODEL, "max_tokens": 1500, "system": _TAG_SYSTEM,
            "messages": [{"role": "user", "content": user}]}
    try:
        with httpx.Client(timeout=60) as cli:
            r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
        if r.status_code >= 400:
            print(f"    [tag] Anthropic {r.status_code}: {r.text[:120]}")
            return {}
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        m = re.search(r"\{.*\}", txt, re.DOTALL)
        out = {}
        for it in (json.loads(m.group(0)).get("results", []) if m else []):
            ev = str(it.get("event", "")).strip().lower()
            vd = str(it.get("verdict", "")).strip().lower()
            if ev and vd in ("utilizar", "descartar"):
                out[ev] = (vd, str(it.get("reason", "")).strip()[:120])
        return out
    except Exception as e:  # noqa: BLE001 — tagging es enhancement, fail-soft
        print(f"    [tag] error: {str(e)[:100]}")
        return {}


def _apply_verdicts(rows: list, verdicts: dict):
    for row in rows:
        vd = verdicts.get(row["event_name"].strip().lower())
        if not vd:
            continue
        verdict, reason = vd
        row["event_description"] = reason or None
        row["relevance_score"] = 0.85 if verdict == "utilizar" else 0.3
        row["raw_data"]["verdict"] = verdict
        row["raw_data"]["reason"] = reason


_INTL_SYSTEM = (
    "Eres un radar de EVENTOS INTERNACIONALES para marcas de consumo. Lista los eventos que "
    "mueven la OPINION PUBLICA (global o de la region de la marca) y ocurren en la ventana dada: "
    "deportivos (mundiales, copas del mundo, olimpiadas, finales de torneos grandes), culturales "
    "globales (Miss Universo, premios, festivales masivos), y fechas comerciales globales "
    "(Black Friday, Cyber Monday, San Valentin, etc.). SOLO eventos de los que estes seguro de la "
    "fecha (aproximada esta bien). Para la marca dada juzga cada uno: verdict 'utilizar' (la marca "
    "PUEDE capitalizarlo con contenido/campana) o 'descartar' (no le aporta o es forzado). "
    "Responde EXCLUSIVAMENTE JSON: {\"events\":[{\"event\":\"\",\"date\":\"YYYY-MM-DD\","
    "\"why\":\"6-12 palabras: como lo aprovecha\",\"verdict\":\"utilizar|descartar\"}]}. "
    "Maximo 8, ordenados por fecha. Si ninguno es confiable, {\"events\":[]}."
)


def _intl_events(profile: str, today: dt.date, horizon: dt.date) -> list:
    """Eventos internacionales (LLM) con fecha, en la ventana, taggeados para la marca."""
    if not ANTHROPIC_API_KEY:
        return []
    user = (f"PERFIL DE LA MARCA:\n{profile}\n\nHoy es {today.isoformat()}. "
            f"Ventana: {today.isoformat()} a {horizon.isoformat()}.")
    body = {"model": TAG_MODEL, "max_tokens": 1500, "system": _INTL_SYSTEM,
            "messages": [{"role": "user", "content": user}]}
    try:
        with httpx.Client(timeout=90) as cli:
            r = cli.post("https://api.anthropic.com/v1/messages", headers=H_ANTHROPIC, json=body)
        if r.status_code >= 400:
            print(f"    [intl] Anthropic {r.status_code}: {r.text[:120]}"); return []
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        start = txt.find("{")
        obj = json.JSONDecoder().raw_decode(txt[start:])[0] if start >= 0 else {}
        out = []
        for e in obj.get("events", []):
            dm = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(e.get("date", "")))
            if not dm:
                continue
            try:
                d = dt.date(int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
            except ValueError:
                continue
            if not (today <= d <= horizon):
                continue
            vd = str(e.get("verdict", "")).lower()
            out.append({"event": str(e.get("event", "")).strip()[:120], "date": d,
                        "why": str(e.get("why", "")).strip()[:160],
                        "verdict": vd if vd in ("utilizar", "descartar") else "utilizar"})
        return out
    except Exception as ex:  # noqa: BLE001
        print(f"    [intl] error: {str(ex)[:100]}"); return []


def _intl_rows(org_id: str, bc_id: str, geo: str, events: list, today: dt.date) -> list:
    rows = []
    for e in events:
        d = e["date"]
        rows.append({
            "organization_id": org_id, "brand_container_id": bc_id,
            "signal_type": "cultural_moment", "signal_subtype": "international",
            "geo": geo, "event_date": d.isoformat(), "event_name": e["event"],
            "event_description": e["why"] or None, "days_until": (d - today).days,
            "source_name": "llm-intl", "source_url": None,
            "relevance_score": 0.85 if e["verdict"] == "utilizar" else 0.3,
            "raw_data": {"verdict": e["verdict"], "reason": e["why"], "scope": "international"},
            "measured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "fetch_date": today.isoformat(),
            "expires_at": (dt.datetime.combine(d, dt.time()) + dt.timedelta(days=1))
                          .replace(tzinfo=dt.timezone.utc).isoformat(),
        })
    return rows


def _existing_verdicts(org_id: str) -> dict:
    """Verdicts ya guardados (por nombre de fecha) para NO re-llamar al LLM en cada
    corrida. El LLM solo clasifica fechas nuevas. Ahorro de costo en regimen estable."""
    rows = _get("real_world_signals", {
        "organization_id": f"eq.{org_id}", "signal_type": "eq.holiday",
        "select": "event_name,raw_data,event_description"})
    out = {}
    for r in rows:
        rd = r.get("raw_data") or {}
        if isinstance(rd, str):
            try:
                rd = json.loads(rd)
            except Exception:
                rd = {}
        v = rd.get("verdict")
        if v in ("utilizar", "descartar"):
            out[str(r.get("event_name", "")).strip().lower()] = (v, r.get("event_description") or "")
    return out


def _replace_future_holidays(org_id: str, today: dt.date, rows: list):
    with httpx.Client(timeout=30) as cli:
        # Borra holidays futuros previos de la org (idempotencia).
        cli.delete(
            f"{SUPABASE_URL}/rest/v1/real_world_signals",
            headers=H,
            params={"organization_id": f"eq.{org_id}",
                    "signal_type": "in.(holiday,sport_event,cultural_moment)",
                    "event_date": f"gte.{today.isoformat()}"},
        )
        if rows:
            for i in range(0, len(rows), 500):
                r = cli.post(f"{SUPABASE_URL}/rest/v1/real_world_signals",
                             headers={**H, "Prefer": "return=minimal"}, json=rows[i:i + 500])
                if r.status_code >= 300:
                    print(f"  insert error {r.status_code}: {r.text[:200]}")


def main():
    today = dt.date.today()
    horizon = today + dt.timedelta(days=LOOKAHEAD_DAYS)
    only_org = sys.argv[1] if len(sys.argv) > 1 else None

    params = {"select": "id,organization_id,mercado_objetivo,nombre_marca,nicho_core,sub_nichos,palabras_clave"}
    if only_org:
        params["organization_id"] = f"eq.{only_org}"
    containers = _get("brand_containers", params)

    total_orgs, total_rows = 0, 0
    for bc in containers:
        org_id = bc.get("organization_id")
        geos = _resolve_geos(bc.get("mercado_objetivo"))
        if not org_id or not geos:
            continue
        rows = _rows_for_container(org_id, bc.get("id"), geos, today, horizon)
        # Etiqueta cada fecha: Utilizar (provechosa) / Descartar (no le conviene). INCREMENTAL:
        # reusa verdicts ya guardados; el LLM SOLO clasifica fechas nuevas (0 llamadas si nada cambio).
        _apply_verdicts(rows, _existing_verdicts(org_id))
        pending = sorted({r["event_name"] for r in rows if not r["raw_data"].get("verdict")})
        if pending:
            _apply_verdicts(rows, _classify_holidays(_brand_profile(bc), pending))
        # Eventos internacionales (mundiales, Miss Universo, Black Friday...) via LLM.
        intl = _intl_events(_brand_profile(bc), today, horizon)
        rows += _intl_rows(org_id, bc.get("id"), (sorted(geos) or [""])[0], intl, today)
        _replace_future_holidays(org_id, today, rows)
        total_orgs += 1
        total_rows += len(rows)
        util = sum(1 for r in rows if r["raw_data"].get("verdict") == "utilizar")
        desc = sum(1 for r in rows if r["raw_data"].get("verdict") == "descartar")
        print(f"  {org_id[:8]} geos={sorted(geos)} -> {len(rows)} fechas ({len(intl)} intl, {util} utilizar, {desc} descartar)")

    print(f"world_calendar: {total_orgs} marcas, {total_rows} festivos (ventana {LOOKAHEAD_DAYS}d)")


if __name__ == "__main__":
    main()
