-- ─────────────────────────────────────────────────────────────────────────────
-- Migración v11: Trends Engine — infraestructura base (Fase 1)
--
-- Crea trend_query_jobs (tracking por ciclo del nuevo motor de tendencias) y
-- extiende credit_usage.kind con los kinds nuevos del pipeline:
--   dataforseo_query, meta_ads_library_query, embedding_call, vera_brief_generation
--
-- Schema reutilizado del sistema viejo (NO drop): audience_demand_signals,
-- targeted_trend_signals, trend_topics, similar_products_detected,
-- external_api_cache, org_trends_config, emerging_brand_candidates.
--
-- Ref: trends-engine-blueprint secciones 12.1 y 12.2
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Tabla trend_query_jobs
CREATE TABLE IF NOT EXISTS public.trend_query_jobs (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  organization_id             uuid        NOT NULL,
  brand_container_id          uuid        NOT NULL,
  cycle_id                    uuid        NOT NULL,
  total_queries_generated     integer     DEFAULT 0,
  total_queries_executed      integer     DEFAULT 0,
  total_signals_collected     integer     DEFAULT 0,
  total_signals_passed_filter integer     DEFAULT 0,
  total_signals_scored        integer     DEFAULT 0,
  total_briefs_generated      integer     DEFAULT 0,
  total_cost_usd              numeric     DEFAULT 0,
  total_credits_consumed      numeric     DEFAULT 0,
  status                      text        NOT NULL DEFAULT 'running'
    CHECK (status = ANY (ARRAY['running','completed','failed','partial'])),
  started_at                  timestamptz DEFAULT now(),
  completed_at                timestamptz,
  error_message               text,
  metadata                    jsonb       DEFAULT '{}'::jsonb,
  CONSTRAINT trend_query_jobs_pkey
    PRIMARY KEY (id),
  CONSTRAINT trend_query_jobs_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT trend_query_jobs_brand_container_id_fkey
    FOREIGN KEY (brand_container_id) REFERENCES public.brand_containers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trend_query_jobs_brand_status
  ON public.trend_query_jobs(brand_container_id, status);
CREATE INDEX IF NOT EXISTS idx_trend_query_jobs_started_at
  ON public.trend_query_jobs(started_at DESC);


-- 2. Extender credit_usage.kind CHECK constraint
ALTER TABLE public.credit_usage DROP CONSTRAINT IF EXISTS credit_usage_kind_check;
ALTER TABLE public.credit_usage ADD CONSTRAINT credit_usage_kind_check
  CHECK (kind = ANY (ARRAY[
    'apify_scrape',
    'vera_chat',
    'tool_call',
    'recharge',
    'plan_grant',
    'migration_grant',
    'refund',
    'adjustment',
    'claude_describe',
    'gemini_describe',
    'shopify_initial_sync',
    'shopify_incremental_sync',
    'shopify_action_execution',
    'dataforseo_query',
    'meta_ads_library_query',
    'embedding_call',
    'vera_brief_generation'
  ]));
