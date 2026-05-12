-- ============================================================================
-- Migration v9: Trigger automático de provisionamiento al crear organización
-- ============================================================================
--
-- PROBLEMA QUE RESUELVE:
--   Cuando se crea una nueva organización, el sistema Vera/OpenClaw debe
--   provisionarse automáticamente. Antes esto dependía de un Database Webhook
--   configurado manualmente en el dashboard de Supabase (frágil, se pierde
--   al eliminar/recrear proyectos o cambiar URLs).
--
-- SOLUCIÓN:
--   Trigger en organizations.INSERT → llama a pg_net para hacer POST
--   a /internal/org-created en el ai-engine. Es idempotente y más
--   confiable que los webhooks manuales del dashboard.
--
-- PREREQUISITOS:
--   1. pg_net habilitado: Dashboard → Extensions → pg_net → Enable
--   2. AI_ENGINE_URL con la URL pública del servidor
--   3. AI_ENGINE_WEBHOOK_SECRET con el mismo valor de INTERNAL_WEBHOOK_SECRET
--
-- ============================================================================

BEGIN;

-- ── 1. Tabla de configuración del trigger ─────────────────────────────────────
-- Permite cambiar la URL y el secret sin re-deployar SQL.

CREATE TABLE IF NOT EXISTS ai_engine_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Insertar los valores por defecto (ajustar URL y secret según tu entorno)
-- IMPORTANTE: reemplaza estos valores con los reales antes de ejecutar
INSERT INTO ai_engine_config (key, value)
VALUES
  ('ai_engine_url',            'http://5.161.243.1:3000'),
  ('org_provision_webhook_secret', 'whsec_2026_asc_internal')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;


-- ── 2. Función trigger: notifica al ai-engine cuando se crea una organización ──

CREATE OR REPLACE FUNCTION notify_org_provisioning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _url    text;
  _secret text;
  _body   jsonb;
BEGIN
  -- Leer configuración
  SELECT value INTO _url    FROM ai_engine_config WHERE key = 'ai_engine_url';
  SELECT value INTO _secret FROM ai_engine_config WHERE key = 'org_provision_webhook_secret';

  -- Construir payload compatible con el controller orgCreated
  -- (acepta tanto {record: {...}} como el objeto directo)
  _body := jsonb_build_object(
    'type',   'INSERT',
    'table',  'organizations',
    'record', jsonb_build_object(
      'id',         NEW.id,
      'name',       NEW.name,
      'created_at', NEW.created_at
    )
  );

  -- Llamar al ai-engine vía pg_net (non-blocking, fire-and-forget)
  PERFORM net.http_post(
    url     := _url || '/internal/org-created',
    body    := _body::text,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'x-webhook-secret', _secret
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Non-fatal: no debe fallar el INSERT de la organización si el webhook falla
  RAISE WARNING 'notify_org_provisioning: error calling ai-engine: %', SQLERRM;
  RETURN NEW;
END;
$$;


-- ── 3. Trigger en organizations ───────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_org_provision ON organizations;

CREATE TRIGGER trg_org_provision
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION notify_org_provisioning();


COMMIT;


-- ============================================================================
-- VERIFICACIÓN POST-EJECUCIÓN
-- ============================================================================
--
-- Confirmar que el trigger quedó creado:
--   SELECT trigger_name, event_manipulation, action_statement
--   FROM information_schema.triggers
--   WHERE event_object_table = 'organizations';
--
-- Confirmar configuración:
--   SELECT * FROM ai_engine_config;
--
-- Test manual (reemplazar el UUID con uno real o de prueba):
--   SELECT notify_org_provisioning();   -- No funciona directo, es trigger function
--
--   O simplemente crear una organización de prueba desde el frontend
--   y verificar en los logs del ai-engine:
--   journalctl -u ai-engine -f
-- ============================================================================
