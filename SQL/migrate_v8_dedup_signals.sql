-- ============================================================
-- MIGRACIÓN v8 — Deduplicación robusta para intelligence_signals y brand_posts
--
-- Problema: el scraper insertaba duplicados porque:
--   1. El check previo (getKnownExternalIds) solo miraba los últimos 50 registros
--   2. intelligence_signals no tenía restricción UNIQUE
--   3. brand_posts tampoco tenía restricción UNIQUE → errores en lugar de upserts
--
-- Solución (patrón de ingest_social_post / handle_social_metrics_update):
--   1. Agregar columna external_id a intelligence_signals
--   2. Crear índice UNIQUE parcial (entity_id, signal_type, external_id) para posts
--   3. Crear índice UNIQUE parcial (entity_id, post_id, network) en brand_posts
--   4. Backfill de filas existentes (extrayendo external_id del JSON en content_text)
-- ============================================================

-- ─── 1. Columna external_id en intelligence_signals ──────────────────────────
ALTER TABLE public.intelligence_signals
  ADD COLUMN IF NOT EXISTS external_id TEXT;

-- ─── 2. Backfill: extraer external_id del JSON content_text (post rows) ──────
DO $$
DECLARE
  r   RECORD;
  ext TEXT;
BEGIN
  FOR r IN
    SELECT id, content_text
    FROM public.intelligence_signals
    WHERE signal_type = 'post'
      AND external_id IS NULL
      AND content_text IS NOT NULL
      AND content_text <> '{}'
      AND content_text <> ''
  LOOP
    BEGIN
      ext := (r.content_text::jsonb) ->> 'external_id';
      IF ext IS NOT NULL THEN
        UPDATE public.intelligence_signals
           SET external_id = ext
         WHERE id = r.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- saltar filas con JSON inválido
    END;
  END LOOP;
END;
$$;

-- ─── 3. Índice ÚNICO en intelligence_signals (dedup de posts por entidad) ─────
CREATE UNIQUE INDEX IF NOT EXISTS intelligence_signals_dedup_post_idx
  ON public.intelligence_signals (entity_id, signal_type, external_id)
  WHERE external_id IS NOT NULL
    AND signal_type = 'post';

-- ─── 4. Índice ÚNICO en brand_posts (dedup por entidad + ID externo + red) ────
--  Primero verificar si ya existe un constraint; si la tabla está vacía
--  el CREATE INDEX es instantáneo.
CREATE UNIQUE INDEX IF NOT EXISTS brand_posts_dedup_idx
  ON public.brand_posts (entity_id, post_id, network)
  WHERE post_id IS NOT NULL;

-- ─── 5. Índice de rendimiento para getKnownExternalIds ───────────────────────
--  Antes: SELECT content_text ... LIMIT 50 → parseo en JS
--  Ahora: SELECT external_id  ... sin límite → columna indexada
CREATE INDEX IF NOT EXISTS intelligence_signals_entity_type_extid_idx
  ON public.intelligence_signals (entity_id, signal_type, external_id)
  WHERE signal_type = 'post';

-- ─── 6. Confirmar ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '✅  Migración v8 completada: índices de dedup creados en intelligence_signals y brand_posts';
END;
$$;
