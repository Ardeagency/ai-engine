import asyncio
from app.brand_search_context import (
    fetch_brand_context, compose_seed_buckets, is_prohibited, score_relevance
)

async def main():
    bid = "a3000000-0000-0000-0000-000000000001"
    ctx = await fetch_brand_context(bid)
    if not ctx:
        print("CONTEXT NONE")
        return
    n = ctx['marca_name']
    print(f"marca: {n}")
    print(f"products: {len(ctx['products'])}, services: {len(ctx['services'])}, personas: {len(ctx['personas'])}")
    proh = ctx['palabras_prohibidas']
    print(f"prohibidas: {proh}")
    cntries = ctx['countries']
    print(f"countries: {cntries}")
    tones = ctx['social_top_tones']
    topics = ctx['social_top_topics']
    print(f"social_top_tones: {tones}")
    print(f"social_top_topics: {topics}")
    print()
    print("═══ BUCKETS ═══")
    buckets = compose_seed_buckets(ctx)
    for name, items in buckets.items():
        print(f"\n  [{name}] ({len(items)} seeds)")
        for it in items[:5]:
            seed = it['seed']
            src = it['source']
            print(f"    - {seed:<45} ({src})")
    print()
    print("═══ FILTRO + SCORING ═══")
    test_texts = [
        "Energía nuclear en Europa, más allá del mito",
        "Bebida energetica para refrescar el dia",
        "Activación creativa para creadores de contenido",
        "La fiesta de los amigos al divertirse en celebración",
        "Sistema de activación para sprints de producción",
    ]
    for t in test_texts:
        prh = is_prohibited(t, ctx)
        sc = score_relevance(t, ctx) if not prh else 0
        flag = "PROHIBIDA" if prh else f"score {sc:.2f}"
        short = t[:80]
        print(f"  [{flag:<10}] {short}")

asyncio.run(main())
