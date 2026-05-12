-- =============================================================================
-- MIGRACIÓN V7 — Deduplicación robusta + Tareas de monitoreo 24h
-- =============================================================================
-- Objetivos:
--   1. Constraint único en brand_posts(entity_id, post_id) → bloquea duplicados a nivel DB
--   2. Caption field en intelligence_signals (ya existe como content_text con JSON)
--   3. Índice de búsqueda rápida en brand_posts por post_id
--   4. URL watchers para sitios web de competidores (monitoreo de cambios)
--   5. Actualizar triggers de monitoreo a cadencia cada 45min para el test 24h
-- =============================================================================

-- ─── 1. Constraint único brand_posts(entity_id, post_id) ─────────────────────
-- Previene el doble insert del mismo post de la misma entidad a nivel de BD.
-- El ON CONFLICT en el scraper usará este constraint para hacer upsert de métricas.

ALTER TABLE public.brand_posts
  ADD CONSTRAINT IF NOT EXISTS brand_posts_entity_post_unique
  UNIQUE (entity_id, post_id);

-- Índice compuesto para búsquedas rápidas (ya lo crea el UNIQUE, pero lo hacemos explícito)
CREATE INDEX IF NOT EXISTS brand_posts_entity_post_idx
  ON public.brand_posts (entity_id, post_id);

-- Índice por captured_at para ordenar por fecha
CREATE INDEX IF NOT EXISTS brand_posts_captured_at_idx
  ON public.brand_posts (captured_at DESC);

-- ─── 2. Índice en intelligence_signals para búsqueda rápida de duplicados ────
CREATE INDEX IF NOT EXISTS intelligence_signals_entity_type_idx
  ON public.intelligence_signals (entity_id, signal_type, captured_at DESC);

-- ─── 3. URL Watchers para sitios web de competidores ─────────────────────────
-- Monitorea la página principal de los competidores buscando cambios de contenido.
-- El scraper calcula SHA-256 del texto visible; si el hash cambia → señal de alerta.

INSERT INTO public.url_watchers (url, label, entity_id, brand_container_id, is_active, last_hash, last_checked_at, created_at)
VALUES
  -- Nike
  ('https://www.nike.com/es/launch', 'Nike ES - Lanzamientos',
   '565f1152-3cb9-4de2-85eb-a8e60f67b5a0', '20000000-0000-0000-0000-000000000001',
   true, '', NOW() - INTERVAL '25 hours', NOW()),

  -- Adidas
  ('https://www.adidas.es/new', 'Adidas ES - Novedades',
   'ee70ffa8-4f64-4629-b759-97ce2bc524ed', '20000000-0000-0000-0000-000000000001',
   true, '', NOW() - INTERVAL '25 hours', NOW()),

  -- Puma
  ('https://eu.puma.com/es/es/new', 'Puma EU - Nuevos productos',
   '8fcbc60d-4bb5-47a6-88e3-34f27efdfda0', '20000000-0000-0000-0000-000000000001',
   true, '', NOW() - INTERVAL '25 hours', NOW()),

  -- Red Bull
  ('https://www.redbull.com/es-es/tags/nuevos-productos', 'Red Bull ES - Noticias',
   '3633f317-1c3c-4a89-bbe9-2ef997daa87f', '20000000-0000-0000-0000-000000000001',
   true, '', NOW() - INTERVAL '25 hours', NOW())

ON CONFLICT DO NOTHING;

-- ─── 4. Limpiar triggers duplicados de NatGeo y activar todos a 45min ────────
-- NatGeo tiene 3 triggers (daily + 360min + null). Consolidamos a 1 con 45min.

-- Desactivar el daily de NatGeo y el de cadence_value null
UPDATE public.monitoring_triggers
  SET status = 'paused', updated_at = NOW()
  WHERE entity_id = '95700df4-c337-4c8c-8331-b2328438d446'
    AND (cadence = 'daily' OR cadence_value IS NULL);

-- Actualizar TODOS los triggers activos a cadencia 45min para el test de 24h
-- y forzar next_run_at = NOW() para que empiecen inmediatamente.
UPDATE public.monitoring_triggers
  SET
    cadence       = 'interval',
    cadence_value = '45',
    next_run_at   = NOW(),
    updated_at    = NOW()
  WHERE status = 'active'
    AND brand_container_id = '20000000-0000-0000-0000-000000000001';

-- Asegurarse de que el trigger de NatGeo activo tenga prioridad correcta
UPDATE public.monitoring_triggers
  SET priority = 6, updated_at = NOW()
  WHERE entity_id = '95700df4-c337-4c8c-8331-b2328438d446'
    AND status = 'active';

-- ─── 5. Verificación final ────────────────────────────────────────────────────
SELECT
  t.id,
  e.name            AS entity,
  e.metadata->>'platform' AS platform,
  t.sensor_type,
  t.cadence,
  t.cadence_value,
  t.status,
  t.next_run_at
FROM public.monitoring_triggers t
JOIN public.intelligence_entities e ON e.id = t.entity_id
ORDER BY t.status, e.name;
