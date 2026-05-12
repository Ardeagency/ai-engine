"""Brief generator — única llamada LLM del pipeline (Fase 5).

Convierte top-K señales rankeadas en briefs accionables con Claude Sonnet 4.6.
Persiste en strategic_recommendations (mismo schema que vera_strategist),
crea org_notifications severity='opportunity', registra credit_usage
kind='vera_brief_generation'.

Ref: blueprint sec. 11.
"""
from __future__ import annotations
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import httpx

from .models import ScoredSignal, TrendBrief

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

H_SB = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}
H_ANTHROPIC = {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}

log = logging.getLogger(__name__)

MODEL = os.environ.get("TRENDS_BRIEF_MODEL", "claude-sonnet-4-6")
VERA_MODEL_TAG = "trend-engine-sonnet-4-6"
MAX_OUTPUT_TOKENS = 6000
# Sonnet 4.6: $3/MTok input, $15/MTok output
COST_INPUT_PER_1K = 0.003
COST_OUTPUT_PER_1K = 0.015

SYSTEM_PROMPT = """Eres el estratega de tendencias de la marca. Recibes señales rankeadas
del último ciclo del trends engine (con sub-scores y metadata) y debes producir
briefs ACCIONABLES tipo Director Creativo.

REGLAS:
1. Cada brief se basa en 1-3 señales — cita signal_id en evidence_chain.
2. Respeta brand.palabras_prohibidas (NUNCA usar). Prioriza brand.palabras_clave.
3. Si la señal es signal_intent='risk_brand'|'risk_competitor', el brief es defensivo.
4. recommended_action: una de ['activa esto ya', 'reserva presupuesto', 'cambia plan trimestre'].
5. time_window: 'esta_semana' (urgente, <7d), '30d', '60d', 'trimestre'.
6. confidence: 'alta'|'media'|'baja' según concordancia entre evidencias.
7. NO inventes números. Si predicted_* no se puede inferir, omítelo.

OUTPUT (JSON estricto, sin markdown):
{
  "briefs": [
    {
      "title": "máximo 80 chars, accionable",
      "description": "1-2 oraciones, qué + por qué",
      "signal_intent": "content_opportunity|audience_insight|competitor_move|market_data|risk_brand|risk_category|risk_competitor",
      "recommended_action": "activa esto ya|reserva presupuesto|cambia plan trimestre",
      "time_window": "esta_semana|30d|60d|trimestre",
      "confidence": "alta|media|baja",
      "evidence_chain": [
        {"signal_id": "<uuid>", "source": "...", "quote": "fragmento de la señal"},
        ...
      ],
      "rationale_commercial": "una oración: por qué mueve la aguja comercialmente",
      "anchor_product_name": "string o null",
      "campaign_link_name": "string o null",
      "target_persona": "string o null",
      "recommended_network": ["instagram"|"tiktok"|"x"|"facebook"|"youtube"],
      "copy_seed": "primera frase del copy, alineada al verbal_dna",
      "visual_brief": "descripción concisa del visual",
      "what_to_avoid": ["string"]
    }
  ]
}
"""


async def _fetch_brand(brand_container_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_containers",
            headers=H_SB,
            params={"id": f"eq.{brand_container_id}",
                    "select": ("id,organization_id,nombre_marca,nicho_core,sub_nichos,"
                               "palabras_clave,palabras_prohibidas,mercado_objetivo,"
                               "idiomas_contenido"),
                    "limit": 1},
        )
        r.raise_for_status()
        rows = r.json()
    if not rows:
        raise ValueError(f"brand_container {brand_container_id} not found")
    return rows[0]


def _build_user_prompt(brand: dict, scored: list[ScoredSignal]) -> str:
    lines = ["## Contexto de marca",
             json.dumps({
                 "nombre_marca": brand.get("nombre_marca"),
                 "nicho_core": brand.get("nicho_core"),
                 "sub_nichos": brand.get("sub_nichos") or [],
                 "palabras_clave": brand.get("palabras_clave") or [],
                 "palabras_prohibidas": brand.get("palabras_prohibidas") or [],
                 "mercado_objetivo": brand.get("mercado_objetivo") or [],
                 "idiomas_contenido": brand.get("idiomas_contenido") or [],
             }, ensure_ascii=False, indent=2),
             "",
             "## Señales rankeadas (top-K del ciclo, ordenadas por final_score desc)",
             ""]
    for i, s in enumerate(scored, 1):
        md = s.metadata or {}
        lines.append(json.dumps({
            "rank": i,
            "signal_id": str(s.signal_id),
            "intent": s.signal_intent,
            "source": s.source,
            "geo": md.get("geo"),
            "text": s.text,
            "scores": {
                "final": s.final_score,
                "semantic": s.semantic_relevance,
                "volume": s.volume_score,
                "growth": s.growth_score,
                "freshness": s.freshness_score,
                "commercial": s.commercial_score,
            },
            "url": (md.get("raw_payload") or {}).get("url"),
        }, ensure_ascii=False))
    lines.append("")
    lines.append("Genera entre 3 y 6 briefs cubriendo distintos signal_intent. "
                 "Output JSON estricto siguiendo el schema del system prompt.")
    return "\n".join(lines)


async def _call_claude(system: str, user: str) -> tuple[str, dict[str, Any]]:
    body = {
        "model": MODEL,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.post(ANTHROPIC_URL, headers=H_ANTHROPIC, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"Anthropic API error {r.status_code}: {r.text[:300]}")
    data = r.json()
    content_blocks = data.get("content") or []
    text = "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
    usage = data.get("usage") or {}
    return text, usage


def _parse_briefs(raw: str) -> list[dict[str, Any]]:
    """Tolerante a code-fences y prefijos."""
    s = raw.strip()
    if s.startswith("```"):
        # quita fences
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    # busca primer { y último }
    a = s.find("{")
    b = s.rfind("}")
    if a < 0 or b < 0:
        raise ValueError("no JSON object in Claude output")
    obj = json.loads(s[a:b + 1])
    return obj.get("briefs") or []


def _to_trend_brief(b: dict) -> TrendBrief:
    return TrendBrief(
        title=(b.get("title") or "")[:120],
        description=b.get("description") or "",
        signal_intent=b.get("signal_intent") or "content_opportunity",
        recommended_action=b.get("recommended_action") or "reserva presupuesto",
        time_window=b.get("time_window") or "30d",
        confidence=b.get("confidence") or "media",
        evidence_chain=b.get("evidence_chain") or [],
        rationale_commercial=b.get("rationale_commercial") or "",
        anchor_product_name=b.get("anchor_product_name"),
        campaign_link_name=b.get("campaign_link_name"),
        target_persona=b.get("target_persona"),
        recommended_network=(b.get("recommended_network") or [None])[0]
            if isinstance(b.get("recommended_network"), list)
            else b.get("recommended_network"),
        copy_seed=b.get("copy_seed"),
        visual_brief=b.get("visual_brief"),
        what_to_avoid=b.get("what_to_avoid") or [],
    )


async def _persist_briefs(briefs: list[dict[str, Any]], brand: dict,
                            batch_id: str, generation_cost_usd: float) -> list[str]:
    if not briefs:
        return []
    rows = []
    for b in briefs:
        net = b.get("recommended_network") or []
        if isinstance(net, str):
            net = [net]
        rows.append({
            "id": str(uuid4()),
            "organization_id": brand["organization_id"],
            "brand_container_id": brand["id"],
            "batch_id": batch_id,
            "vera_model": VERA_MODEL_TAG,
            "generation_cost_usd": generation_cost_usd,
            "title": (b.get("title") or "")[:200],
            "description": b.get("description"),
            "format": None,
            "tone": None,
            "topic": b.get("signal_intent"),
            "mood": None,
            "target_persona": b.get("target_persona"),
            "anchor_product_name": b.get("anchor_product_name"),
            "campaign_link_name": b.get("campaign_link_name"),
            "recommended_hour": None,
            "recommended_day": None,
            "recommended_network": net,
            "copy_seed": b.get("copy_seed"),
            "visual_brief": b.get("visual_brief"),
            "what_to_avoid": b.get("what_to_avoid") or [],
            "confidence": b.get("confidence"),
            "rationale_commercial": b.get("rationale_commercial"),
            "evidence_chain": b.get("evidence_chain") or [],
            "status": "proposed",
            "metadata": {
                "source_pipeline": "trends_engine",
                "recommended_action": b.get("recommended_action"),
                "time_window": b.get("time_window"),
                "signal_intent": b.get("signal_intent"),
            },
        })
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/strategic_recommendations",
            headers={**H_SB, "Prefer": "return=representation"},
            json=rows,
        )
    if r.status_code >= 400:
        log.warning("persist briefs failed status=%d body=%s",
                    r.status_code, r.text[:300])
        return []
    return [row["id"] for row in r.json() if row.get("id")]


async def _create_notification(brand: dict, brief_count: int, batch_id: str) -> None:
    if brief_count <= 0:
        return
    body = {
        "organization_id": brand["organization_id"],
        "brand_container_id": brand["id"],
        "type": "trend_brief",
        "severity": "opportunity",
        "title": f"{brief_count} oportunidades de tendencia detectadas",
        "body": f"El motor de tendencias generó {brief_count} briefs accionables. "
                f"Revísalos en el dashboard de recomendaciones.",
        "action_url": f"/dashboard/recommendations?batch={batch_id}",
        "action_label": "Ver briefs",
        "status": "unread",
        "metadata": {"batch_id": batch_id, "source": "trends_engine"},
    }
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            await cli.post(f"{SUPABASE_URL}/rest/v1/org_notifications",
                           headers=H_SB, json=body)
    except Exception as e:
        log.warning("notification insert failed: %s", e)


async def _record_cost(organization_id: str, usd_cost: float,
                        usage: dict[str, Any], batch_id: str) -> None:
    if usd_cost <= 0:
        return
    body = {
        "id": str(uuid4()),
        "organization_id": organization_id,
        "kind": "vera_brief_generation",
        "credits_delta": -float(usd_cost),
        "usd_cost": float(usd_cost),
        "source_table": "strategic_recommendations",
        "source_id": batch_id,
        "metadata": {
            "model": MODEL,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "pipeline": "trends_engine",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=8) as cli:
            await cli.post(f"{SUPABASE_URL}/rest/v1/credit_usage",
                           headers=H_SB, json=body)
    except Exception as e:
        log.warning("brief_generator credit_usage failed: %s", e)


async def generate_briefs(scored: list[ScoredSignal], brand_container_id: str,
                           batch_id: str | None = None) -> list[TrendBrief]:
    """LLM single-call. Persiste briefs + notification + costo. Devuelve TrendBriefs."""
    if not scored:
        return []
    if not ANTHROPIC_API_KEY:
        log.warning("ANTHROPIC_API_KEY not set, skipping brief generation")
        return []

    brand = await _fetch_brand(brand_container_id)
    user_prompt = _build_user_prompt(brand, scored)

    raw, usage = await _call_claude(SYSTEM_PROMPT, user_prompt)
    in_tok = int(usage.get("input_tokens") or 0)
    out_tok = int(usage.get("output_tokens") or 0)
    cost_usd = (in_tok / 1000.0) * COST_INPUT_PER_1K + (out_tok / 1000.0) * COST_OUTPUT_PER_1K

    try:
        briefs_raw = _parse_briefs(raw)
    except Exception as e:
        log.warning("brief parse failed err=%s preview=%s", e, raw[:300])
        briefs_raw = []

    bid = batch_id or str(uuid4())
    inserted_ids = await _persist_briefs(briefs_raw, brand, bid, cost_usd)
    if inserted_ids:
        await _create_notification(brand, len(inserted_ids), bid)
    await _record_cost(brand["organization_id"], cost_usd, usage, bid)

    log.info("brief_generator: scored_in=%d briefs=%d cost_usd=%.4f tokens(in/out)=%d/%d",
             len(scored), len(briefs_raw), cost_usd, in_tok, out_tok)
    return [_to_trend_brief(b) for b in briefs_raw]
