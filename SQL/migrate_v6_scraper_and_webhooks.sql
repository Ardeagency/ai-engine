-- ============================================================================
-- Migration v6: Social Scraper Infrastructure — Índices y Webhook
-- ============================================================================
--
-- ESTADO DEL SCHEMA (revisado contra schema real):
--   ✅ url_watchers              → YA EXISTE en el schema
--   ✅ intelligence_signals.ai_analysis → YA EXISTE como jsonb DEFAULT '{}'
--   ✅ body_missions             → YA EXISTE con trigger_signal_id
--   ✅ agent_queue_jobs          → YA EXISTE con job_type 'analysis'
--   ✅ mission_runs              → YA EXISTE
--   ✅ sensor_runs               → YA EXISTE
--   ✅ monitoring_triggers       → YA EXISTE
--   ✅ brand_vulnerabilities     → YA EXISTE
--
-- Esta migración SOLO agrega:
--   1. Índices para rendimiento del scraper (dedup, polling por trigger)
--   2. Vista de señales recientes con análisis
--   3. Instrucciones para configurar el Database Webhook en Supabase
--
-- ============================================================================

BEGIN;

-- ── 1. Índices para dedup de intelligence_signals ─────────────────────────────
-- El scraper consulta estos índices en cada ciclo para evitar reinsertar posts.

CREATE INDEX IF NOT EXISTS idx_intel_signals_entity_type_date
  ON intelligence_signals(entity_id, signal_type, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_intel_signals_captured_desc
  ON intelligence_signals(captured_at DESC);

-- Índice parcial solo para posts (tipo más frecuente del scraper)
CREATE INDEX IF NOT EXISTS idx_intel_signals_posts_entity
  ON intelligence_signals(entity_id, captured_at DESC)
  WHERE signal_type = 'post';


-- ── 2. Índices para monitoring_triggers (polling eficiente) ───────────────────
-- El scheduler consulta estos índices cada 15 min para encontrar triggers vencidos.

CREATE INDEX IF NOT EXISTS idx_monitoring_triggers_next_run
  ON monitoring_triggers(next_run_at ASC, status, sensor_type)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_monitoring_triggers_brand_status
  ON monitoring_triggers(brand_container_id, status);


-- ── 3. Índices para agent_queue_jobs (worker polling) ────────────────────────
-- Cuando el worker de análisis (futuro) consulte jobs pendientes.

CREATE INDEX IF NOT EXISTS idx_queue_jobs_org_status_priority
  ON agent_queue_jobs(organization_id, status, priority DESC, run_after ASC)
  WHERE status IN ('queued', 'assigned');


-- ── 4. Índices para brand_vulnerabilities ────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_vulnerabilities_brand_status
  ON brand_vulnerabilities(brand_container_id, status, severity);


-- ── 5. Índices para sensor_runs (auditoría) ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sensor_runs_brand_date
  ON sensor_runs(brand_container_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_runs_trigger
  ON sensor_runs(trigger_id, started_at DESC)
  WHERE trigger_id IS NOT NULL;


-- ── 6. Índices para url_watchers ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_url_watchers_active
  ON url_watchers(is_active)
  WHERE is_active = true;


-- ── 7. Vista: señales recientes con análisis + vulnerabilidades ───────────────

CREATE OR REPLACE VIEW recent_competitor_activity AS
SELECT
  s.id              AS signal_id,
  s.signal_type,
  s.content_text,
  s.content_numeric,
  s.ai_analysis,
  s.captured_at,
  e.id              AS entity_id,
  e.name            AS entity_name,
  e.target_identifier,
  e.brand_container_id,
  bv.id             AS vulnerability_id,
  bv.severity,
  bv.status         AS vulnerability_status
FROM intelligence_signals s
JOIN intelligence_entities e ON s.entity_id = e.id
LEFT JOIN brand_vulnerabilities bv ON bv.detected_signal_id = s.id
WHERE s.captured_at > now() - INTERVAL '7 days'
ORDER BY s.captured_at DESC;


COMMIT;

-- ============================================================================
-- CONFIGURACIÓN REQUERIDA (manual — Supabase Dashboard)
-- ============================================================================
--
-- 1. Habilitar pg_net (si no está habilitado):
--    Dashboard → Extensions → buscar "pg_net" → Enable
--
-- 2. Crear Database Webhook para intelligence_signals:
--    Dashboard → Database → Webhooks → "Create a new hook"
--      Nombre:    signal-to-vera
--      Table:     intelligence_signals
--      Events:    INSERT
--      Method:    POST
--      URL:       https://TU-AI-ENGINE-URL/webhooks/signal
--      Headers:
--        Content-Type:          application/json
--        X-Supabase-Signature:  <secreto-random-32-chars>
--
-- 3. Agregar al .env de ai-engine:
--      SUPABASE_WEBHOOK_SECRET=<mismo-secreto-de-arriba>
--      INTERNAL_ADMIN_TOKEN=<token-para-admin-endpoints>
--      SCRAPER_ENABLED=true
--      SCRAPER_INTERVAL_MINUTES=15
--
-- 4. Crear monitoring_triggers para cada competidor a monitorear:
--    INSERT INTO monitoring_triggers (brand_container_id, entity_id, sensor_type,
--      cadence, cadence_value, priority, status, next_run_at)
--    VALUES (
--      '<brand_container_id>',
--      '<intelligence_entity_id>',
--      'social',
--      'interval',
--      '60',       -- minutos entre scrapes
--      7,          -- prioridad (1-10)
--      'active',
--      now()       -- correr inmediatamente en el primer ciclo
--    );
-- ============================================================================
