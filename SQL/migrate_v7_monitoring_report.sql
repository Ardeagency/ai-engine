-- =============================================================================
-- migrate_v7 — Vista de reporte de monitoreo 24h para Vera
-- =============================================================================

-- 1. Vista: resumen de actividad del scraper en las últimas 24h
CREATE OR REPLACE VIEW monitoring_activity_24h AS
SELECT
  ie.name                                    AS competitor_name,
  ie.target_identifier                       AS handle,
  ie.metadata->>'platform'                   AS platform,
  mt.sensor_type,
  mt.cadence_value::int                      AS cadence_minutes,
  mt.priority,
  mt.last_run_at,
  mt.next_run_at,
  mt.last_run_status,
  mt.status                                  AS trigger_status,
  -- Cuántas señales nuevas capturó en 24h
  COUNT(DISTINCT si.id)                      AS signals_last_24h,
  -- Cuántas vulnerabilidades abiertas están asociadas
  COUNT(DISTINCT bv.id) FILTER (WHERE bv.status = 'open') AS open_vulnerabilities,
  -- Último sensor_run
  MAX(sr.started_at)                         AS last_sensor_run,
  -- Estado del último run
  (
    SELECT sr2.status
    FROM sensor_runs sr2
    WHERE sr2.trigger_id = mt.id
    ORDER BY sr2.started_at DESC LIMIT 1
  )                                          AS last_run_result
FROM monitoring_triggers mt
JOIN intelligence_entities ie ON ie.id = mt.entity_id
LEFT JOIN intelligence_signals si
  ON si.entity_id = ie.id
  AND si.captured_at >= NOW() - INTERVAL '24 hours'
LEFT JOIN brand_vulnerabilities bv
  ON bv.brand_container_id = mt.brand_container_id
  AND bv.detected_signal_id = si.id
LEFT JOIN sensor_runs sr
  ON sr.trigger_id = mt.id
  AND sr.started_at >= NOW() - INTERVAL '24 hours'
WHERE mt.status = 'active'
GROUP BY ie.name, ie.target_identifier, ie.metadata, mt.id, mt.sensor_type,
         mt.cadence_value, mt.priority, mt.last_run_at, mt.next_run_at,
         mt.last_run_status, mt.status
ORDER BY mt.priority DESC, signals_last_24h DESC;

-- 2. Vista: señales capturadas ordenadas por impacto
CREATE OR REPLACE VIEW intelligence_feed AS
SELECT
  si.id,
  ie.name                                    AS competitor_name,
  si.signal_type,
  si.content_numeric                         AS engagement,
  si.captured_at,
  -- Nivel de amenaza derivado de la vulnerabilidad asociada
  bv.severity,
  bv.status                                  AS vulnerability_status,
  bv.title                                   AS vulnerability_title,
  -- Extracto del contenido
  (si.content_text::jsonb ->> 'caption')     AS caption,
  (si.content_text::jsonb ->> 'excerpt')     AS excerpt,
  (si.content_text::jsonb ->> 'url')         AS content_url
FROM intelligence_signals si
JOIN intelligence_entities ie ON ie.id = si.entity_id
LEFT JOIN brand_vulnerabilities bv
  ON bv.detected_signal_id = si.id
ORDER BY si.captured_at DESC;

-- 3. Tabla de reportes periódicos generados por Vera
CREATE TABLE IF NOT EXISTS monitoring_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_container_id UUID NOT NULL REFERENCES brand_containers(id) ON DELETE CASCADE,
  report_type       TEXT NOT NULL DEFAULT 'periodic',   -- periodic, alert, daily_summary
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  summary           TEXT,                               -- resumen en markdown generado por Vera
  stats             JSONB NOT NULL DEFAULT '{}',        -- { triggers_run, signals_found, vulnerabilities_opened, jobs_processed }
  generated_by      TEXT DEFAULT 'vera-bg',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_monitoring_reports_bc
  ON monitoring_reports(brand_container_id, created_at DESC);

-- 4. Función helper: registrar un reporte periódico
CREATE OR REPLACE FUNCTION upsert_monitoring_report(
  p_brand_container_id UUID,
  p_report_type TEXT,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ,
  p_summary TEXT,
  p_stats JSONB
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO monitoring_reports(brand_container_id, report_type, period_start, period_end, summary, stats)
  VALUES (p_brand_container_id, p_report_type, p_period_start, p_period_end, p_summary, p_stats)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 5. Vista: jobs de análisis en las últimas 24h
CREATE OR REPLACE VIEW agent_jobs_24h AS
SELECT
  aqj.id,
  aqj.job_type,
  aqj.status,
  aqj.priority,
  aqj.attempts,
  aqj.created_at,
  aqj.completed_at,
  EXTRACT(EPOCH FROM (aqj.completed_at - aqj.created_at))::INT AS duration_seconds,
  aqj.result->>'success'                     AS success,
  aqj.payload->>'entity_name'                AS competitor_name,
  aqj.payload->>'threat_level'               AS threat_level,
  aqj.payload->>'signal_type'                AS signal_type
FROM agent_queue_jobs aqj
WHERE aqj.created_at >= NOW() - INTERVAL '24 hours'
ORDER BY aqj.created_at DESC;

