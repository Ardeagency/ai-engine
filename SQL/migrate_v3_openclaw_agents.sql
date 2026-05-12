-- ============================================================================
-- AI Smart Content — Migración v3: OpenClaw CLI Agents
-- Adapta openclaw_instances del schema Docker al schema CLI
--
-- EJECUTAR EN SUPABASE SQL EDITOR
-- ============================================================================

-- 1. Hacer nullable las columnas Docker que ya no son obligatorias
ALTER TABLE public.openclaw_instances
  ALTER COLUMN container_name DROP NOT NULL;

ALTER TABLE public.openclaw_instances
  ALTER COLUMN internal_url DROP NOT NULL;

-- 2. Agregar columnas del nuevo sistema CLI (si no existen)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='openclaw_instances' AND column_name='agent_id') THEN
    ALTER TABLE public.openclaw_instances ADD COLUMN agent_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='openclaw_instances' AND column_name='workspace_path') THEN
    ALTER TABLE public.openclaw_instances ADD COLUMN workspace_path TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='openclaw_instances' AND column_name='error_message') THEN
    ALTER TABLE public.openclaw_instances ADD COLUMN error_message TEXT;
  END IF;
END $$;

-- 3. Índice en agent_id para búsquedas rápidas
CREATE INDEX IF NOT EXISTS openclaw_instances_agent_id_idx
  ON public.openclaw_instances(agent_id);

-- 4. Actualizar status check si no incluye los nuevos estados
-- (provisioning y starting ya deberían estar en el enum si el check lo permite)
-- Si hay CHECK constraint en status, puede necesitar recrearse. Verificar con:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='openclaw_instances'::regclass;

-- 5. Verificación final
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'openclaw_instances'
ORDER BY ordinal_position;
