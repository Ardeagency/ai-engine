"""trends_scheduler — corre el trends engine (News/social externo) para cada
brand_container REAL, semanalmente. Alimenta targeted_trend_signals (dimension
'noticias' de los oceanos azules en Tendencias) y strategic_recommendations
(briefs de Estrategia).

No depende de Apify: los collectors de pago degradan a []; NewsAPI (gratis) +
meta_ads_library + OpenAI/Anthropic hacen el trabajo. Excluye la org demo IGNIS.

Uso:  .venv/bin/python -m app.tasks.trends_scheduler [brand_container_id]
"""
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
ANALYZER = os.environ.get("ANALYZER_URL", "http://127.0.0.1:8001")
MAX_QUERIES = int(os.environ.get("TRENDS_SCHED_MAX_QUERIES", "40"))
DEMO_ORG = "a1000000-0000-0000-0000-000000000001"  # IGNIS ficticia — no gastar


def _containers() -> list:
    with httpx.Client(timeout=30) as cli:
        r = cli.get(f"{SUPABASE_URL}/rest/v1/brand_containers", headers=H,
                    params={"select": "id,organization_id,mercado_objetivo"})
        return r.json() if r.status_code == 200 else []


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    targets = [only] if only else [
        c["id"] for c in _containers()
        if c.get("organization_id") != DEMO_ORG and c.get("mercado_objetivo")
    ]
    if not targets:
        print("trends_scheduler: sin brand_containers reales")
        return
    total_cost = 0.0
    with httpx.Client(timeout=300) as cli:
        for bc in targets:
            try:
                r = cli.post(f"{ANALYZER}/trends/run/{bc}",
                             params={"mock": "false", "max_queries": str(MAX_QUERIES)})
                d = r.json()
                total_cost += float(d.get("total_cost_usd") or 0)
                print(f"  {bc[:8]}: raw={d.get('signals_raw')} scored={d.get('scored')} "
                      f"briefs={d.get('briefs')} ${d.get('total_cost_usd')}")
            except Exception as e:
                print(f"  {bc[:8]}: ERROR {e}")
    print(f"trends_scheduler: {len(targets)} marcas, ${round(total_cost, 4)} total")


if __name__ == "__main__":
    main()
