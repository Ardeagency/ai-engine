"""
watched_terms.py — mide a diario los terminos que VERA decidio vigilar.

LA DIFERENCIA CON audience_demand.py: aquel siembra de `palabras_clave`, una
lista estatica escrita una vez que no aprende nada. Este siembra de lo que Vera
puso a vigilar porque lo vio pasar — un tema que encendio los comentarios de un
competidor, una palabra que se repetia en 300 bios. La automatizacion ejecuta;
la inteligencia decide QUE se ejecuta.

POR QUE DIARIO SI GOOGLE YA DA LA SERIE. La serie de 12 meses viene entera en
una sola llamada, asi que medir a diario no sirve para "construir la curva".
Sirve para lo otro: ver QUE CONSULTA APARECIO HOY QUE AYER NO ESTABA. Una
consulta en breakout es una ola empezando, y eso solo se ve comparando dias.

LA CUOTA MANDA. SerpApi Free son 250 busquedas/mes para TODO el sistema. Este
colector nunca se las come: respeta una reserva y, si no alcanza, mide los
terminos mas antiguos sin medir y deja el resto para mañana — degradar, no
reventar.
"""
import os
import sys
import json
import datetime as dt
import httpx
from dotenv import load_dotenv

load_dotenv("/root/ai-engine/.env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SERPAPI_KEY = os.environ.get("SERPAPI_KEY", "")
DEMO_ORG = os.environ.get("DEMO_ORG_ID", "")
RESERVA = int(os.environ.get("SERPAPI_RESERVA_COLECTORES", "80"))

H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
     "Content-Type": "application/json"}


def _get(table, params):
    with httpx.Client(timeout=30) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H, params={**params, "limit": "500"})
        return r.json() if r.status_code == 200 else []


def _post(table, rows, on_conflict=None):
    # `Prefer: merge-duplicates` NO basta: sin `on_conflict` PostgREST no sabe
    # contra que constraint fusionar y devuelve 23505. Se nota solo cuando se
    # corre dos veces el mismo dia — o sea en el reintento, justo cuando duele.
    params = {"on_conflict": on_conflict} if on_conflict else {}
    with httpx.Client(timeout=30) as cli:
        r = cli.post(f"{SUPABASE_URL}/rest/v1/{table}",
                     headers={**H, "Prefer": "resolution=merge-duplicates"},
                     params=params, json=rows)
        return r.status_code < 300, (r.text[:200] if r.status_code >= 300 else "")


def _patch(table, params, body):
    # Devuelve el error en vez de tragarselo: un PATCH rechazado que nadie mira
    # deja el dato viejo en pantalla con cara de recien medido.
    with httpx.Client(timeout=30) as cli:
        r = cli.patch(f"{SUPABASE_URL}/rest/v1/{table}", headers=H, params=params, json=body)
        return (r.status_code < 300, r.text[:200] if r.status_code >= 300 else "")


def _cuota():
    try:
        with httpx.Client(timeout=20) as cli:
            d = cli.get("https://serpapi.com/account", params={"api_key": SERPAPI_KEY}).json()
        return int(d.get("total_searches_left") or 0)
    except Exception:
        return -1


def _related(term, geo):
    params = {"engine": "google_trends", "data_type": "RELATED_QUERIES", "q": term, "api_key": SERPAPI_KEY}
    if geo:
        params["geo"] = geo
    with httpx.Client(timeout=60) as cli:
        r = cli.get("https://serpapi.com/search.json", params=params)
        try:
            return r.json()
        except Exception:
            return {"error": f"http {r.status_code}"}


def _extraer(data):
    rq = data.get("related_queries") or {}
    top = [{"termino": x.get("query"), "interes": x.get("extracted_value")}
           for x in (rq.get("top") or [])[:15]]
    rising = []
    for x in (rq.get("rising") or [])[:15]:
        v = x.get("extracted_value")
        rising.append({
            "termino": x.get("query"),
            "crecimiento": "Breakout" if (isinstance(v, (int, float)) and v >= 5000)
                           else (f"+{v}%" if v is not None else None),
            "valor": v,
        })
    return top, rising


def main():
    if not SERPAPI_KEY:
        print("watched_terms: falta SERPAPI_KEY"); return
    solo = sys.argv[1] if len(sys.argv) > 1 else None

    params = {"select": "id,organization_id,brand_container_id,term,geo,ultima_medicion",
              "is_active": "eq.true", "order": "ultima_medicion.asc.nullsfirst"}
    if solo:
        params["brand_container_id"] = f"eq.{solo}"
    terminos = [t for t in _get("watched_search_terms", params)
                if t.get("organization_id") != DEMO_ORG]
    if not terminos:
        print("watched_terms: no hay terminos vigilados"); return

    quedan = _cuota()
    if quedan >= 0:
        margen = max(0, quedan - RESERVA)
        if margen <= 0:
            print(f"watched_terms: quedan {quedan} busquedas y la reserva es {RESERVA} — no se mide hoy")
            return
        if len(terminos) > margen:
            # Se miden los que llevan mas tiempo sin medir (order nullsfirst).
            print(f"watched_terms: cuota justa ({quedan} restantes) — se miden {margen} de {len(terminos)}")
            terminos = terminos[:margen]

    hoy = dt.date.today().isoformat()
    ayer = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    medidos = 0

    for t in terminos:
        data = _related(t["term"], t.get("geo") or "")
        err = data.get("error")
        # "hasn't returned any results" es un vacio legitimo, no una falla.
        if err and "hasn't returned any results" not in str(err):
            print(f"  {t['term']!r}: {str(err)[:80]}")
            continue
        top, rising = _extraer(data)
        medidos += 1

        # Lo que hoy esta y ayer no: la alerta.
        previas = _get("watched_term_readings", {
            "select": "rising", "term_id": f"eq.{t['id']}", "medido_el": f"lte.{ayer}",
            "order": "medido_el.desc", "limit": "1"})
        antes = {r.get("termino") for r in ((previas[0].get("rising") or []) if previas else [])}
        nuevas = [r for r in rising if r.get("termino") not in antes] if previas else []

        interes = max([x["interes"] for x in top if x.get("interes") is not None], default=None)
        ok, msg = _post("watched_term_readings", [{
            "term_id": t["id"], "organization_id": t["organization_id"], "medido_el": hoy,
            "interes": interes, "top": top, "rising": rising, "nuevas": nuevas,
        }], on_conflict="term_id,medido_el")
        if not ok:
            print(f"  {t['term']!r}: no se guardo la lectura: {msg}")
            continue
        # veces_medido real = filas en la bitacora, no un contador que se desfasa.
        # Va en el MISMO patch: mandarlo aparte con None fallaba entero contra el
        # not-null y se perdia tambien `ultimo_interes`, en silencio.
        n = _get("watched_term_readings", {"select": "id", "term_id": f"eq.{t['id']}"})
        ok_p, msg_p = _patch("watched_search_terms", {"id": f"eq.{t['id']}"}, {
            "ultima_medicion": dt.datetime.utcnow().isoformat() + "Z",
            "ultimo_interes": interes,
            "veces_medido": len(n),
        })
        if not ok_p:
            print(f"  {t['term']!r}: la lectura se guardo pero el resumen no: {msg_p}")

        aviso = f" | NUEVAS: {[x['termino'] for x in nuevas][:3]}" if nuevas else ""
        print(f"  {t['term']!r}: interes={interes} top={len(top)} rising={len(rising)}{aviso}")

    print(f"watched_terms: {medidos} terminos medidos, cuota restante ~{max(0, quedan - medidos) if quedan >= 0 else '?'}")


if __name__ == "__main__":
    main()
