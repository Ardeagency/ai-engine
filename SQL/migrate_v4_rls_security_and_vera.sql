-- ============================================================================
-- MIGRACIÓN v4 — Seguridad RLS + Acceso org-scoped para Vera
-- ============================================================================
-- 
-- SECCIÓN 1: content_flows público para landing page
-- SECCIÓN 2: Corregir 10+ policies peligrosamente abiertas
-- SECCIÓN 3: Agregar acceso org-scoped para Vera (bot en organization_members)
--
-- PREREQUISITO: El bot de Vera debe estar en organization_members con cualquier
-- rol para que is_org_member() retorne true.
--
-- NOTA: Ejecutar con service_role (superuser) en Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECCIÓN 1: content_flows — público para landing page (solo SELECT)
-- ============================================================================

-- Mantener la policy existente para usuarios autenticados (ALL con can_access_flow)
-- y agregar una nueva policy que permita SELECT sin autenticación

CREATE POLICY "Public can view flows for landing"
  ON public.content_flows
  FOR SELECT
  TO anon
  USING (true);

-- ============================================================================
-- SECCIÓN 2: Corregir policies peligrosamente abiertas
-- ============================================================================
-- Tablas afectadas: products, services, brand_entities, brand_colors,
-- brand_fonts, brand_places, brand_profiles, brand_rules, campaign_entities,
-- visual_references
--
-- PROBLEMA: Usaban "is_developer() OR auth.uid() IS NOT NULL" que permite
-- a CUALQUIER usuario ver datos de TODAS las organizaciones.
--
-- FIX: Filtrar por organización vía brand_containers + is_org_member()
-- ============================================================================

-- ── products ──────────────────────────────────────────────────────────────────
-- brand_container_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.products;

CREATE POLICY "Org-scoped product access"
  ON public.products
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = products.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── services ──────────────────────────────────────────────────────────────────
-- brand_container_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.services;

CREATE POLICY "Org-scoped service access"
  ON public.services
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = services.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_entities ────────────────────────────────────────────────────────────
-- brand_container_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_entities;

CREATE POLICY "Org-scoped brand entity access"
  ON public.brand_entities
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_entities.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_colors ──────────────────────────────────────────────────────────────
-- brand_id → brands.id → brands.project_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_colors;

CREATE POLICY "Org-scoped brand color access"
  ON public.brand_colors
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_colors.brand_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_fonts ───────────────────────────────────────────────────────────────
-- brand_id → brands.id → brands.project_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_fonts;

CREATE POLICY "Org-scoped brand font access"
  ON public.brand_fonts
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_fonts.brand_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_places ──────────────────────────────────────────────────────────────
-- brand_container_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_places;

CREATE POLICY "Org-scoped brand place access"
  ON public.brand_places
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_places.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_profiles ────────────────────────────────────────────────────────────
-- brand_id → brands.id → brands.project_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_profiles;

CREATE POLICY "Org-scoped brand profile access"
  ON public.brand_profiles
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_profiles.brand_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_rules ───────────────────────────────────────────────────────────────
-- brand_id → brands.id → brands.project_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.brand_rules;

CREATE POLICY "Org-scoped brand rule access"
  ON public.brand_rules
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_rules.brand_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── campaign_entities ─────────────────────────────────────────────────────────
-- campaign_id → campaigns.brand_container_id → brand_containers.id

DROP POLICY IF EXISTS "Modify brand assets" ON public.campaign_entities;

CREATE POLICY "Org-scoped campaign entity access"
  ON public.campaign_entities
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM campaigns c
      JOIN brand_containers bc ON bc.id = c.brand_container_id
      WHERE c.id = campaign_entities.campaign_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── visual_references ─────────────────────────────────────────────────────────
-- brand_container_id → brand_containers.id (nullable: globales visibles para todos)

DROP POLICY IF EXISTS "Modify brand assets" ON public.visual_references;

CREATE POLICY "Org-scoped visual reference access"
  ON public.visual_references
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR brand_container_id IS NULL
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = visual_references.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── audiences (FIX BUG: comparaba brand_id contra brand_containers.id) ───────
-- brand_id → brands.id (NO brand_containers.id)

-- FIX: la policy anterior comparaba audiences.brand_id (que es brands.id)
-- contra brand_containers.id — UUIDs de tablas diferentes. Bug silencioso.

DROP POLICY IF EXISTS "Unified select assets" ON public.audiences;

CREATE POLICY "Org-scoped audience access"
  ON public.audiences
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = audiences.brand_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ── brand_integrations (eliminar duplicados + agregar org-scoped) ─────────────
-- Nota: la aplicación NUNCA expone access_token, refresh_token ni encryption_iv
-- en las consultas. RLS solo controla acceso a filas, no columnas.

DROP POLICY IF EXISTS "Integraciones visibles solo para dueños de la marca" ON public.brand_integrations;
DROP POLICY IF EXISTS "Users can only see integrations of their brands" ON public.brand_integrations;

CREATE POLICY "Org-scoped integration access"
  ON public.brand_integrations
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_integrations.brand_container_id
      AND (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
    )
  );

-- ============================================================================
-- SECCIÓN 3: Acceso org-scoped para Vera en tablas user-scoped
-- ============================================================================
-- Estas tablas filtraban solo por auth.uid() = user_id. Vera (como bot de la
-- org) necesita verlas para responder preguntas sobre la actividad de la org.
--
-- Patrón: mantener acceso por usuario + agregar OR is_org_member()
-- ============================================================================

-- ── ai_conversations ──────────────────────────────────────────────────────────
-- Tiene organization_id directamente

DROP POLICY IF EXISTS "Users can manage their own conversations" ON public.ai_conversations;

CREATE POLICY "User or org member conversation access"
  ON public.ai_conversations
  FOR ALL
  TO authenticated
  USING (
    auth.uid() = user_id
    OR is_org_member(organization_id)
  );

-- ── ai_messages ───────────────────────────────────────────────────────────────
-- Tiene organization_id directamente

DROP POLICY IF EXISTS "Users can manage messages in their conversations" ON public.ai_messages;

CREATE POLICY "User or org member message access"
  ON public.ai_messages
  FOR ALL
  TO authenticated
  USING (
    is_org_member(organization_id)
    OR EXISTS (
      SELECT 1 FROM ai_conversations c
      WHERE c.id = ai_messages.conversation_id
      AND c.user_id = auth.uid()
    )
  );

-- ── ai_chat_context ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage context in their conversations" ON public.ai_chat_context;

CREATE POLICY "User or org member chat context access"
  ON public.ai_chat_context
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ai_conversations c
      WHERE c.id = ai_chat_context.conversation_id
      AND (c.user_id = auth.uid() OR is_org_member(c.organization_id))
    )
  );

-- ── ai_chat_actions ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view actions in their conversations" ON public.ai_chat_actions;

CREATE POLICY "User or org member chat action access"
  ON public.ai_chat_actions
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ai_messages m
      JOIN ai_conversations c ON c.id = m.conversation_id
      WHERE m.id = ai_chat_actions.message_id
      AND (c.user_id = auth.uid() OR is_org_member(c.organization_id))
    )
  );

-- ── flow_runs ─────────────────────────────────────────────────────────────────
-- brand_id → brands.id → brands.project_id → brand_containers.organization_id

DROP POLICY IF EXISTS "Flow Runs" ON public.flow_runs;

CREATE POLICY "User or org member flow run access"
  ON public.flow_runs
  FOR ALL
  TO authenticated
  USING (
    user_id = auth.uid()
    OR is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = flow_runs.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── flow_schedules ────────────────────────────────────────────────────────────
-- Solo actualizar SELECT (INSERT/DELETE siguen siendo user-only para seguridad)
-- brand_id → brands.id → brands.project_id → brand_containers.organization_id

DROP POLICY IF EXISTS "Users can view their own schedules" ON public.flow_schedules;

CREATE POLICY "User or org member schedule read"
  ON public.flow_schedules
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = flow_schedules.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── system_ai_outputs ─────────────────────────────────────────────────────────
-- Solo actualizar SELECT (INSERT/UPDATE/DELETE siguen siendo user-only)
-- brand_container_id → brand_containers.organization_id

DROP POLICY IF EXISTS "Ver propias producciones del sistema" ON public.system_ai_outputs;

CREATE POLICY "User or org member system output read"
  ON public.system_ai_outputs
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = system_ai_outputs.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── runs_inputs ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Access runs inputs" ON public.runs_inputs;

CREATE POLICY "User or org member run input access"
  ON public.runs_inputs
  FOR ALL
  TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM flow_runs fr
      WHERE fr.id = runs_inputs.run_id
      AND (
        fr.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM brands b
          JOIN brand_containers bc ON bc.id = b.project_id
          WHERE b.id = fr.brand_id
          AND is_org_member(bc.organization_id)
        )
      )
    )
  );

-- ── runs_outputs ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Access runs outputs" ON public.runs_outputs;

CREATE POLICY "User or org member run output access"
  ON public.runs_outputs
  FOR ALL
  TO authenticated
  USING (
    run_id IS NULL
    OR is_developer()
    OR EXISTS (
      SELECT 1 FROM flow_runs fr
      WHERE fr.id = runs_outputs.run_id
      AND (
        fr.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM brands b
          JOIN brand_containers bc ON bc.id = b.project_id
          WHERE b.id = fr.brand_id
          AND is_org_member(bc.organization_id)
        )
      )
    )
  );

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Ejecutar después del COMMIT para verificar que las policies se aplicaron:
--
-- SELECT schemaname, tablename, policyname, cmd, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;
-- ============================================================================
