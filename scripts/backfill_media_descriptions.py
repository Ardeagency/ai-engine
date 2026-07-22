"""Backfill de descripciones de media para posts propios ya capturados.

Usa el MISMO describer del pipeline (image_describer + media_orchestrator.cache_save)
para que las descripciones sean comparables con las que ya existen. NO cobra
creditos a la organizacion: es deuda tecnica nuestra (el capturador no describio
en su momento), no consumo nuevo del cliente.
"""
import json, sys, os
sys.path.insert(0, "/root/ai-engine/python-analyzer")
from app.tasks.image_describer import describe_image, url_hash
from app.tasks.media_orchestrator import cache_lookup, cache_save

ORG = "e2477719-d65e-422a-a5aa-3473d6536060"
items = json.load(open(sys.argv[1]))
limite = int(sys.argv[2]) if len(sys.argv) > 2 else len(items)

ok = fail = skip = 0
usd = 0.0
for i, it in enumerate(items[:limite], 1):
    url = it["url"]
    uh = url_hash(url)
    if cache_lookup(uh):
        skip += 1
        continue
    try:
        res = describe_image(url)
        # describe_image no lanza: devuelve {"error": ...} cuando la URL murio o
        # Anthropic rechazo. Sin este guard, cache_save escribia basura.
        if res.get("error") or not res.get("description"):
            fail += 1
            print(f"[{i}/{limite}] SKIP {res.get('error','sin descripcion')[:110]} | {url[:70]}", flush=True)
            continue
        cache_save(uh, url, "image", res, ORG)
        usd += float(res.get("usd_cost") or 0)
        ok += 1
        print(f"[{i}/{limite}] OK   {url[:90]}", flush=True)
    except Exception as e:
        fail += 1
        print(f"[{i}/{limite}] FAIL {type(e).__name__}: {str(e)[:110]} | {url[:70]}", flush=True)

print(f"\nRESUMEN descritas={ok} fallidas={fail} ya_estaban={skip} usd={usd:.3f}")
