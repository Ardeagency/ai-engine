-- ============================================================================
-- Migration v5: JWT Claims + Level of Autonomy
-- ============================================================================
-- 
-- 1. Actualiza is_org_member() para aceptar JWT org-scoped generados por ai-engine.
--    Esto permite que Vera opere bajo RLS sin crear usuarios reales en Supabase Auth.
--
-- 2. Agrega el tipo y valor por defecto para level_of_autonomy (si no existe).
--
-- Opción A — JWT custom:
--   ai-engine genera un JWT con { organization_id: "uuid", role: "authenticated" }
--   firmado con el JWT_SECRET de Supabase.
--   Las RLS policies usan is_org_member() que ahora acepta estos claims.
-- ============================================================================

BEGIN;

-- ── 1. Actualizar is_org_member() ─────────────────────────────────────────────
--
-- La función ahora acepta DOS formas de autenticación:
--   a) Usuario real: user_id = auth.uid() en organization_members (comportamiento anterior)
--   b) JWT org-scoped: (auth.jwt() ->> 'organization_id')::uuid = org_id (nuevo)
--
-- Esto hace que TODAS las RLS policies que usan is_org_member() automáticamente
-- acepten los JWTs generados por ai-engine — sin tocar ninguna policy individual.

CREATE OR REPLACE FUNCTION public.is_org_member(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Forma a: usuario real en organization_members (comportamiento anterior)
    EXISTS (
      SELECT 1
      FROM public.organization_members
      WHERE user_id = auth.uid()
        AND organization_id = _org_id
    )
    OR
    -- Forma b: JWT org-scoped generado por ai-engine (nuevo)
    (auth.jwt() ->> 'organization_id')::uuid = _org_id
$$;

COMMENT ON FUNCTION public.is_org_member(uuid) IS
  'Retorna true si el usuario actual es miembro de la org (vía organization_members o JWT claim).
   Soporta JWTs org-scoped generados por ai-engine (Opción A).';


-- ── 2. Level of autonomy — asegurar tipo y default ───────────────────────────
--
-- Si la columna ya existe, estas instrucciones son idempotentes.
-- Si no existe, las añadimos aquí también.

DO $$
BEGIN
  -- Crear tipo enum si no existe
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'autonomy_level') THEN
    CREATE TYPE public.autonomy_level AS ENUM ('restringido', 'parcial', 'total');
    RAISE NOTICE 'Tipo autonomy_level creado.';
  ELSE
    RAISE NOTICE 'Tipo autonomy_level ya existe.';
  END IF;
END $$;

-- Agregar columna si no existe (con default restringido)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'organizations'
      AND column_name  = 'level_of_autonomy'
  ) THEN
    ALTER TABLE public.organizations
      ADD COLUMN level_of_autonomy public.autonomy_level NOT NULL DEFAULT 'restringido';
    RAISE NOTICE 'Columna level_of_autonomy añadida.';
  ELSE
    -- Si ya existe como text o sin default, actualizamos el default
    ALTER TABLE public.organizations
      ALTER COLUMN level_of_autonomy SET DEFAULT 'restringido';
    RAISE NOTICE 'Columna level_of_autonomy ya existe — default actualizado.';
  END IF;
END $$;

COMMENT ON COLUMN public.organizations.level_of_autonomy IS
  'Nivel de autonomía de la IA para esta organización.
   restringido: solo lectura básica, sin acciones.
   parcial: lectura amplia + preparar contenido, requiere aprobación humana.
   total: operación autónoma completa dentro de los límites de crédito.';


-- ── 3. RLS policy para is_org_member con JWT — verificación ──────────────────
--
-- No necesitamos crear nuevas policies — las existentes que usan is_org_member()
-- ya funcionarán con el JWT. Solo verificamos que la función esté ok.

-- Test rápido de que la función existe y es callable:
DO $$
DECLARE
  _test boolean;
BEGIN
  -- Llamada dummy (no autenticada → siempre false, solo verificamos que compile)
  SELECT public.is_org_member('00000000-0000-0000-0000-000000000000'::uuid) INTO _test;
  RAISE NOTICE 'is_org_member() verificada — retornó: %', _test;
END $$;


-- ── 4. Índice para level_of_autonomy (queries de admin) ──────────────────────

CREATE INDEX IF NOT EXISTS idx_organizations_autonomy_level
  ON public.organizations (level_of_autonomy);

COMMIT;

-- ============================================================================
-- Instrucciones post-migración:
-- ============================================================================
--
-- 1. Agregar en /root/ai-engine/.env:
--    SUPABASE_JWT_SECRET=<tu JWT secret de Supabase>
--    (Supabase Dashboard → Project Settings → API → JWT Settings → JWT Secret)
--
-- 2. La función is_org_member() ahora acepta dos formas:
--    a) Usuarios reales en organization_members (sin cambios)
--    b) JWTs firmados por ai-engine con claim organization_id
--
-- 3. Para probar:
--    SELECT public.is_org_member('<org-uuid>');
--    -- Debe retornar false cuando no hay auth, true cuando el JWT es válido.
-- ============================================================================
