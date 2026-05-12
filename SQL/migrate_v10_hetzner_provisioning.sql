-- ─────────────────────────────────────────────────────────────────────────────
-- Migración v10: Hetzner Provisioning — arquitectura multi-tenant
--
-- Extiende openclaw_instances para soportar dos tipos de servidor:
--   type 'local'   → agente CLI en el control plane (modelo anterior)
--   type 'hetzner' → org-server dedicado en Hetzner (modelo nuevo)
--
-- Nuevas columnas:
--   server_type        TEXT    'local' | 'hetzner'
--   hetzner_server_id  BIGINT  ID del servidor en la API de Hetzner
--   server_ip          TEXT    IP pública del org-server
--   server_port        INT     Puerto del HTTP bridge (default 3001)
--   org_token          TEXT    Token de autenticación org-server ↔ AI Engine
--   snapshot_id        TEXT    ID del snapshot Hetzner (para wake rápido)
--   last_activity_at   TSTZ    Última actividad — usado para detección de inactividad
--   sleeping           BOOL    TRUE si el server está en sleep (snapshot + destruido)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Nuevas columnas en openclaw_instances
ALTER TABLE openclaw_instances
  ADD COLUMN IF NOT EXISTS server_type       TEXT    NOT NULL DEFAULT 'local'
    CHECK (server_type IN ('local', 'hetzner')),
  ADD COLUMN IF NOT EXISTS hetzner_server_id BIGINT,
  ADD COLUMN IF NOT EXISTS server_ip         TEXT,
  ADD COLUMN IF NOT EXISTS server_port       INTEGER NOT NULL DEFAULT 3001,
  ADD COLUMN IF NOT EXISTS org_token         TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_id       TEXT,
  ADD COLUMN IF NOT EXISTS last_activity_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sleeping          BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Índices útiles para las queries del control plane
CREATE INDEX IF NOT EXISTS idx_openclaw_instances_server_type
  ON openclaw_instances (server_type);

CREATE INDEX IF NOT EXISTS idx_openclaw_instances_hetzner_server_id
  ON openclaw_instances (hetzner_server_id)
  WHERE hetzner_server_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_openclaw_instances_sleeping
  ON openclaw_instances (sleeping)
  WHERE sleeping = TRUE;

-- 3. Función para actualizar last_activity_at de forma eficiente
--    Llamada por el control plane cada vez que la org genera actividad.
CREATE OR REPLACE FUNCTION touch_org_activity(p_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE openclaw_instances
  SET    last_activity_at = now(),
         updated_at       = now()
  WHERE  organization_id = p_org_id;
END;
$$;

-- 4. Vista para el dashboard de administración: estado de todos los org-servers
CREATE OR REPLACE VIEW v_org_server_status AS
SELECT
  oi.organization_id,
  o.name                                   AS org_name,
  oi.server_type,
  oi.status,
  oi.hetzner_server_id,
  oi.server_ip,
  oi.server_port,
  oi.sleeping,
  oi.last_activity_at,
  EXTRACT(EPOCH FROM (now() - oi.last_activity_at)) / 86400
                                           AS inactive_days,
  oi.snapshot_id IS NOT NULL               AS has_snapshot,
  oi.updated_at
FROM openclaw_instances oi
LEFT JOIN organizations o ON o.id = oi.organization_id
ORDER BY oi.updated_at DESC;

-- 5. Tabla de provisioning_events: historial de eventos de ciclo de vida
--    Útil para auditoría, debug y alertas de provisioning fallido.
CREATE TABLE IF NOT EXISTS provisioning_events (
  id              UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type      TEXT         NOT NULL,
    -- 'provision_started' | 'provision_completed' | 'provision_failed'
    -- 'server_ready'      | 'health_check_failed'
    -- 'sleep_started'     | 'sleep_completed'
    -- 'wake_started'      | 'wake_completed'
  server_type     TEXT         NOT NULL DEFAULT 'local',
  hetzner_server_id BIGINT,
  details         JSONB        NOT NULL DEFAULT '{}',
  error_message   TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provisioning_events_org_id
  ON provisioning_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provisioning_events_type
  ON provisioning_events (event_type, created_at DESC);

-- RLS: solo el service role puede leer/escribir eventos de provisioning
ALTER TABLE provisioning_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_only" ON provisioning_events
  USING (auth.role() = 'service_role');

-- Helper para insertar eventos de provisioning desde AI Engine
CREATE OR REPLACE FUNCTION log_provisioning_event(
  p_org_id          UUID,
  p_event_type      TEXT,
  p_server_type     TEXT    DEFAULT 'local',
  p_hetzner_id      BIGINT  DEFAULT NULL,
  p_details         JSONB   DEFAULT '{}',
  p_error_message   TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO provisioning_events (
    organization_id, event_type, server_type,
    hetzner_server_id, details, error_message
  ) VALUES (
    p_org_id, p_event_type, p_server_type,
    p_hetzner_id, p_details, p_error_message
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
