"""Reanaliza la media PROPIA con el prompt de marca (catalogo + tema).

La media descrita con el prompt generico no dice que producto aparece; esta
pasada la vuelve a analizar una sola vez. El endpoint decide si toca o no
(salta lo que ya tiene la firma marca-v1), asi que es reejecutable.
"""
import os, sys, time, json, httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
BC = sys.argv[1]
LIMITE = int(sys.argv[2]) if len(sys.argv) > 2 else 500

with httpx.Client(timeout=30) as cli:
    r = cli.get(f"{SUPABASE_URL}/rest/v1/brand_posts", headers=H, params={
        "brand_container_id": f"eq.{BC}", "post_source": "eq.own",
        "select": "id,media_assets", "limit": 1000, "order": "captured_at.desc",
    })
    posts = r.json()

pend = [p for p in posts
        if isinstance(p.get("media_assets"), dict)
        and p["media_assets"].get("description")
        and p["media_assets"].get("analysis_tag") != "marca-v1"][:LIMITE]
print(f"{len(pend)} publicaciones por reanalizar", flush=True)

ok = err = 0
with httpx.Client(timeout=180) as cli:
    for i, p in enumerate(pend, 1):
        try:
            res = cli.post("http://127.0.0.1:8001/analyze/media-post", json={"post_id": p["id"]}).json()
            if res.get("ok"): ok += 1
            else: err += 1
            if i % 20 == 0: print(f"  {i}/{len(pend)} ok={ok} err={err}", flush=True)
        except Exception as e:
            err += 1
            print(f"  [{i}] FAIL {type(e).__name__}: {str(e)[:90]}", flush=True)
print(f"RESUMEN reanalizadas={ok} fallidas={err}")
