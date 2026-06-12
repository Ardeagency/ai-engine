"""Vera Strategist — genera propuestas estratégicas semanales con Claude Opus 4.7.

Pipeline:
  1. Pulla brand_intelligence_context (10 capas vía RPC)
  2. Pasa a Opus con system prompt estratégico
  3. Parsea N propuestas estructuradas
  4. Inserta en strategic_recommendations con batch_id común
  5. Trigerea notification a la org

Uso:
  python vera_strategist.py [--brand-id UUID] [--num-proposals 5] [--regenerate-from REC_ID]
"""
import asyncio
import os
import json
import uuid
import sys
import argparse
from datetime import datetime, timezone
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}

# ──────────────────────────────────────────────────────────────────────────────
# Modelo: Sonnet 4.6 — migrado desde Opus 4.7 el 2026-06-12 (decision usuario:
# carve-out de batch estrategico semanal + 5x mas barato). Si la calidad de las
# propuestas baja notablemente, volver a claude-opus-4-7 y ajustar pricing.
# Pricing: $3/MTok input | $15/MTok output
# ──────────────────────────────────────────────────────────────────────────────
MODEL = "claude-sonnet-4-6"
MAX_OUTPUT_TOKENS = 8000

SYSTEM_PROMPT = """Eres Vera, la estratega creativa principal de la marca.

Tu trabajo es generar propuestas de contenido SEMANALES basadas en el contexto completo de la marca que recibirás. Operas como un Director Creativo senior con acceso a TODA la inteligencia de mercado.

REGLAS NO NEGOCIABLES:
1. Respeta SIEMPRE el `brand_dna.verbal_dna` (tono, estructura_copy, formato — incluyendo si NO usar emojis o exclamaciones)
2. Respeta SIEMPRE el `brand_dna.visual_dna.never` (lo que la marca prohíbe visualmente)
3. NUNCA uses palabras de `brand_dna.palabras_prohibidas`
4. SIEMPRE prioriza `brand_dna.palabras_clave` cuando aplique
5. Cada propuesta debe tener `evidence_chain` con al menos 3 datapoints CITADOS de capas distintas (persona, performance, market, competitor)
6. Predicciones (`predicted_engagement`) deben basarse en el rango histórico de `internal_performance` y `narrative_pillars[avg_engagement]`. NO inventes números.
7. Si `audience.personas[].real_data.alignment_score < 0.5` → menciona explícitamente el gap como insight (oportunidad de re-targeting)
8. Si `owned_media_state.facebook.metrics.engagement_rate = "0.00%"` → considera incluir 1 propuesta para reactivar canal
9. Aprovecha `audience.engagement_heatmap.best_hour/best_day` REAL para `recommended_hour/day`
10. Si hay `market_pulse.emerging_brand_competitors` → considera 1 propuesta de defensa/diferenciación

ESTRUCTURA DE OUTPUT (JSON ESTRICTO, sin markdown):
{
  "proposals": [
    {
      "title": "string corto (max 80 chars)",
      "description": "string 1-2 oraciones explicando el concepto",
      "format": "single_image|carrusel_imgs|reel_baile|long_video|story|reel_meme",
      "tone": "casual|alegre|urgente|motivacional|nostálgico|aspiracional|confrontacional|irónico|humorístico|optimista|directo|provocador|visceral",
      "topic": "lifestyle|tutorial|deportes_extremos|behind_scenes|partnership|ugc_repost|datos_curiosos|testimonial|evento_live|promo_oferta|producto_launch|informativo|educational",
      "mood": "celebratorio|calmo|energético|inspirador|nostálgico|emotivo|intenso",
      "target_persona": "exact name from audience.personas[]",
      "anchor_product_name": "exact name from products[]",
      "campaign_link_name": "exact name from campaigns_active[] o null si no aplica",
      "recommended_hour": <int 0-23>,
      "recommended_day": "monday|tuesday|wednesday|thursday|friday|saturday|sunday",
      "recommended_network": ["instagram"|"x"|"tiktok"|"youtube"|"facebook"],
      "copy_seed": "Titular o primera frase + 1-2 oraciones que sigan el verbal_dna.estructura_copy. Sin emojis si el DNA lo prohibe.",
      "visual_brief": "Descripción concisa del visual sugerido alineado a visual_dna.estetica. Sin elementos prohibidos.",
      "what_to_avoid": ["lista","de","palabras","tonos","o","elementos","prohibidos"],
      "predicted_engagement": <int realista basado en performance histórica>,
      "predicted_reach": <int>,
      "confidence": "alta|media|baja",
      "rationale_commercial": "Una oración explicando POR QUÉ va a funcionar comercialmente — qué intent ataca, qué gap aprovecha, qué métrica mueve",
      "evidence_chain": [
        {"source": "persona|performance|market|competitor|campaign|narrative_pillar|owned_media", "quote": "cita textual o paráfrasis breve del datapoint"}
      ]
    }
  ],
  "weekly_summary": "1-2 oraciones resumiendo el theme estratégico de la semana",
  "alerts": ["alertas críticas detectadas en la data, ej. 'engagement Facebook 0%' o 'persona Director Creativo 36% alignment'"]
}

CALIDAD ESPERADA: cada propuesta debe ser ejecutable directamente por un equipo creativo sin revisión adicional. El brief estratégico debe ser tan claro que el copywriter solo expanda, no reinterprete."""


async def get_brand_context(brand_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/build_full_brand_intelligence_context",
            headers=H, json={"p_brand_container_id": brand_id},
        )
        if r.status_code != 200:
            raise RuntimeError(f"context error {r.status_code}: {r.text[:300]}")
        return r.json()


async def call_opus(system: str, user_msg: str) -> tuple[dict, dict]:
    """Llama Anthropic API. Devuelve (parsed_response, usage_metadata)."""
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": MODEL,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user_msg}],
    }
    async with httpx.AsyncClient(timeout=300) as cli:
        r = await cli.post("https://api.anthropic.com/v1/messages",
                           headers=headers, json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"opus error {r.status_code}: {r.text[:500]}")
        data = r.json()

    text = data["content"][0]["text"]
    # Strip code fences if present
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:].strip()
    parsed = json.loads(text)

    usage = data.get("usage", {})
    return parsed, usage


def calculate_cost(usage: dict) -> float:
    """Sonnet 4.6: $3/MTok input, $15/MTok output"""
    input_tokens = usage.get("input_tokens", 0)
    output_tokens = usage.get("output_tokens", 0)
    return round(
        (input_tokens / 1_000_000 * 3.0) + (output_tokens / 1_000_000 * 15.0),
        4
    )


async def insert_recommendations(
    brand_id: str, org_id: str, batch_id: str, proposals: list,
    context_size_tokens: int, cost_usd: float, iterated_from_id: str | None = None
) -> int:
    rows = []
    for p in proposals:
        rows.append({
            "organization_id": org_id,
            "brand_container_id": brand_id,
            "batch_id": batch_id,
            "vera_model": MODEL,
            "context_size_tokens": context_size_tokens,
            "generation_cost_usd": cost_usd / max(len(proposals), 1),
            "title": p.get("title", "")[:200],
            "description": p.get("description", ""),
            "format": p.get("format"),
            "tone": p.get("tone"),
            "topic": p.get("topic"),
            "mood": p.get("mood"),
            "target_persona": p.get("target_persona"),
            "anchor_product_name": p.get("anchor_product_name"),
            "campaign_link_name": p.get("campaign_link_name"),
            "recommended_hour": p.get("recommended_hour"),
            "recommended_day": p.get("recommended_day"),
            "recommended_network": p.get("recommended_network"),
            "copy_seed": p.get("copy_seed"),
            "visual_brief": p.get("visual_brief"),
            "what_to_avoid": p.get("what_to_avoid"),
            "predicted_engagement": p.get("predicted_engagement"),
            "predicted_reach": p.get("predicted_reach"),
            "confidence": p.get("confidence"),
            "rationale_commercial": p.get("rationale_commercial"),
            "evidence_chain": p.get("evidence_chain"),
            "status": "proposed",
            "iterated_from_id": iterated_from_id,
            "metadata": {"weekly_summary": None},  # populated below
        })

    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/strategic_recommendations",
            headers=H, json=rows,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"insert err {r.status_code}: {r.text[:300]}")
    return len(rows)


async def notify_org_pending(org_id: str, brand_id: str, count: int, batch_id: str):
    """Crea org_notification para los miembros."""
    payload = [{
        "organization_id": org_id,
        "brand_container_id": brand_id,
        "type": "strategic_recommendations",
        "severity": "opportunity",
        "title": f"Vera generó {count} nuevas propuestas estratégicas",
        "body": f"Esta semana Vera analizó tu data + mercado + competencia y propone {count} acciones priorizadas. Revísalas y aprueba las que quieras ejecutar.",
        "action_url": f"/dashboard/strategy/{brand_id}",
        "action_label": "Revisar propuestas",
        "metadata": {"batch_id": batch_id, "count": count},
    }]
    async with httpx.AsyncClient(timeout=15) as cli:
        await cli.post(f"{SUPABASE_URL}/rest/v1/org_notifications",
                       headers=H, json=payload)


async def generate_for_brand(brand_id: str, num_proposals: int = 5) -> dict:
    started = datetime.now(timezone.utc)
    print(f"[vera-strategist] start brand={brand_id} model={MODEL}", flush=True)

    # 1. Context
    print("  fetching brand intelligence context...", flush=True)
    ctx = await get_brand_context(brand_id)
    if "error" in ctx:
        raise RuntimeError(f"context error: {ctx}")
    org_id = ctx["meta"]["organization_id"]
    brand_name = ctx.get("brand_dna", {}).get("name", "?")
    print(f"  brand: {brand_name} | org: {org_id}", flush=True)

    # 2. Estimate context size
    ctx_str = json.dumps(ctx, ensure_ascii=False)
    ctx_tokens_estimate = len(ctx_str) // 4  # ~4 chars/token
    print(f"  context: {len(ctx_str)} chars (~{ctx_tokens_estimate} tokens)", flush=True)

    # 3. Build user message
    user_msg = f"""Aquí está el contexto completo de **{brand_name}**:

```json
{ctx_str}
```

Genera {num_proposals} propuestas estratégicas para esta semana siguiendo el formato JSON estricto definido. Cada propuesta debe tener evidencia cruzada de al menos 3 capas distintas del contexto."""

    # 4. Call Opus
    print(f"  calling Opus 4.7...", flush=True)
    parsed, usage = await call_opus(SYSTEM_PROMPT, user_msg)
    cost = calculate_cost(usage)
    proposals = parsed.get("proposals", [])
    weekly_summary = parsed.get("weekly_summary", "")
    alerts = parsed.get("alerts", [])
    print(f"  opus returned {len(proposals)} proposals | usage={usage} | cost=${cost}", flush=True)
    if alerts:
        print(f"  alerts: {alerts}", flush=True)

    # 5. Insert
    batch_id = str(uuid.uuid4())
    inserted = await insert_recommendations(
        brand_id, org_id, batch_id, proposals,
        usage.get("input_tokens", 0), cost,
    )
    print(f"  inserted {inserted} recommendations | batch={batch_id}", flush=True)

    # 6. Notify org
    if inserted > 0:
        await notify_org_pending(org_id, brand_id, inserted, batch_id)
        print(f"  notification sent to org {org_id}", flush=True)

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print(f"[vera-strategist] done in {elapsed:.1f}s", flush=True)

    return {
        "brand_id": brand_id, "batch_id": batch_id,
        "proposals_generated": inserted, "cost_usd": cost,
        "weekly_summary": weekly_summary, "alerts": alerts,
    }



async def get_recommendation(rec_id: str) -> dict | None:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/strategic_recommendations",
            headers=H, params={"id": f"eq.{rec_id}", "select": "*"},
        )
        rows = r.json() if r.status_code == 200 else []
        return rows[0] if rows else None


async def regenerate_with_feedback(rec_id: str) -> dict:
    """Iteración: humano dio feedback → genera UNA nueva propuesta."""
    started = datetime.now(timezone.utc)
    print(f"[vera-regenerate] start rec={rec_id}", flush=True)

    original = await get_recommendation(rec_id)
    if not original:
        raise RuntimeError("recommendation not found")
    if original["status"] != "iterated":
        raise RuntimeError(f"rec status invalid, must be iterated to regenerate")

    feedback = original.get("iteration_feedback") or "(sin feedback específico)"
    brand_id = original["brand_container_id"]
    org_id = original["organization_id"]

    # Get fresh context
    ctx = await get_brand_context(brand_id)
    brand_name = ctx.get("brand_dna", {}).get("name", "?")
    ctx_str = json.dumps(ctx, ensure_ascii=False)

    # User message: contexto + propuesta anterior + feedback (variables pre-extraídas para evitar backslashes en f-strings)
    o_title = original.get("title", "")
    o_desc = original.get("description", "")
    o_fmt = original.get("format", "")
    o_tone = original.get("tone", "")
    o_topic = original.get("topic", "")
    o_persona = original.get("target_persona", "")
    o_product = original.get("anchor_product_name", "")
    o_copy = original.get("copy_seed", "")

    user_msg = (
        f"Aquí está el contexto completo de **{brand_name}**:\n\n"
        f"```json\n{ctx_str}\n```\n\n"
        "PROPUESTA ANTERIOR que el humano marcó para iterar:\n"
        f"- Título: {o_title}\n"
        f"- Descripción: {o_desc}\n"
        f"- Format/Tone/Topic: {o_fmt} / {o_tone} / {o_topic}\n"
        f"- Persona: {o_persona}\n"
        f"- Producto: {o_product}\n"
        f"- Copy seed: {o_copy}\n\n"
        "FEEDBACK DEL HUMANO:\n"
        f'"""{feedback}"""\n\n'
        "Genera UNA SOLA propuesta nueva que incorpore el feedback. "
        'Mantén formato JSON estricto con array "proposals" de 1 elemento.'
    )

    parsed, usage = await call_opus(SYSTEM_PROMPT, user_msg)
    cost = calculate_cost(usage)
    proposals = parsed.get("proposals", [])
    if not proposals:
        raise RuntimeError("opus returned 0 proposals")

    batch_id = original["batch_id"]  # mantener el mismo batch
    inserted = await insert_recommendations(
        brand_id, org_id, batch_id, proposals,
        usage.get("input_tokens", 0), cost,
        iterated_from_id=rec_id,
    )

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print(f"[vera-regenerate] done in {elapsed:.1f}s | cost=${cost}", flush=True)

    return {
        "iterated_from_id": rec_id,
        "new_proposals": inserted,
        "cost_usd": cost,
        "feedback_applied": feedback,
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand-id", help="UUID de brand_container (si vacío, todos)")
    parser.add_argument("--num-proposals", type=int, default=5)
    args = parser.parse_args()

    if args.brand_id:
        result = await generate_for_brand(args.brand_id, args.num_proposals)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        # Todas las marcas activas
        async with httpx.AsyncClient(timeout=15) as cli:
            r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                              headers=H, params={"select": "id,nombre_marca"})
            brands = r.json() if r.status_code == 200 else []
        for b in brands:
            try:
                await generate_for_brand(b["id"], args.num_proposals)
            except Exception as e:
                print(f"  ERR brand {b.get('nombre_marca')}: {e}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
