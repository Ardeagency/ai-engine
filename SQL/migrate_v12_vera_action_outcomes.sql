-- ════════════════════════════════════════════════════════════════════════════
-- Migración v12 — Loop de retroalimentación post-ejecución (vera_action_outcomes)
--
-- Cierra la deuda docs/task/loop-retroalimentacion.md (detectada 2026-05-08):
-- hoy el ciclo es abierto (propone → aprueba → ejecuta → fin). Esta tabla
-- persiste mediciones de outcome por acción ejecutada, con múltiples ventanas
-- de medición (7d, 30d, y 24h para acciones de contenido cuando lleguen los
-- publish_* del executor en Fase III/IV).
--
-- Productor: src/services/outcome-measurement.service.js (reglas + math, NO LLM)
-- Consumidor: tools getActionOutcomes / getActionOutcomeDetail / getOutcomeSummary
-- Fecha: 2026-06-12
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.vera_action_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_action_id   uuid NOT NULL REFERENCES public.vera_pending_actions(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL,
  brand_container_id  uuid,
  action_type         text NOT NULL,

  -- Snapshots temporales de métricas
  measured_at         timestamptz NOT NULL DEFAULT now(),
  measurement_window  text NOT NULL CHECK (measurement_window IN ('24h','7d','30d')),
  baseline_metrics    jsonb,          -- métricas previas a la ejecución
  outcome_metrics     jsonb,          -- métricas posteriores
  delta               jsonb,          -- delta calculado por métrica

  -- Veredicto computado (reglas + math, sin LLM)
  outcome_verdict     text NOT NULL CHECK (outcome_verdict IN ('positive','neutral','negative','inconclusive')),
  outcome_score       numeric(4,3) CHECK (outcome_score BETWEEN -1.0 AND 1.0),
  reasoning           text,           -- explicación generada por template (no LLM)

  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pending_action_id, measurement_window)
);

CREATE INDEX IF NOT EXISTS idx_vao_org ON public.vera_action_outcomes(organization_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_vao_pa  ON public.vera_action_outcomes(pending_action_id);
CREATE INDEX IF NOT EXISTS idx_vao_type ON public.vera_action_outcomes(organization_id, action_type, outcome_verdict);

-- RLS: mismo patrón que el resto del corpus (is_developer / is_org_member).
-- El servicio escribe con service_role (bypassa RLS); usuarios solo leen su org.
ALTER TABLE public.vera_action_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org-scoped outcome read" ON public.vera_action_outcomes;
CREATE POLICY "Org-scoped outcome read"
  ON public.vera_action_outcomes FOR SELECT TO authenticated
  USING (
    is_developer()
    OR is_org_member(organization_id)
  );
