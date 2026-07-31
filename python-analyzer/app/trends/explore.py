"""
explore.py — Google Trends BAJO DEMANDA, cuando Vera quiere mirar un tema.

DE DONDE SALE. Los colectores semanales (audience_demand, niche_trends) traen la
foto del nicho que YA decidimos vigilar. Pero cuando Vera descubre algo en vivo
—un tema que encendio los comentarios de un competidor, una palabra que se repite
en 300 bios— no tenia forma de preguntarle a Google si eso es una ola real o una
casualidad de una cuenta. Esto es esa pregunta.

NO ES OBLIGATORIO. Es una lente mas, y Vera decide si la usa. Un tema puede ser
valioso sin volumen de busqueda (nadie busca lo que no sabe que existe) y puede
tener volumen sin servirle a la marca. Esto informa el juicio, no lo reemplaza.

LO QUE DE VERDAD ESCASEA NO ES EL DINERO, ES LA CUOTA. SerpApi Free da 250
busquedas al mes y de ahi comen tambien los colectores que llenan el tablero. Por
eso hay una RESERVA: si quedan menos de N, esto se niega para que la curiosidad de
un dia no deje sin datos al tablero de la semana.
"""
import os
import httpx

SERPAPI_KEY = os.environ.get("SERPAPI_KEY", "")
# Colchon para los colectores programados (audience_demand + niche_trends usan
# ~35/mes). Por debajo de esto, la exploracion se niega.
RESERVA = int(os.environ.get("SERPAPI_RESERVA_COLECTORES", "80"))

_URL = "https://serpapi.com/search.json"


def _cuota() -> dict:
    """Cuota REAL leida de SerpApi, no un contador nuestro que puede desfasarse."""
    try:
        with httpx.Client(timeout=20) as cli:
            d = cli.get("https://serpapi.com/account", params={"api_key": SERPAPI_KEY}).json()
        return {
            "quedan": int(d.get("total_searches_left") or 0),
            "limite": int(d.get("searches_per_month") or 0),
            "usadas": int(d.get("this_month_usage") or 0),
        }
    except Exception as e:
        return {"quedan": -1, "error": str(e)[:120]}


def _pedir(params: dict) -> dict:
    with httpx.Client(timeout=60) as cli:
        r = cli.get(_URL, params={**params, "api_key": SERPAPI_KEY})
        try:
            return r.json()
        except Exception:
            return {"error": f"http {r.status_code}"}


def _relacionadas(data: dict) -> tuple:
    """top = volumen relativo 0-100. rising = % de crecimiento ('Breakout' = explota)."""
    rq = (data.get("related_queries") or {})
    top, rising = [], []
    for x in (rq.get("top") or [])[:15]:
        top.append({"termino": x.get("query"), "interes": x.get("extracted_value")})
    for x in (rq.get("rising") or [])[:15]:
        v = x.get("extracted_value")
        # SerpApi codifica "Breakout" como un numero absurdo (~32300): es un
        # termino que paso de casi-cero a algo, no un +32.300% literal.
        etiqueta = "Breakout" if (isinstance(v, (int, float)) and v >= 5000) else (f"+{v}%" if v is not None else None)
        rising.append({"termino": x.get("query"), "crecimiento": etiqueta, "valor": v})
    return top, rising


def _serie(data: dict) -> dict:
    """Interes en el tiempo: es lo que dice si el tema SUBE o ya paso."""
    tl = ((data.get("interest_over_time") or {}).get("timeline_data") or [])
    puntos = []
    for p in tl:
        vals = p.get("values") or []
        v = vals[0].get("extracted_value") if vals else None
        if v is not None:
            puntos.append({"fecha": p.get("date"), "valor": v})
    if len(puntos) < 4:
        return {"puntos": puntos, "lectura": None}
    # Ultimo cuarto contra el primero: basta para separar "sube" de "ya paso".
    n = max(1, len(puntos) // 4)
    ini = sum(p["valor"] for p in puntos[:n]) / n
    fin = sum(p["valor"] for p in puntos[-n:]) / n
    if ini <= 0:
        lectura = "sin base para comparar"
    else:
        cambio = (fin - ini) / ini
        lectura = ("subiendo" if cambio > 0.25 else
                   "cayendo" if cambio < -0.25 else "estable")
    pico = max(puntos, key=lambda p: p["valor"])
    return {
        "puntos": puntos[-26:],           # ~medio año de semanas, suficiente para leer
        "lectura": lectura,
        "pico": pico,
        "ultimo": puntos[-1],
    }


def explorar(q: str, geo: str = "", con_serie: bool = True) -> dict:
    """Explora un termino en Google Trends. 1 llamada sin serie, 2 con serie."""
    if not SERPAPI_KEY:
        raise RuntimeError("SERPAPI_KEY no configurada")
    termino = str(q or "").strip()
    if not termino:
        raise ValueError("falta el termino a explorar")
    # Google Trends no responde a long-tail: 3+ palabras suele volver vacio.
    palabras = len(termino.split())

    c = _cuota()
    necesarias = 2 if con_serie else 1
    if c["quedan"] >= 0 and c["quedan"] - necesarias < RESERVA:
        raise RuntimeError(
            f"[CUOTA] quedan {c['quedan']} busquedas SerpApi este mes y hay que dejar "
            f"{RESERVA} para los colectores que llenan el tablero. NO inventes el dato: "
            f"di que no pudiste consultar la demanda de busqueda de este termino."
        )

    base = {"engine": "google_trends", "q": termino}
    if geo:
        base["geo"] = geo

    rel = _pedir({**base, "data_type": "RELATED_QUERIES"})
    # OJO: SerpApi mete en `error` dos cosas distintas. "hasn't returned any
    # results" es un VACIO legitimo —el termino no tiene volumen— y tratarlo como
    # fallo hacia que la tool reventara justo en el caso mas comun: el long-tail.
    # Solo lo que no es "sin resultados" es una falla de verdad.
    if rel.get("error") and "hasn't returned any results" not in str(rel["error"]):
        raise RuntimeError(f"SerpApi: {rel['error']}")
    top, rising = _relacionadas(rel)

    serie = None
    if con_serie:
        ts = _pedir({**base, "data_type": "TIMESERIES"})
        if not ts.get("error"):
            serie = _serie(ts)

    vacio = not top and not rising and not (serie or {}).get("puntos")
    return {
        "termino": termino,
        "geo": geo or "global",
        "llamadas_gastadas": necesarias,
        "cuota_restante": max(0, c["quedan"] - necesarias) if c["quedan"] >= 0 else None,
        "top": top,
        "rising": rising,
        "serie": serie,
        "sin_datos": vacio,
        "advertencia": (
            "Google Trends no tiene volumen para este termino. Con 3+ palabras casi "
            "siempre vuelve vacio: prueba el nucleo de la categoria, no la frase entera. "
            "Y ojo: que no haya busquedas NO significa que el tema no importe — nadie "
            "busca lo que todavia no sabe que existe."
            if vacio and palabras >= 3 else
            "Sin volumen de busqueda. Eso no lo mata: la busqueda mide demanda que YA "
            "existe, no la que hay que crear."
            if vacio else
            "El interes es RELATIVO (0-100 dentro de este termino), no un numero de "
            "busquedas. Sirve para comparar momentos y terminos entre si, no para "
            "estimar trafico absoluto."
        ),
    }
