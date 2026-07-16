"""Reclasifica TODO el backlog de brand_posts con el clasificador LLM (llm-v3).

- Idempotente/RESUMIBLE: salta los que ya estan en post_patterns con
  classifier_version='llm-v3'. Si el proceso se corta, re-ejecutar continua.
- Conserva la matematica determinista (classify_post) y reemplaza solo
  tono/tema/mood/sentimiento por el LLM + sentimiento de audiencia de comentarios.
- Loguea progreso y hace pausas para no saturar OpenAI/Anthropic.

Uso:  .venv/bin/python reclassify_llm.py [max_posts]
"""
import os
import sys
import time
import httpx
from dotenv import load_dotenv

load_dotenv()

from app.tasks.llm_classifier import classify_batch, CHUNK
from app.tasks.pattern_classifier import classify_post

U = os.environ["SUPABASE_URL"]
K = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}

SELECT = ("id,brand_container_id,network,content,metrics,engagement_total,"
          "followers_snapshot,sentiment_score,sentiment,enrichment,media_assets,"
          "is_competitor,captured_at")


def fetch_all_eligible():
    posts, offset, PAGE = [], 0, 500
    with httpx.Client(timeout=40) as cli:
        while True:
            r = cli.get(f"{U}/rest/v1/brand_posts", headers=H, params={
                "select": SELECT,
                "ai_analyzed_at": "not.is.null",
                "sentiment_score": "not.is.null",
                "order": "updated_at.desc",
                "offset": str(offset), "limit": str(PAGE),
            })
            b = r.json() if r.status_code == 200 else []
            if not b:
                break
            posts.extend(b)
            offset += PAGE
            if len(b) < PAGE:
                break
    return posts


def already_llm(ids):
    done = set()
    with httpx.Client(timeout=40) as cli:
        for i in range(0, len(ids), 200):
            chunk = ids[i:i + 200]
            r = cli.get(f"{U}/rest/v1/post_patterns", headers=H, params={
                "brand_post_id": f"in.({','.join(chunk)})",
                "classifier_version": "eq.llm-v3",
                "select": "brand_post_id",
            })
            for x in (r.json() if r.status_code == 200 else []):
                done.add(x["brand_post_id"])
    return done


def org_for(brand_id, cache):
    if brand_id in cache:
        return cache[brand_id]
    org = None
    if brand_id:
        with httpx.Client(timeout=15) as cli:
            r = cli.get(f"{U}/rest/v1/brand_containers", headers=H,
                        params={"id": f"eq.{brand_id}", "select": "organization_id"})
            rows = r.json() if r.status_code == 200 else []
            org = rows[0]["organization_id"] if rows else None
    cache[brand_id] = org
    return org


def upsert(post, det, llm, orgcache):
    payload = {
        "brand_post_id": post["id"],
        "brand_container_id": post.get("brand_container_id"),
        "organization_id": org_for(post.get("brand_container_id"), orgcache),
        "is_competitor": bool(post.get("is_competitor", True)),
        "network": post.get("network"),
        "tone": llm.get("tone") or det["tone"],
        "topic": llm.get("topic") or det["topic"],
        "format": det["format"],
        "mood": llm.get("mood") or det["mood"],
        "tone_confidence": llm.get("tone_confidence") or det["tone_confidence"],
        "topic_confidence": llm.get("topic_confidence") or det["topic_confidence"],
        "engagement_total": det["engagement_total"],
        "engagement_rate": det["engagement_rate"],
        "sentiment_score": det["sentiment_score"],
        "impact_score": det["impact_score"],
        "reach": det["reach"],
        "followers_at_capture": det["followers_at_capture"],
        "posted_at": post.get("captured_at"),
        "classifier_version": "llm-v3",
        "topics": llm.get("topics", []),
        "tones": llm.get("tones", []),
        "moods": llm.get("moods", []),
        "sentiments": llm.get("sentiments", []),
        "audience_sentiment": llm.get("audience_sentiment"),
        "sentiment_evoked": llm.get("sentiment_evoked"),
    }
    with httpx.Client(timeout=20) as cli:
        r = cli.post(f"{U}/rest/v1/post_patterns",
                     headers={**H, "Prefer": "resolution=merge-duplicates"}, json=payload)
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code} {r.text[:150]}")


def main():
    MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
    posts = fetch_all_eligible()
    print(f"elegibles: {len(posts)}", flush=True)
    done = already_llm([p["id"] for p in posts])
    todo = [p for p in posts if p["id"] not in done][:MAX]
    print(f"ya llm-v3: {len(done)} | por reclasificar: {len(todo)}", flush=True)

    orgcache, ok, err = {}, 0, 0
    t0 = time.time()
    for i in range(0, len(todo), CHUNK):
        sub = todo[i:i + CHUNK]
        try:
            res = classify_batch(sub)
        except Exception as e:
            err += len(sub)
            print(f"[chunk {i}] classify FAIL: {str(e)[:200]}", flush=True)
            time.sleep(3)
            continue
        for p in sub:
            try:
                det = classify_post(p)
                upsert(p, det, res.get(p["id"], {}), orgcache)
                ok += 1
            except Exception as e:
                err += 1
                print(f"  upsert {p['id']} FAIL: {str(e)[:150]}", flush=True)
        rate = ok / max(1, (time.time() - t0))
        print(f"progreso: {ok} ok / {err} err / {len(todo)} | {rate:.2f} posts/s", flush=True)
        time.sleep(1.0)

    print(f"DONE ok={ok} err={err} en {int(time.time() - t0)}s", flush=True)


if __name__ == "__main__":
    main()
