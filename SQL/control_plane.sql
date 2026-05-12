-- ============================================================================
-- AI Smart Content — Control Plane Tables
-- Ejecutar en Supabase SQL Editor
-- ============================================================================

-- ── 1. ai_agents ─────────────────────────────────────────────────────────────
-- Un agente por organización. Registro permanente (no se borra, se "detiene").
CREATE TABLE IF NOT EXISTS public.ai_agents (
  id                   uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  organization_id      uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_path       text NOT NULL,
  status               text DEFAULT 'provisioned'
                       CHECK (status IN ('provisioning','provisioned','active','idle','degraded','failed','stopped')),
  config               jsonb DEFAULT '{}'::jsonb,
  memory_snapshot      jsonb DEFAULT '{}'::jsonb,  -- última memoria persistida antes de idle
  capabilities         jsonb DEFAULT '["read_brand","read_campaigns","read_flows"]'::jsonb,
  tool_phase           text DEFAULT 'A' CHECK (tool_phase IN ('A','B','C')),
  last_active_at       timestamptz,
  provisioned_at       timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_agents_org_idx    ON public.ai_agents(organization_id);
CREATE INDEX IF NOT EXISTS ai_agents_status_idx ON public.ai_agents(status);

-- ── 2. ai_agent_runtime ───────────────────────────────────────────────────────
-- Estado de ejecución en tiempo real (actualizado frecuentemente).
CREATE TABLE IF NOT EXISTS public.ai_agent_runtime (
  agent_id             uuid PRIMARY KEY REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status               text DEFAULT 'stopped'
                       CHECK (status IN ('starting','ready','busy','idle','degraded','failed','stopped')),
  current_task         text,
  current_job_id       uuid,
  process_pid          integer,
  started_at           timestamptz,
  last_ping_at         timestamptz,
  error_count          integer DEFAULT 0,
  consecutive_failures integer DEFAULT 0,
  resources_snapshot   jsonb DEFAULT '{}'::jsonb,  -- { cpu, ram, ms_since_last_task }
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_agent_runtime_org_idx    ON public.ai_agent_runtime(organization_id);
CREATE INDEX IF NOT EXISTS ai_agent_runtime_status_idx ON public.ai_agent_runtime(status);

-- ── 3. agent_queue_jobs ───────────────────────────────────────────────────────
-- Cola de trabajos con prioridades. El Resource Governor decide cuándo ejecutar.
CREATE TABLE IF NOT EXISTS public.agent_queue_jobs (
  id               uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id         uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  job_type         text NOT NULL
                   CHECK (job_type IN ('chat','mission','sensor','report','analysis','trigger')),
  priority         integer DEFAULT 5
                   CHECK (priority BETWEEN 1 AND 10),  -- 1=crítico, 10=bajo
  payload          jsonb DEFAULT '{}'::jsonb,
  status           text DEFAULT 'queued'
                   CHECK (status IN ('queued','assigned','running','completed','failed','cancelled')),
  attempts         integer DEFAULT 0,
  max_attempts     integer DEFAULT 3,
  locked_by        text,       -- ID del worker que lo tiene
  locked_at        timestamptz,
  run_after        timestamptz DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  result           jsonb,
  error_message    text,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_queue_jobs_org_idx    ON public.agent_queue_jobs(organization_id);
CREATE INDEX IF NOT EXISTS agent_queue_jobs_status_idx ON public.agent_queue_jobs(status, priority, run_after);

-- ── 4. mission_runs ──────────────────────────────────────────────────────────
-- Registro de ejecuciones de misiones (body_missions ya existe en el schema).
CREATE TABLE IF NOT EXISTS public.mission_runs (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  mission_id      uuid REFERENCES public.body_missions(id) ON DELETE SET NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  job_id          uuid REFERENCES public.agent_queue_jobs(id) ON DELETE SET NULL,
  status          text DEFAULT 'pending'
                  CHECK (status IN ('pending','queued','running','completed','failed','cancelled','timeout')),
  trigger_type    text,  -- 'signal','schedule','manual','chat'
  trigger_id      uuid,  -- id de la señal o evento que disparó la misión
  started_at      timestamptz,
  completed_at    timestamptz,
  duration_ms     integer,
  result          jsonb DEFAULT '{}'::jsonb,
  error_message   text,
  tokens_used     integer DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mission_runs_org_idx    ON public.mission_runs(organization_id);
CREATE INDEX IF NOT EXISTS mission_runs_status_idx ON public.mission_runs(status);

-- ── 5. system_metrics ────────────────────────────────────────────────────────
-- Snapshots de salud del servidor (guardados cada ~30s por el health service).
CREATE TABLE IF NOT EXISTS public.system_metrics (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  cpu_percent     numeric NOT NULL,
  ram_percent     numeric NOT NULL,
  ram_used_mb     integer,
  ram_total_mb    integer,
  disk_percent    numeric,
  disk_used_gb    numeric,
  active_agents   integer DEFAULT 0,
  queued_jobs     integer DEFAULT 0,
  running_jobs    integer DEFAULT 0,
  health_state    text DEFAULT 'green'
                  CHECK (health_state IN ('green','yellow','orange','red')),
  snapshot        jsonb DEFAULT '{}'::jsonb,
  captured_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_metrics_time_idx  ON public.system_metrics(captured_at DESC);
CREATE INDEX IF NOT EXISTS system_metrics_state_idx ON public.system_metrics(health_state);

-- Retención automática: borrar métricas de más de 7 días
-- (crear como pg_cron job si está disponible en tu Supabase)
-- SELECT cron.schedule('cleanup-metrics', '0 3 * * *',
--   $$DELETE FROM public.system_metrics WHERE captured_at < now() - interval '7 days'$$);

-- ── RLS: solo service_role puede acceder ──────────────────────────────────────
ALTER TABLE public.ai_agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_runtime   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_queue_jobs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_metrics     ENABLE ROW LEVEL SECURITY;

-- ai-engine usa service_role key → acceso total, usuarios finales no ven estas tablas
CREATE POLICY "service_only" ON public.ai_agents        USING (false) WITH CHECK (false);
CREATE POLICY "service_only" ON public.ai_agent_runtime USING (false) WITH CHECK (false);
CREATE POLICY "service_only" ON public.agent_queue_jobs USING (false) WITH CHECK (false);
CREATE POLICY "service_only" ON public.mission_runs     USING (false) WITH CHECK (false);
CREATE POLICY "service_only" ON public.system_metrics   USING (false) WITH CHECK (false);
