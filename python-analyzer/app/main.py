"""FastAPI server — endpoints actualizados con análisis de media."""
import os
import time
from dotenv import load_dotenv

load_dotenv("/root/ai-engine/.env")
load_dotenv()

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from .analyzer import analyze_post
from .persistence import fetch_post, fetch_pending, update_post
from .tasks.media_helpers import extract_image_urls, already_described
from .tasks.media_orchestrator import describe_media

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json", "Prefer": "return=representation"}

app = FastAPI(title="ai-engine python-analyzer", version="2.0.0")
_started_at = time.time()
_models_loaded = False


class AnalyzeTextReq(BaseModel):
    content: str
    metrics: dict | None = None
    follower_count: int | None = None

class AnalyzeOneReq(BaseModel):
    post_id: str

class AnalyzeBatchReq(BaseModel):
    post_ids: list[str]

class AnalyzePendingReq(BaseModel):
    limit: int = 50

class AnalyzeMediaReq(BaseModel):
    limit: int = 20


@app.get("/health")
def health():
    return {"status": "ok", "uptime_sec": int(time.time() - _started_at), "models_loaded": _models_loaded, "version": "2.0.0"}


@app.post("/analyze/text")
def analyze_text(req: AnalyzeTextReq):
    return analyze_post(req.content, req.metrics, req.follower_count)


@app.post("/analyze/post")
async def analyze_one(req: AnalyzeOneReq):
    post = await fetch_post(req.post_id)
    if not post:
        raise HTTPException(404, f"post {req.post_id} not found")
    analysis = analyze_post(post["content"] or "", post.get("metrics"), post.get("followers_snapshot"))
    if "error" in analysis:
        raise HTTPException(400, analysis["error"])
    await update_post(req.post_id, analysis)
    return {"post_id": req.post_id, "ok": True, "summary": {
        "lang": analysis["language"], "sentiment": analysis["sentiment"]["label"],
        "score": analysis["sentiment"]["score"], "dominant_emotion": analysis["emotion"]["dominant"],
        "topics": [t["kw"] for t in analysis["topics"]],
        "impact": analysis["impact"]["impact_score"], "risk": analysis["risk"]["level"],
    }}


@app.post("/analyze/batch")
async def analyze_batch(req: AnalyzeBatchReq):
    results = {"ok": [], "errors": []}
    for pid in req.post_ids:
        try:
            post = await fetch_post(pid)
            if not post:
                results["errors"].append({"post_id": pid, "error": "not_found"})
                continue
            analysis = analyze_post(post["content"] or "", post.get("metrics"), post.get("followers_snapshot"))
            if "error" in analysis:
                results["errors"].append({"post_id": pid, "error": analysis["error"]})
                continue
            await update_post(pid, analysis)
            results["ok"].append(pid)
        except Exception as e:
            results["errors"].append({"post_id": pid, "error": str(e)[:200]})
    return {"processed": len(results["ok"]), "errors": len(results["errors"]), **results}


@app.post("/analyze/pending")
async def analyze_pending(req: AnalyzePendingReq):
    pending = await fetch_pending(req.limit)
    if not pending:
        return {"processed": 0, "message": "no pending posts"}
    pids = [p["id"] for p in pending]
    return await analyze_batch(AnalyzeBatchReq(post_ids=pids))


# ── NUEVO: análisis de media (imágenes) ──────────────────────────────────────
async def _fetch_media_pending(limit: int):
    """brand_posts con media URL pero sin descripción ni error de extracción ya marcado."""
    async with httpx.AsyncClient(timeout=15) as cli:
        # Pedimos más de los necesarios y filtramos en Python (jsonb keys filter en REST es limitado)
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=H,
            params={
                "select": "id,network,content,media_assets,brand_container_id",
                "media_assets": "not.is.null",
                "order": "engagement_total.desc.nullslast,captured_at.desc",
                "limit": str(min(limit * 30, 500)),  # buffer alto para filtrado client-side
            },
        )
        r.raise_for_status()
        eligible = []
        for p in r.json():
            ma = p.get("media_assets")
            # Skip si ya descrito o ya marcado con error
            if already_described(ma):
                continue
            if isinstance(ma, dict) and ma.get("image_extraction_error"):
                continue
            eligible.append(p)
            if len(eligible) >= limit:
                break
        return eligible


async def _mark_extraction_error(post_id: str, media_assets, reason: str):
    """Marca el post para que _fetch_media_pending no lo re-devuelva."""
    if isinstance(media_assets, list):
        # Convertir a dict-wrapped para poder añadir el flag
        new_ma = {"_legacy_array": media_assets, "image_extraction_error": reason}
    elif isinstance(media_assets, dict):
        new_ma = dict(media_assets)
        new_ma["image_extraction_error"] = reason
    else:
        new_ma = {"image_extraction_error": reason}
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.patch(f"{SUPABASE_URL}/rest/v1/brand_posts",
                        headers=H, params={"id": f"eq.{post_id}"},
                        json={"media_assets": new_ma})


async def _get_org_id_for_brand(brand_id: str) -> str | None:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                          headers=H, params={"id": f"eq.{brand_id}", "select": "organization_id"})
        rows = r.json() if r.status_code == 200 else []
        return rows[0]["organization_id"] if rows else None


async def _persist_media_description(post_id: str, media_assets: dict, descriptions: list[dict]):
    """Merge descriptions into media_assets jsonb + summary en enrichment."""
    new_media_assets = dict(media_assets)
    new_media_assets["descriptions"] = descriptions
    summary_lines = [d.get("description", "") for d in descriptions if d.get("description")]
    new_media_assets["description"] = " | ".join(summary_lines)[:2000]
    payload = {"media_assets": new_media_assets, "updated_at": "now()"}
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.patch(f"{SUPABASE_URL}/rest/v1/brand_posts",
                            headers=H, params={"id": f"eq.{post_id}"}, json=payload)
        if r.status_code >= 400:
            raise RuntimeError(f"update {r.status_code}: {r.text[:200]}")


@app.post("/analyze/media-pending")
async def analyze_media_pending(req: AnalyzeMediaReq):
    """Procesa hasta N posts con media (imagen/carrusel) sin descripción."""
    pending = await _fetch_media_pending(req.limit)
    if not pending:
        return {"processed": 0, "message": "no media pending"}

    results = {"ok": [], "errors": [], "total_usd": 0.0, "total_credits": 0.0, "cache_hits": 0}
    for p in pending:
        try:
            urls, kind = extract_image_urls(p.get("media_assets"), p["network"])
            if kind == "none":
                # Marca persistente para no reintentar
                await _mark_extraction_error(p["id"], p.get("media_assets"), "no_image_urls")
                results["errors"].append({"post_id": p["id"], "error": "no_image_urls"})
                continue
            org_id = await _get_org_id_for_brand(p["brand_container_id"])
            if kind == "image":
                r = describe_media(urls[0], "image", org_id)
            else:
                r = describe_media("|||".join(urls), "carousel", org_id)

            if "error" in r:
                # Marca persistentemente los errors recuperables (URL muerta, video, etc.)
                err_short = r["error"][:120]
                await _mark_extraction_error(p["id"], p.get("media_assets"), f"describe_failed:{err_short}")
                results["errors"].append({"post_id": p["id"], "error": err_short})
                continue

            await _persist_media_description(p["id"], p.get("media_assets") or {}, [{
                "kind": kind, "model": r.get("model"), "description": r.get("description"),
                "url": urls[0] if kind == "image" else None,
                "url_count": len(urls) if kind == "carousel" else 1,
                "tokens_in": r.get("tokens_in"), "tokens_out": r.get("tokens_out"),
                "usd_cost": r.get("usd_cost", 0), "cached": r.get("cached", False),
            }])
            results["ok"].append({"post_id": p["id"], "kind": kind, "cached": r.get("cached", False), "cost": r.get("usd_cost", 0)})
            results["total_usd"] += r.get("usd_cost", 0) or 0
            if r.get("cached"):
                results["cache_hits"] += 1
        except Exception as e:
            results["errors"].append({"post_id": p["id"], "error": str(e)[:200]})

    results["total_credits"] = round(results["total_usd"] * 10, 4)
    results["total_usd"] = round(results["total_usd"], 5)
    results["processed"] = len(results["ok"])
    return results




# ── Comments analysis (pysentimiento sobre brand_post_comments) ──────────────
class CommentsPendingReq(BaseModel):
    limit: int = 200


async def _fetch_comments_pending(limit: int):
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_post_comments",
            headers=H,
            params={
                "is_processed": "is.false",
                "select": "id,content,brand_post_id,network",
                "order": "created_at.desc",
                "limit": str(limit),
            },
        )
        r.raise_for_status()
        return r.json()


async def _update_comment(comment_id: str, sentiment_label: str, sentiment_score: float, emotion: str):
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.patch(
            f"{SUPABASE_URL}/rest/v1/brand_post_comments",
            headers=H,
            params={"id": f"eq.{comment_id}"},
            json={
                "sentiment": sentiment_label,
                "sentiment_score": sentiment_score,
                "emotion": emotion,
                "is_processed": True,
            },
        )


@app.post("/comments/analyze-pending")
async def comments_analyze_pending(req: CommentsPendingReq):
    pending = await _fetch_comments_pending(req.limit)
    if not pending:
        return {"processed": 0, "message": "no pending comments"}

    from .tasks.sentiment import analyze_sentiment, detect_lang
    from .tasks.emotion import analyze_emotion

    ok = 0
    errs = []
    for c in pending:
        try:
            content = c.get("content") or ""
            if len(content.strip()) < 2:
                # marcar como procesado con neutral default (no romper loop)
                await _update_comment(c["id"], "NEU", 0.0, "others")
                ok += 1
                continue
            lang = detect_lang(content)
            sent = analyze_sentiment(content, lang)
            emo = analyze_emotion(content, lang if lang in ("es", "en") else "en")
            await _update_comment(c["id"], sent["label"], sent["score"], emo["dominant"])
            ok += 1
        except Exception as e:
            errs.append({"id": c["id"], "error": str(e)[:200]})
    return {"processed": ok, "errors": len(errs), "error_samples": errs[:3]}




# ── PATTERN MINING (F1) ──────────────────────────────────────────────────────
class PatternsBatchReq(BaseModel):
    limit: int = 100


async def _fetch_posts_for_patterns(limit: int):
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=H,
            params={
                "select": "id,brand_container_id,network,content,metrics,engagement_total,followers_snapshot,sentiment_score,sentiment,enrichment,media_assets,is_competitor,captured_at,updated_at",
                "ai_analyzed_at": "not.is.null",
                "sentiment_score": "not.is.null",
                # ORDER por updated_at (cuándo se persistió/analizó), no captured_at
                # (fecha del post original). Con captured_at, los posts scrapeados
                # hoy de hace años quedan al fondo y nunca se procesan.
                "order": "updated_at.desc",
                # 5x para sobrevivir al filtro de duplicados (los más recientes ya
                # están en post_patterns).
                "limit": str(limit * 5),
            },
        )
        r.raise_for_status()
        # filtrar los que no estén ya en post_patterns
        posts = r.json()
        if not posts: return []
        ids = ",".join(p["id"] for p in posts)
        r2 = await cli.get(
            f"{SUPABASE_URL}/rest/v1/post_patterns",
            headers=H,
            params={"brand_post_id": f"in.({ids})", "select": "brand_post_id"},
        )
        already = set(x["brand_post_id"] for x in (r2.json() if r2.status_code == 200 else []))
        return [p for p in posts if p["id"] not in already][:limit]


async def _get_org_id_for_brand(brand_id: str):
    if not brand_id: return None
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                          headers=H, params={"id": f"eq.{brand_id}", "select": "organization_id"})
        rows = r.json() if r.status_code == 200 else []
        return rows[0]["organization_id"] if rows else None


async def _insert_pattern(post_row: dict, pattern: dict):
    org_id = await _get_org_id_for_brand(post_row.get("brand_container_id"))
    payload = {
        "brand_post_id": post_row["id"],
        "brand_container_id": post_row.get("brand_container_id"),
        "organization_id": org_id,
        "is_competitor": bool(post_row.get("is_competitor", True)),
        "network": post_row.get("network"),
        "tone": pattern["tone"],
        "topic": pattern["topic"],
        "format": pattern["format"],
        "mood": pattern["mood"],
        "tone_confidence": pattern["tone_confidence"],
        "topic_confidence": pattern["topic_confidence"],
        "engagement_total": pattern["engagement_total"],
        "engagement_rate": pattern["engagement_rate"],
        "sentiment_score": pattern["sentiment_score"],
        "impact_score": pattern["impact_score"],
        "reach": pattern["reach"],
        "followers_at_capture": pattern["followers_at_capture"],
        "posted_at": post_row.get("captured_at"),
        "classifier_version": "v1",
    }
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/post_patterns",
            headers={**H, "Prefer": "resolution=merge-duplicates"},
            json=payload,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"insert pattern: {r.status_code} {r.text[:200]}")


@app.post("/patterns/classify-pending")
async def patterns_classify_pending(req: PatternsBatchReq):
    posts = await _fetch_posts_for_patterns(req.limit)
    if not posts:
        return {"processed": 0, "message": "no pending patterns"}

    from .tasks.pattern_classifier import classify_post
    ok = 0
    errs = []
    for p in posts:
        try:
            pattern = classify_post(p)
            await _insert_pattern(p, pattern)
            ok += 1
        except Exception as e:
            errs.append({"id": p["id"], "error": str(e)[:200]})
    return {"processed": ok, "errors": len(errs), "error_samples": errs[:3]}


@app.get("/patterns/sample/{post_id}")
async def patterns_sample(post_id: str):
    """Debug: clasifica un post sin insertar."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_posts",
            headers=H,
            params={"id": f"eq.{post_id}", "select": "*"},
        )
        rows = r.json()
        if not rows: raise HTTPException(404, "not found")
    from .tasks.pattern_classifier import classify_post
    return classify_post(rows[0])




# ── F3 — DAILY BRIEF ─────────────────────────────────────────────────────────
class GenerateBriefReq(BaseModel):
    brand_container_id: str
    date: str | None = None  # ISO date YYYY-MM-DD; default today


async def _fetch_brief_data(brand_id: str, target_date: str | None):
    body = {"target_brand_id": brand_id}
    if target_date:
        body["target_date"] = target_date
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/brief_aggregate",
            headers=H, json=body,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


async def _fetch_brand_name(brand_id: str) -> str:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                          headers=H, params={"id": f"eq.{brand_id}", "select": "nombre_marca"})
        rows = r.json() if r.status_code == 200 else []
        return rows[0].get("nombre_marca") if rows else "Tu Marca"


async def _fetch_brand_org(brand_id: str) -> str | None:
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers",
                          headers=H, params={"id": f"eq.{brand_id}", "select": "organization_id"})
        rows = r.json() if r.status_code == 200 else []
        return rows[0].get("organization_id") if rows else None


async def _save_brief(brand_id: str, org_id: str, brief_date: str, markdown: str, data: dict, metrics: dict):
    payload = {
        "brand_container_id": brand_id, "organization_id": org_id,
        "brief_date": brief_date, "markdown": markdown,
        "data": data, "metrics": metrics, "generator_version": "v1",
    }
    async with httpx.AsyncClient(timeout=15) as cli:
        await cli.post(
            f"{SUPABASE_URL}/rest/v1/daily_briefs?on_conflict=brand_container_id,brief_date",
            headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=payload,
        )


@app.post("/brief/daily")
async def generate_daily_brief(req: GenerateBriefReq):
    """Genera (o regenera) el brief de un brand para una fecha."""
    from datetime import date
    target_date = req.date or date.today().isoformat()
    org_id = await _fetch_brand_org(req.brand_container_id)
    if not org_id:
        raise HTTPException(404, "brand not found")
    brand_name = await _fetch_brand_name(req.brand_container_id)

    data = await _fetch_brief_data(req.brand_container_id, target_date)
    if not data:
        raise HTTPException(500, "brief_aggregate returned empty")

    from .tasks.daily_brief import render_brief_markdown, compute_metrics_summary
    markdown = render_brief_markdown(data, brand_name=brand_name)
    metrics = compute_metrics_summary(data)

    await _save_brief(req.brand_container_id, org_id, target_date, markdown, data, metrics)

    return {
        "brand_container_id": req.brand_container_id,
        "date": target_date,
        "metrics": metrics,
        "markdown_preview": markdown[:500],
        "markdown_full_chars": len(markdown),
    }


@app.get("/brief/daily/{brand_id}/markdown")
async def get_brief_markdown(brand_id: str, date: str | None = None):
    """Retorna el markdown puro (text/markdown). Genera si no existe."""
    from fastapi.responses import PlainTextResponse
    from datetime import date as date_cls
    target_date = date or date_cls.today().isoformat()

    # Intenta leer cache
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/daily_briefs",
            headers=H,
            params={
                "brand_container_id": f"eq.{brand_id}",
                "brief_date": f"eq.{target_date}",
                "select": "markdown,generated_at",
            },
        )
        rows = r.json() if r.status_code == 200 else []
        if rows and rows[0].get("markdown"):
            return PlainTextResponse(rows[0]["markdown"], media_type="text/markdown; charset=utf-8")

    # No cached — generar
    org_id = await _fetch_brand_org(brand_id)
    if not org_id:
        raise HTTPException(404, "brand not found")
    brand_name = await _fetch_brand_name(brand_id)
    data = await _fetch_brief_data(brand_id, target_date)
    from .tasks.daily_brief import render_brief_markdown, compute_metrics_summary
    markdown = render_brief_markdown(data, brand_name=brand_name)
    metrics = compute_metrics_summary(data)
    await _save_brief(brand_id, org_id, target_date, markdown, data, metrics)
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8")




# ── F5.a — WEEKLY STRATEGY MEMO ──────────────────────────────────────────────
class GenerateMemoReq(BaseModel):
    brand_container_id: str
    week_start: str | None = None  # YYYY-MM-DD del lunes; default = lunes actual


async def _fetch_memo_data(brand_id: str, week_start: str | None):
    body = {"target_brand_id": brand_id}
    if week_start:
        body["target_week_start"] = week_start
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/weekly_memo_aggregate",
            headers=H, json=body,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


async def _save_memo(brand_id: str, org_id: str, week_start: str, week_end: str, markdown: str, data: dict, metrics: dict):
    async with httpx.AsyncClient(timeout=15) as cli:
        await cli.post(
            f"{SUPABASE_URL}/rest/v1/weekly_memos",
            headers={**H, "Prefer": "resolution=merge-duplicates"},
            json={
                "brand_container_id": brand_id, "organization_id": org_id,
                "week_start": week_start, "week_end": week_end,
                "markdown": markdown, "data": data, "metrics": metrics,
                "generator_version": "v1",
            },
        )


@app.post("/memo/weekly")
async def generate_weekly_memo(req: GenerateMemoReq):
    from datetime import date, timedelta
    if req.week_start:
        week_start = req.week_start
    else:
        today = date.today()
        week_start = (today - timedelta(days=today.weekday())).isoformat()  # lunes actual

    org_id = await _fetch_brand_org(req.brand_container_id)
    if not org_id: raise HTTPException(404, "brand not found")
    brand_name = await _fetch_brand_name(req.brand_container_id)

    data = await _fetch_memo_data(req.brand_container_id, week_start)
    if not data: raise HTTPException(500, "weekly_memo_aggregate returned empty")

    from .tasks.weekly_memo import render_weekly_memo, compute_memo_metrics
    markdown = render_weekly_memo(data, brand_name=brand_name)
    metrics = compute_memo_metrics(data)
    week_end = data.get("week_end") or week_start

    await _save_memo(req.brand_container_id, org_id, week_start, week_end, markdown, data, metrics)

    return {
        "brand_container_id": req.brand_container_id,
        "week_start": week_start, "week_end": week_end,
        "metrics": metrics,
        "markdown_preview": markdown[:600],
        "markdown_full_chars": len(markdown),
    }


@app.get("/memo/weekly/{brand_id}/markdown")
async def get_weekly_memo_md(brand_id: str, week_start: str | None = None):
    from fastapi.responses import PlainTextResponse
    from datetime import date, timedelta
    if not week_start:
        today = date.today()
        week_start = (today - timedelta(days=today.weekday())).isoformat()

    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/weekly_memos",
            headers=H,
            params={
                "brand_container_id": f"eq.{brand_id}",
                "week_start": f"eq.{week_start}",
                "select": "markdown,generated_at",
            },
        )
        rows = r.json() if r.status_code == 200 else []
        if rows and rows[0].get("markdown"):
            return PlainTextResponse(rows[0]["markdown"], media_type="text/markdown; charset=utf-8")

    # Generar
    org_id = await _fetch_brand_org(brand_id)
    if not org_id: raise HTTPException(404, "brand not found")
    brand_name = await _fetch_brand_name(brand_id)
    data = await _fetch_memo_data(brand_id, week_start)
    from .tasks.weekly_memo import render_weekly_memo, compute_memo_metrics
    markdown = render_weekly_memo(data, brand_name=brand_name)
    metrics = compute_memo_metrics(data)
    week_end = data.get("week_end") or week_start
    await _save_memo(brand_id, org_id, week_start, week_end, markdown, data, metrics)
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8")




# ── F5.b — CREATOR BRIEF GENERATOR ───────────────────────────────────────────
class CreatorBriefReq(BaseModel):
    brand_container_id: str
    recommendation_index: int = 0  # cuál de las top recos usar (default top 1)


async def _fetch_brand_data(brand_id: str):
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/brand_containers",
            headers=H,
            params={"id": f"eq.{brand_id}", "select": "id,nombre_marca,nicho_core,sub_nichos,mercado_objetivo,verbal_dna,arquetipo,palabras_clave,palabras_prohibidas"},
        )
        rows = r.json() if r.status_code == 200 else []
        return rows[0] if rows else None


async def _fetch_top_recommendations(brand_id: str, limit: int = 5):
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/cross_brand_recommendations",
            headers=H, json={"target_brand_id": brand_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        recos = r.json() or []
        return recos[:limit]


@app.post("/brief/creator")
async def generate_creator_brief(req: CreatorBriefReq):
    brand_data = await _fetch_brand_data(req.brand_container_id)
    if not brand_data:
        raise HTTPException(404, "brand not found")
    recos = await _fetch_top_recommendations(req.brand_container_id, limit=10)
    if not recos:
        raise HTTPException(404, "no recommendations available — clasifica posts primero")
    if req.recommendation_index >= len(recos):
        raise HTTPException(400, f"recommendation_index {req.recommendation_index} fuera de rango (max {len(recos)-1})")
    reco = recos[req.recommendation_index]

    from .tasks.creator_brief import render_creator_brief
    brand_name = brand_data.get("nombre_marca") or "Tu Marca"
    markdown = render_creator_brief(reco, brand_data, brand_name=brand_name)

    return {
        "brand_container_id": req.brand_container_id,
        "recommendation": reco,
        "markdown_full_chars": len(markdown),
        "markdown": markdown,
    }


@app.get("/brief/creator/{brand_id}/markdown")
async def get_creator_brief_md(brand_id: str, index: int = 0):
    from fastapi.responses import PlainTextResponse
    brand_data = await _fetch_brand_data(brand_id)
    if not brand_data: raise HTTPException(404, "brand not found")
    recos = await _fetch_top_recommendations(brand_id, limit=10)
    if not recos or index >= len(recos):
        raise HTTPException(404, "reco no disponible")
    reco = recos[index]
    from .tasks.creator_brief import render_creator_brief
    brand_name = brand_data.get("nombre_marca") or "Tu Marca"
    markdown = render_creator_brief(reco, brand_data, brand_name=brand_name)
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8")




# ── F6 — DELIVERY LAYER ──────────────────────────────────────────────────────
class CreateChannelReq(BaseModel):
    organization_id: str
    brand_container_id: str | None = None
    channel_type: str  # slack|email|webhook|notion
    name: str
    config: dict
    events: list[str] | None = None


class TestChannelReq(BaseModel):
    channel_id: str


class DispatchEventReq(BaseModel):
    brand_container_id: str
    event_type: str  # daily_brief|weekly_memo|crisis_alert
    content_override: dict | None = None  # opcional override de markdown


async def _list_active_channels(org_id: str, brand_id: str | None, event_type: str):
    """Devuelve channels activos para org+brand+event_type."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/delivery_channels",
            headers=H,
            params={
                "organization_id": f"eq.{org_id}",
                "is_active": "is.true",
                "select": "*",
            },
        )
        rows = r.json() if r.status_code == 200 else []
    # Filtrar por brand (NULL = aplica todos los brands de la org)
    rows = [c for c in rows if c.get("brand_container_id") in (None, brand_id)]
    # Filtrar por event_type (lista en c.events)
    rows = [c for c in rows if event_type in (c.get("events") or [])]
    return rows


async def _log_delivery(channel_id: str, brand_id: str | None, event_type: str, result: dict):
    payload = {
        "channel_id": channel_id, "brand_container_id": brand_id,
        "event_type": event_type, "status": "sent" if result.get("ok") else "failed",
        "payload_size_bytes": result.get("payload_size_bytes"),
        "http_status": result.get("http_status"),
        "error": result.get("error"),
    }
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.post(f"{SUPABASE_URL}/rest/v1/delivery_events", headers=H, json=payload)


async def _update_channel_last_sent(channel_id: str):
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.patch(
            f"{SUPABASE_URL}/rest/v1/delivery_channels",
            headers=H, params={"id": f"eq.{channel_id}"},
            json={"last_sent_at": "now()"},
        )


async def _fetch_event_content(brand_id: str, event_type: str) -> dict:
    """Obtiene markdown del evento desde la tabla apropiada."""
    if event_type == "daily_brief":
        from datetime import date
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.get(
                f"{SUPABASE_URL}/rest/v1/daily_briefs",
                headers=H,
                params={
                    "brand_container_id": f"eq.{brand_id}",
                    "brief_date": f"eq.{date.today().isoformat()}",
                    "select": "markdown,metrics,data",
                    "order": "generated_at.desc", "limit": "1",
                },
            )
            rows = r.json() if r.status_code == 200 else []
            if rows:
                bn = await _fetch_brand_name(brand_id)
                return {
                    "title": f"📊 Daily Brief — {bn}",
                    "markdown": rows[0]["markdown"],
                    "payload_json": {"metrics": rows[0]["metrics"], "data": rows[0]["data"]},
                }
        return {"title": "Daily Brief", "markdown": "(no brief generado hoy)", "payload_json": {}}

    if event_type == "weekly_memo":
        from datetime import date, timedelta
        today = date.today()
        week_start = (today - timedelta(days=today.weekday())).isoformat()
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.get(
                f"{SUPABASE_URL}/rest/v1/weekly_memos",
                headers=H,
                params={
                    "brand_container_id": f"eq.{brand_id}",
                    "week_start": f"eq.{week_start}",
                    "select": "markdown,metrics,data",
                    "order": "generated_at.desc", "limit": "1",
                },
            )
            rows = r.json() if r.status_code == 200 else []
            if rows:
                bn = await _fetch_brand_name(brand_id)
                return {
                    "title": f"📈 Weekly Strategy Memo — {bn}",
                    "markdown": rows[0]["markdown"],
                    "payload_json": {"metrics": rows[0]["metrics"]},
                }
        return {"title": "Weekly Memo", "markdown": "(no memo generado esta semana)", "payload_json": {}}

    if event_type == "crisis_alert":
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.post(
                f"{SUPABASE_URL}/rest/v1/rpc/compute_crisis_risk",
                headers=H, json={"target_brand_id": brand_id},
            )
            data = r.json() if r.status_code == 200 else {}
        sev = data.get("severity", "low")
        bn = await _fetch_brand_name(brand_id)
        if sev == "low":
            return {"title": f"✅ {bn} — sin crisis", "markdown": "Crisis Risk: low. Sin acción requerida.", "payload_json": data}
        emoji = {"medium": "🟡", "high": "⚠️", "critical": "🚨"}.get(sev, "⚠️")
        factors = data.get("factors", {})
        active = [f"- **{k}**: {v}" for k, v in factors.items() if isinstance(v, (int, float)) and v > 0]
        md = f"# {emoji} CRISIS {sev.upper()} — {bn}\n\n**Score:** {data.get('crisis_score')}\n\n## Factores activos\n" + "\n".join(active) if active else f"# {emoji} CRISIS {sev.upper()} — {bn}\n\nScore: {data.get('crisis_score')}"
        return {"title": f"{emoji} CRISIS {sev.upper()} — {bn}", "markdown": md, "payload_json": data}

    return {"title": event_type, "markdown": "(unknown event_type)", "payload_json": {}}


@app.post("/delivery/channels")
async def create_channel(req: CreateChannelReq):
    payload = {
        "organization_id": req.organization_id,
        "brand_container_id": req.brand_container_id,
        "channel_type": req.channel_type,
        "name": req.name,
        "config": req.config,
        "events": req.events or ["daily_brief", "weekly_memo", "crisis_alert"],
        "is_active": True,
    }
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/delivery_channels",
            headers={**H, "Prefer": "return=representation"}, json=payload,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()[0] if r.json() else payload


@app.post("/delivery/test")
async def test_channel(req: TestChannelReq):
    """Envía un mensaje de prueba a un canal."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(f"{SUPABASE_URL}/rest/v1/delivery_channels",
                          headers=H, params={"id": f"eq.{req.channel_id}", "select": "*"})
        rows = r.json() if r.status_code == 200 else []
        if not rows: raise HTTPException(404, "channel not found")
    ch = rows[0]
    from .tasks.delivery import dispatch
    test_md = f"# 🧪 Test Delivery\n\nCanal: **{ch['name']}** ({ch['channel_type']})\n\nSi recibes esto, la integración funciona correctamente."
    result = dispatch(ch["channel_type"], ch["config"], "test", {"title": "🧪 Test AI Smart Content", "markdown": test_md, "payload_json": {"test": True}})
    await _log_delivery(req.channel_id, ch.get("brand_container_id"), "test", result)
    return result


@app.post("/delivery/dispatch")
async def dispatch_event(req: DispatchEventReq):
    """Envía un evento a TODOS los canales activos del brand."""
    org_id = await _fetch_brand_org(req.brand_container_id)
    if not org_id: raise HTTPException(404, "brand not found")
    channels = await _list_active_channels(org_id, req.brand_container_id, req.event_type)
    if not channels:
        return {"sent": 0, "message": f"no active channels for event_type={req.event_type}"}

    content = req.content_override or await _fetch_event_content(req.brand_container_id, req.event_type)
    from .tasks.delivery import dispatch

    results = {"sent": 0, "failed": 0, "details": []}
    for ch in channels:
        result = dispatch(ch["channel_type"], ch["config"], req.event_type, content)
        await _log_delivery(ch["id"], req.brand_container_id, req.event_type, result)
        if result.get("ok"):
            await _update_channel_last_sent(ch["id"])
            results["sent"] += 1
        else:
            results["failed"] += 1
        results["details"].append({"channel_id": ch["id"], "channel_name": ch["name"], "channel_type": ch["channel_type"], "ok": result.get("ok"), "error": result.get("error")})
    return results




# ── F7 — AUTO-LEARNING SYSTEM ────────────────────────────────────────────────
class ApproveDiscoveryReq(BaseModel):
    discovery_id: str
    discovery_type: str  # vocabulary | pattern
    new_dimension_value: str | None = None  # opcional: cambiar el suggested_value
    notes: str | None = None


class MarkApplicationReq(BaseModel):
    brand_container_id: str
    network: str
    tone: str
    topic: str
    format: str
    brand_post_id: str | None = None
    expected_lift: float | None = None
    competitor_avg_engagement: float | None = None


@app.post("/learning/discover")
async def run_discovery():
    """Trigger manual: descubre vocabulario + patrones nuevos + mide outcomes pending."""
    async with httpx.AsyncClient(timeout=30) as cli:
        r1 = await cli.post(f"{SUPABASE_URL}/rest/v1/rpc/discover_vocabulary",
                            headers=H, json={})
        r2 = await cli.post(f"{SUPABASE_URL}/rest/v1/rpc/discover_emerging_patterns",
                            headers=H, json={})
        r3 = await cli.post(f"{SUPABASE_URL}/rest/v1/rpc/measure_pending_outcomes",
                            headers=H, json={})
    return {
        "vocabulary": r1.json() if r1.status_code == 200 else r1.text,
        "patterns": r2.json() if r2.status_code == 200 else r2.text,
        "outcomes": r3.json() if r3.status_code == 200 else r3.text,
    }


@app.post("/learning/curate-sentiment")
async def curate_sentiment():
    """Camino FRIO: el LLM cura el lexico de sentimiento (jerga regional, emojis,
    sarcasmo) en learned_vocabulary. Lo dispara el cron semanal."""
    from .tasks.sentiment_curator import run_curation
    try:
        return await run_curation()
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/learning/discoveries/vocabulary")
async def list_vocabulary_discoveries(status: str = "pending", limit: int = 50):
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/learned_vocabulary",
            headers=H,
            params={"status": f"eq.{status}", "select": "*",
                    "order": "frequency.desc,avg_engagement_rate.desc",
                    "limit": str(limit)},
        )
        return r.json() if r.status_code == 200 else []


@app.get("/learning/discoveries/patterns")
async def list_pattern_discoveries(status: str = "pending"):
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/emerging_patterns",
            headers=H,
            params={"status": f"eq.{status}", "select": "*",
                    "order": "signal_strength.desc"},
        )
        return r.json() if r.status_code == 200 else []


@app.post("/learning/approve")
async def approve_discovery(req: ApproveDiscoveryReq):
    """Aprueba un descubrimiento → status='active' y queda disponible para classifier."""
    table = "learned_vocabulary" if req.discovery_type == "vocabulary" else "emerging_patterns"
    update = {
        "status": "active" if req.discovery_type == "vocabulary" else "approved",
        "approved_at": "now()",
    }
    if req.discovery_type == "vocabulary" and req.new_dimension_value:
        update["suggested_value"] = req.new_dimension_value
    if req.notes:
        update["notes" if req.discovery_type == "vocabulary" else "proposed_definition"] = req.notes

    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.patch(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={**H, "Prefer": "return=representation"},
            params={"id": f"eq.{req.discovery_id}"}, json=update,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()[0] if r.json() else {"ok": True}


@app.post("/learning/reject")
async def reject_discovery(req: ApproveDiscoveryReq):
    table = "learned_vocabulary" if req.discovery_type == "vocabulary" else "emerging_patterns"
    payload = {"status": "rejected"}
    if req.discovery_type == "vocabulary" and req.notes:
        payload["rejected_reason"] = req.notes
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.patch(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=H, params={"id": f"eq.{req.discovery_id}"}, json=payload,
        )
    return {"ok": True}


@app.post("/learning/mark-applied")
async def mark_recommendation_applied(req: MarkApplicationReq):
    """Cliente marca que aplicó una recomendación. Outcome se mide en 7d."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/mark_recommendation_applied",
            headers=H,
            json={
                "target_brand_id": req.brand_container_id,
                "reco_network": req.network,
                "reco_tone": req.tone,
                "reco_topic": req.topic,
                "reco_format": req.format,
                "applied_brand_post_id": req.brand_post_id,
                "expected_lift_val": req.expected_lift,
                "competitor_eng": req.competitor_avg_engagement,
            },
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return {"ok": True, "application_id": r.json()}


@app.get("/learning/outcomes/{brand_id}")
async def list_outcomes(brand_id: str, limit: int = 20):
    """Histórico de recomendaciones aplicadas y sus outcomes medidos."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/recommendation_applications",
            headers=H,
            params={"brand_container_id": f"eq.{brand_id}", "select": "*",
                    "order": "applied_at.desc", "limit": str(limit)},
        )
        return r.json() if r.status_code == 200 else []




# ── INTELLIGENCE ENTITIES — multi-platform provisioning ──────────────────────
class AddMultiPlatformReq(BaseModel):
    organization_id: str
    brand_container_id: str
    base_handle: str  # "@redbull" o "redbull"
    name: str
    tipo: str = "competidor_directo"  # competidor_directo|competidor_indirecto|referencia_cultural|owned_media
    platforms: list[str] | None = None  # default: todas las redes activas
    handle_overrides: dict[str, str] = {}  # {"youtube":"redbullmotor"}


class DeactivateEntityReq(BaseModel):
    entity_id: str


_VERIFY_UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
}


async def _verify_youtube_handle(handle: str) -> bool:
    """YouTube devuelve 404 limpio para handles inexistentes. Verificación gratis."""
    h = handle.lstrip("@")
    url = f"https://www.youtube.com/@{h}"
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=_VERIFY_UA) as cli:
            r = await cli.head(url)
            if r.status_code == 404:
                return False
            if r.status_code in (200, 301, 302, 307, 308):
                return True
            # Otros códigos (rate-limit, etc.) → asumir que existe (mejor falso positivo que falso negativo)
            return True
    except Exception:
        return True  # Network error → asumir que existe, dejar que auto-deactivate decida


@app.post("/intelligence/add-multi-platform")
async def add_multi_platform_entity(req: AddMultiPlatformReq):
    """Crea N entities (1 por red) desde 1 handle. Triggers se auto-provisionan.

    Pre-validation: solo YouTube (HEAD 404 funciona). Para IG/X/TikTok/FB
    se confía en auto-deactivate inmediato (1 strike) tras primer scrape vacío.
    """
    platforms = req.platforms or ["instagram","x","tiktok","youtube","facebook"]
    overrides = dict(req.handle_overrides or {})
    not_found = []

    # YouTube pre-check (gratis, vía HEAD)
    if "youtube" in platforms:
        yt_handle = overrides.get("youtube") or req.base_handle
        if not await _verify_youtube_handle(yt_handle):
            platforms = [p for p in platforms if p != "youtube"]
            not_found.append({"platform":"youtube","handle":yt_handle,"reason":"yt_404_pre_check"})

    payload = {
        "p_org_id": req.organization_id,
        "p_brand_container_id": req.brand_container_id,
        "p_base_handle": req.base_handle,
        "p_name": req.name,
        "p_tipo": req.tipo,
        "p_platforms": platforms,
        "p_handle_overrides": overrides,
    }
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/provision_multi_platform_entity",
            headers=H, json=payload,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        result = r.json() or {}

    result["pre_check_rejected"] = not_found
    result["note"] = (
        "Pre-check solo aplica a YouTube. Resto de plataformas se desactivan "
        "automáticamente tras primer scrape vacío (~$0.03 por handle inexistente)."
    )
    return result


@app.post("/intelligence/reactivate-entity")
async def reactivate_entity(req: DeactivateEntityReq):
    """Reactiva una entity auto-deactivada (limpia counters + reactiva trigger)."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/reactivate_entity",
            headers=H, json={"p_entity_id": req.entity_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.get("/intelligence/brand-groups/{brand_container_id}")
async def list_brand_groups(brand_container_id: str):
    """Lista entities agrupadas por brand_group (handle base) con su estado por plataforma."""
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(
            f"{SUPABASE_URL}/rest/v1/intelligence_entities",
            headers=H,
            params={
                "brand_container_id": f"eq.{brand_container_id}",
                "select": "id,name,target_identifier,is_active,metadata",
                "order": "metadata->brand_group,metadata->platform",
            },
        )
        rows = r.json() if r.status_code == 200 else []

    groups: dict = {}
    for row in rows:
        meta = row.get("metadata") or {}
        bg = meta.get("brand_group") or "unknown"
        groups.setdefault(bg, {"brand_group": bg, "tipo": meta.get("tipo"), "platforms": []})
        groups[bg]["platforms"].append({
            "entity_id": row["id"],
            "platform": meta.get("platform"),
            "handle": row["target_identifier"],
            "is_active": row["is_active"],
            "consecutive_empty_runs": meta.get("consecutive_empty_runs", 0),
            "auto_deactivated_at": meta.get("auto_deactivated_at"),
        })
    return list(groups.values())


@app.post("/intelligence/deactivate-entity")
async def deactivate_entity(req: DeactivateEntityReq):
    """Marca entity inactiva manualmente y pausa su trigger."""
    async with httpx.AsyncClient(timeout=10) as cli:
        await cli.patch(
            f"{SUPABASE_URL}/rest/v1/intelligence_entities",
            headers=H, params={"id": f"eq.{req.entity_id}"},
            json={"is_active": False},
        )
        await cli.patch(
            f"{SUPABASE_URL}/rest/v1/monitoring_triggers",
            headers=H, params={"entity_id": f"eq.{req.entity_id}"},
            json={"status": "paused"},
        )
    return {"ok": True, "entity_id": req.entity_id}




# ── NOTIFICATIONS ────────────────────────────────────────────────────────────
class NotificationActionReq(BaseModel):
    notification_id: str


@app.get("/notifications/me")
async def list_my_notifications(org_id: str | None = None, state: str = "unread", limit: int = 30, x_user_id: str | None = None):
    """Lista notificaciones de la(s) org(s) del usuario con SU propio estado de lectura.

    state: 'unread' (default) | 'read' | 'actioned' | 'all'
    org_id: filtra a una org específica (NULL = todas las orgs del user)

    NOTA: la BD usa auth.uid() — el frontend debe pasar el JWT en Authorization header.
    """
    payload = {"p_state": state, "p_limit": limit}
    if org_id: payload["p_org_id"] = org_id
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/list_my_org_notifications",
            headers=H, json=payload,
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.get("/notifications/me/unread-count")
async def my_unread_count(org_id: str | None = None):
    payload = {}
    if org_id: payload["p_org_id"] = org_id
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/my_unread_org_notifications_count",
            headers=H, json=payload,
        )
        return {"unread_count": r.json() if r.status_code == 200 else 0}


@app.post("/notifications/mark")
async def mark_notification_state(req: NotificationActionReq, state: str = "read"):
    """Marca notificación con estado per-usuario.
    state: 'read' | 'actioned' | 'dismissed' | 'unread'
    """
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/mark_org_notification_state",
            headers=H, json={"p_notification_id": req.notification_id, "p_state": state},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()




# ── TRENDS ENGINE ────────────────────────────────────────────────────────────
@app.post("/trends/run/{brand_container_id}")
async def trends_run_cycle(brand_container_id: str, mock: bool = True,
                            max_queries: int | None = None):
    """Ciclo end-to-end del trends engine. mock=true usa stubs;
    mock=false ejecuta collectors+scorer+brief_generator reales.
    max_queries cap-ea para smoke tests baratos."""
    from .trends.orchestrator import run_cycle
    try:
        return await run_cycle(brand_container_id, mock=mock,
                                 max_queries=max_queries)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    except Exception as e:
        raise HTTPException(500, f"trends.run_cycle error: {str(e)[:300]}")


@app.post("/trends/test-queries/{brand_container_id}")
async def trends_test_queries(brand_container_id: str, sample_size: int = 10):
    """Fase 2 — corre query_generator y devuelve stats + sample (sin persistir)."""
    from .trends.query_generator import generate_queries
    from collections import Counter
    try:
        queries = await generate_queries(brand_container_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"query_generator error: {str(e)[:300]}")

    by_origin = Counter(q.keyword_origin for q in queries)
    by_geo = Counter(q.geo for q in queries)
    sample = [
        {"keyword": q.keyword, "origin": q.keyword_origin,
         "geo": q.geo, "language": q.language, "priority": q.priority,
         "target_apis": q.target_apis,
         "source_entity_id": str(q.source_entity_id) if q.source_entity_id else None}
        for q in sorted(queries, key=lambda x: x.priority, reverse=True)[:sample_size]
    ]
    return {
        "ok": True,
        "total": len(queries),
        "by_origin": dict(by_origin),
        "by_geo": dict(by_geo),
        "sample": sample,
    }




# ── DASHBOARD 4: STRATEGIC RECOMMENDATIONS (Vera Strategist) ────────────────
class SynthesizeReq(BaseModel):
    brand_id: str
    num_proposals: int = 5

class IterateReq(BaseModel):
    rec_id: str
    feedback: str

class RegenerateReq(BaseModel):
    rec_id: str

class RejectReq(BaseModel):
    rec_id: str
    reason: str | None = None

class ApproveReq(BaseModel):
    rec_id: str

class MarkPublishedReq(BaseModel):
    rec_id: str
    brand_post_id: str


@app.post("/strategy/synthesize")
async def strategy_synthesize(req: SynthesizeReq):
    """Trigger Vera para generar batch de propuestas estratégicas."""
    from .vera_strategist import generate_for_brand
    try:
        result = await generate_for_brand(req.brand_id, req.num_proposals)
        return result
    except Exception as e:
        raise HTTPException(500, f"vera-strategist error: {str(e)[:300]}")


@app.post("/strategy/regenerate")
async def strategy_regenerate(req: RegenerateReq):
    """Regenerar propuesta iterada (humano dio feedback en /strategy/iterate)."""
    from .vera_strategist import regenerate_with_feedback
    try:
        result = await regenerate_with_feedback(req.rec_id)
        return result
    except Exception as e:
        raise HTTPException(500, f"vera-regenerate error: {str(e)[:300]}")


@app.post("/strategy/approve")
async def strategy_approve(req: ApproveReq):
    """Aprobar recomendación → pasa a estado approved (humano puede luego producir)."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/approve_strategic_recommendation",
            headers=H, json={"p_rec_id": req.rec_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.post("/strategy/reject")
async def strategy_reject(req: RejectReq):
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/reject_strategic_recommendation",
            headers=H,
            json={"p_rec_id": req.rec_id, "p_reason": req.reason},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.post("/strategy/iterate")
async def strategy_iterate(req: IterateReq):
    """Humano marca propuesta para iterar + da feedback. Para regenerar
    automáticamente, llama luego a /strategy/regenerate con el mismo rec_id."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/iterate_strategic_recommendation",
            headers=H,
            json={"p_rec_id": req.rec_id, "p_feedback": req.feedback},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.post("/strategy/mark-published")
async def strategy_mark_published(req: MarkPublishedReq):
    """Marca una recomendación aprobada como publicada (link a brand_post real).
    Esto inicia el countdown para outcome measurement (7 días)."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/mark_recommendation_published",
            headers=H,
            json={"p_rec_id": req.rec_id, "p_brand_post_id": req.brand_post_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.get("/strategy/recommendations/{brand_id}")
async def strategy_list(brand_id: str, status: str = "pending"):
    """Lista recomendaciones de la marca.
    status: pending | approved | rejected | iterated | published | measured | all"""
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/dashboard_strategic_recommendations",
            headers=H,
            json={"p_brand_container_id": brand_id, "p_status": status},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.get("/strategy/learning-stats/{brand_id}")
async def strategy_stats(brand_id: str):
    """Métricas: approval rate, prediction error, learning signals breakdown."""
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/recommendation_learning_stats",
            headers=H, json={"p_brand_container_id": brand_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.get("/strategy/context/{brand_id}")
async def strategy_context_preview(brand_id: str):
    """Devuelve el brand_intelligence_context (los 10 capas) para debug/preview."""
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/build_full_brand_intelligence_context",
            headers=H, json={"p_brand_container_id": brand_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()




@app.get("/strategy/dashboard/{brand_id}")
async def strategy_dashboard_master(brand_id: str):
    """Master aggregator del Dashboard 4 — todo en un endpoint."""
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(
            f"{SUPABASE_URL}/rest/v1/rpc/dashboard_strategy_master",
            headers=H, json={"p_brand_container_id": brand_id},
        )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:300])
        return r.json()


@app.on_event("startup")
def warmup():
    global _models_loaded
    print("[startup] cargando modelos…")
    from .analyzer import analyze_post
    res = analyze_post("Hello world! 🚀", metrics={"likes": 10, "comments": 1})
    print(f"[startup] modelos OK — lang={res.get('language')} sent={res.get('sentiment',{}).get('label')}")
    _models_loaded = True
