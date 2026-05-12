-- ============================================================================
-- Migración v8: Habilitar Supabase Realtime para ai_messages
-- ============================================================================
-- PROBLEMA: Los eventos postgres_changes de Supabase Realtime solo funcionan
-- si la tabla está en la publicación "supabase_realtime". Sin esto, el frontend
-- nunca recibe notificaciones automáticas cuando Vera guarda su respuesta.
--
-- INSTRUCCIONES: Ejecutar en Supabase SQL Editor → New Query
-- ============================================================================

BEGIN;

-- 1. Habilitar REPLICA IDENTITY FULL en ai_messages
--    Requerido para que Supabase Realtime envíe el contenido completo
--    de cada fila en los eventos INSERT/UPDATE/DELETE.
ALTER TABLE public.ai_messages REPLICA IDENTITY FULL;

-- 2. Agregar ai_messages a la publicación supabase_realtime
--    Si ya está incluida esta línea falla silenciosamente (IDEMPOTENTE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ai_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_messages;
  END IF;
END $$;

-- 3. Habilitar también ai_conversations para futuras suscripciones
ALTER TABLE public.ai_conversations REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ai_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_conversations;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Confirmar que las tablas están en la publicación:
--   SELECT tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime'
--   ORDER BY tablename;
--
-- Debería incluir: ai_messages, ai_conversations
-- ============================================================================
