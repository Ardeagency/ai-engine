-- ============================================================================
-- Migration v7: ai_messages — columna metadata + roles status/error
-- ============================================================================
--
-- PROBLEMAS:
--   1. La tabla ai_messages no tiene columna `metadata` JSONB.
--      ai-engine la necesita para guardar { is_status, error, actions }.
--
--   2. El check constraint ai_messages_role_check no permite los valores
--      'status' ni 'error'. ai-engine los usa para:
--        role='status'  → mensajes de actividad en tiempo real (typing indicator)
--        role='error'   → respuestas de error de Vera
--
-- CÓMO EJECUTAR:
--   Pegar este script en el SQL Editor de Supabase y ejecutar.
-- ============================================================================

-- ── 1. Agregar columna metadata ────────────────────────────────────────────
ALTER TABLE public.ai_messages
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;

-- ── 2. Índice GIN para queries eficientes sobre metadata ───────────────────
CREATE INDEX IF NOT EXISTS ai_messages_metadata_gin
  ON public.ai_messages USING GIN (metadata)
  WHERE metadata IS NOT NULL;

-- ── 3. Ampliar el check constraint para incluir 'status' y 'error' ─────────
-- Primero eliminar el constraint existente, luego recrearlo con los nuevos valores.
-- Si el constraint tiene un nombre distinto en tu instancia, ajusta el nombre.
ALTER TABLE public.ai_messages
  DROP CONSTRAINT IF EXISTS ai_messages_role_check;

ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_role_check
  CHECK (role IN ('user', 'assistant', 'system', 'status', 'error'));

-- ── 4. Comentarios ─────────────────────────────────────────────────────────
COMMENT ON COLUMN public.ai_messages.metadata IS
  'Metadatos del mensaje:
   { "is_status": true }           — status efímero (Vera procesando)
   { "error": true }               — respuesta de error
   { "actions": [...] }            — botones de acción para el frontend
   { "tool_name": "...", "status_type": "tool_executing" } — tool ejecutando';

COMMENT ON COLUMN public.ai_messages.role IS
  'Rol del mensaje:
   user      — mensaje del usuario
   assistant — respuesta de Vera
   system    — resumen de memoria / contexto del sistema
   status    — actividad en tiempo real (efímero, se borra al terminar)
   error     — respuesta de error de Vera';
