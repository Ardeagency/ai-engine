import os, httpx
from app.tasks.pattern_classifier import classify_post

SUPABASE_URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
SEL = "id,brand_container_id,network,content,metrics,engagement_total,followers_snapshot,sentiment_score,sentiment,enrichment,media_assets,is_competitor,captured_at"

def org_for(bid, cache={}):
    if not bid: return None
    if bid in cache: return cache[bid]
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/brand_containers", headers=H,
                  params={"id": f"eq.{bid}", "select": "organization_id"}, timeout=10)
    rows = r.json() if r.status_code == 200 else []
    cache[bid] = rows[0]["organization_id"] if rows else None
    return cache[bid]

def run():
    ok = err = 0
    offset = 0
    with httpx.Client(timeout=30) as cli:
        while True:
            r = cli.get(f"{SUPABASE_URL}/rest/v1/brand_posts", headers={**H, "Range": f"{offset}-{offset+49}"},
                        params={"select": SEL, "is_competitor": "eq.false",
                                "ai_analyzed_at": "not.is.null", "sentiment_score": "not.is.null",
                                "order": "id.asc"})
            posts = r.json()
            if not posts: break
            for p in posts:
                try:
                    pat = classify_post(p)
                    payload = {
                        "brand_post_id": p["id"], "brand_container_id": p.get("brand_container_id"),
                        "organization_id": org_for(p.get("brand_container_id")),
                        "is_competitor": False, "network": p.get("network"),
                        "tone": pat["tone"], "topic": pat["topic"], "format": pat["format"], "mood": pat["mood"],
                        "tone_confidence": pat["tone_confidence"], "topic_confidence": pat["topic_confidence"],
                        "engagement_total": pat["engagement_total"], "engagement_rate": pat["engagement_rate"],
                        "sentiment_score": pat["sentiment_score"], "impact_score": pat["impact_score"],
                        "reach": pat["reach"], "followers_at_capture": pat["followers_at_capture"],
                        "posted_at": p.get("captured_at"), "classifier_version": "v2",
                    }
                    rr = cli.post(f"{SUPABASE_URL}/rest/v1/post_patterns",
                                  headers={**H, "Prefer": "resolution=merge-duplicates"}, json=payload)
                    if rr.status_code >= 400:
                        err += 1; print("ERR", p["id"], rr.status_code, rr.text[:120])
                    else: ok += 1
                except Exception as e:
                    err += 1; print("EXC", p.get("id"), str(e)[:120])
            offset += 50
    print(f"DONE ok={ok} err={err}")

run()
