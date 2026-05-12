-- ============================================================================
-- Migration v6: Acceso org-scoped sin exigir brandContainerId explícito
-- ============================================================================
--
-- PROBLEMA:
--   Las RLS policies de v4 usan el patrón:
--     (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
--   Esto funciona, pero la condición `bc.user_id = auth.uid()` es redundante
--   cuando el usuario ya es miembro de la org (is_org_member lo cubre).
--   Además, dificulta el razonamiento sobre seguridad y genera JOINs más largos.
--
-- SOLUCIÓN:
--   1. Crear función helper `get_org_brand_container(org_id)` que devuelve
--      el primer brand_container_id de una org — permite que el código PL/SQL
--      y las tools resuelvan la marca sin recibirla como parámetro.
--
--   2. Simplificar las RLS policies: el check de propiedad queda únicamente
--      en is_org_member(bc.organization_id). La condición bc.user_id = auth.uid()
--      se elimina porque is_org_member ya incluye ese caso vía organization_members.
--      EXCEPCIÓN: brand_containers sigue verificando user_id para propietarios
--      directos (sin org).
--
-- NOTA: Esta migración NO cambia el schema de las tablas. Solo actualiza
-- funciones y policies. Es idempotente.
-- ============================================================================

BEGIN;

-- ── 1. Helper: get_org_brand_container ────────────────────────────────────────
--
-- Devuelve el id del primer brand_container de una org (por fecha de creación).
-- Uso en código backend: SELECT get_org_brand_container('<org_id>');
-- Uso en policies RLS: get_org_brand_container(auth.jwt() ->> 'organization_id')

CREATE OR REPLACE FUNCTION public.get_org_brand_container(_org_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.brand_containers
  WHERE organization_id = _org_id
  ORDER BY created_at ASC
  LIMIT 1
$$;

COMMENT ON FUNCTION public.get_org_brand_container(uuid) IS
  'Devuelve el brand_container_id primario de una organización.
   Usado por ai-engine para resolver la marca sin recibir el ID como parámetro.';


-- ── 2. Simplificar check de propiedad en tablas con brand_container_id ────────
--
-- Patrón anterior: (bc.user_id = auth.uid() OR is_org_member(bc.organization_id))
-- Patrón nuevo:    is_org_member(bc.organization_id)
--
-- is_org_member() ya verifica:
--   a) usuario real en organization_members
--   b) JWT org-scoped de ai-engine (claim organization_id)
-- Por lo tanto bc.user_id = auth.uid() es redundante para miembros de org.
-- Para usuarios sin org (bc.user_id = auth.uid() pero no en organization_members),
-- se agrega el check explícito solo donde aplica.

-- ── products ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped product access" ON public.products;
CREATE POLICY "Org-scoped product access"
  ON public.products FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = products.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── services ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped service access" ON public.services;
CREATE POLICY "Org-scoped service access"
  ON public.services FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = services.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_entities ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand entity access" ON public.brand_entities;
CREATE POLICY "Org-scoped brand entity access"
  ON public.brand_entities FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_entities.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_colors ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand color access" ON public.brand_colors;
CREATE POLICY "Org-scoped brand color access"
  ON public.brand_colors FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_colors.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_fonts ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand font access" ON public.brand_fonts;
CREATE POLICY "Org-scoped brand font access"
  ON public.brand_fonts FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_fonts.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_places ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand place access" ON public.brand_places;
CREATE POLICY "Org-scoped brand place access"
  ON public.brand_places FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_places.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_profiles ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand profile access" ON public.brand_profiles;
CREATE POLICY "Org-scoped brand profile access"
  ON public.brand_profiles FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_profiles.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_rules ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped brand rule access" ON public.brand_rules;
CREATE POLICY "Org-scoped brand rule access"
  ON public.brand_rules FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = brand_rules.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── campaign_entities ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped campaign entity access" ON public.campaign_entities;
CREATE POLICY "Org-scoped campaign entity access"
  ON public.campaign_entities FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM campaigns c
      JOIN brand_containers bc ON bc.id = c.brand_container_id
      WHERE c.id = campaign_entities.campaign_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── visual_references ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped visual reference access" ON public.visual_references;
CREATE POLICY "Org-scoped visual reference access"
  ON public.visual_references FOR ALL TO authenticated
  USING (
    is_developer()
    OR brand_container_id IS NULL
    OR EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = visual_references.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── audiences ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped audience access" ON public.audiences;
CREATE POLICY "Org-scoped audience access"
  ON public.audiences FOR ALL TO authenticated
  USING (
    is_developer()
    OR EXISTS (
      SELECT 1 FROM brands b
      JOIN brand_containers bc ON bc.id = b.project_id
      WHERE b.id = audiences.brand_id
      AND is_org_member(bc.organization_id)
    )
  );

-- ── brand_integrations ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org-scoped integration access" ON public.brand_integrations;
CREATE POLICY "Org-scoped integration access"
  ON public.brand_integrations FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM brand_containers bc
      WHERE bc.id = brand_integrations.brand_container_id
      AND is_org_member(bc.organization_id)
    )
  );

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Verificar que la función existe:
--   SELECT get_org_brand_container('<org-uuid>');
--
-- Verificar políticas actualizadas:
--   SELECT tablename, policyname, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('products','services','brand_entities','audiences','brand_integrations')
--   ORDER BY tablename;
-- ============================================================================
