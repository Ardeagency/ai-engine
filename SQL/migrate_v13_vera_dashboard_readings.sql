-- migrate_v13_vera_dashboard_readings.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- REDISEÑO DASHBOARD: VERA como autora de las lecturas del dashboard.
--
-- Tabla nueva donde ai-engine persiste (tras validar contra esquema zod) el
-- JSON de bloques tipados que VERA produce por org+marca+sección. El frontend
-- lo lee DIRECTO vía RPC y solo renderiza — sin analizador intermedio.
--
-- SEGURIDAD (invariante del rediseño):
--   * VERA nunca escribe aquí: INSERT/UPDATE solo via service_role (ai-engine).
--   * RLS: los miembros de la org solo LEEN sus lecturas.
--   * El JSON son BLOQUES TIPADOS, no HTML — el frontend escapa todo texto.
--
-- Ver: ~/Desktop/AI-SMART-CONTENT-ROADMAP/09_REDISENO_DASHBOARD_VERA.md (§4)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tabla principal ────────────────────────────────────────────────────
create table if not exists public.vera_dashboard_readings (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  brand_container_id  uuid not null,
  scope               text not null check (scope in
                        ('mi_marca','monitoreo','tendencias','estrategia')),
  status              text not null default 'published'
                        check (status in ('published','superseded','stale')),
  schema_version      int  not null default 1,

  -- La lectura completa de VERA: {headline, narrative[], evidence{}, meta{}}
  reading             jsonb not null,

  -- Trazabilidad de cómo se construyó
  session_id          uuid not null,
  feed_id             uuid,
  tool_calls_count    int default 0,
  model               text,
  generation_cost_usd numeric(8,4),
  trigger_kind        text default 'manual',   -- manual | cycle | timer | event

  window_start        timestamptz,
  window_end          timestamptz,
  created_at          timestamptz not null default now()
);

-- 1 lectura 'published' por org+marca+sección (las anteriores → superseded)
create unique index if not exists vera_readings_published_uq
  on public.vera_dashboard_readings (organization_id, brand_container_id, scope)
  where status in ('published','stale');

create index if not exists vera_readings_history_ix
  on public.vera_dashboard_readings (brand_container_id, scope, created_at desc);

-- ── 2. RLS: la org solo LEE; escribe únicamente ai-engine (service_role) ──
alter table public.vera_dashboard_readings enable row level security;

drop policy if exists vera_readings_select on public.vera_dashboard_readings;
create policy vera_readings_select on public.vera_dashboard_readings
  for select using (public.is_developer() or public.is_org_member(organization_id));
-- Sin policy de INSERT/UPDATE/DELETE → solo service_role (bypassa RLS) escribe.

-- ── 3. Auditoría de sesiones dashboard ────────────────────────────────────
create table if not exists public.vera_session_audit (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null,
  organization_id     uuid not null,
  brand_container_id  uuid,
  kind                text not null default 'dashboard_reading',
  status              text not null default 'running'
                        check (status in ('running','completed','failed','invalid_output')),
  tool_calls          jsonb default '[]'::jsonb,  -- [{name, ok, ms, at}]
  iterations          int default 0,
  model               text,
  input_chars         bigint default 0,
  output_chars        bigint default 0,
  est_cost_usd        numeric(8,4),
  error_message       text,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz
);

create index if not exists vera_session_audit_org_ix
  on public.vera_session_audit (organization_id, started_at desc);

alter table public.vera_session_audit enable row level security;
drop policy if exists vera_session_audit_select on public.vera_session_audit;
create policy vera_session_audit_select on public.vera_session_audit
  for select using (public.is_developer());

-- ── 4. RPCs para el frontend (renderizado directo, sin analizador) ────────

-- 4.1 Lectura vigente de una sección
create or replace function public.get_vera_reading(
  p_brand_container_id uuid,
  p_scope text
) returns jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare
  v_org uuid;
  v_row record;
begin
  select bc.organization_id into v_org
    from brand_containers bc where bc.id = p_brand_container_id;
  if v_org is null then
    raise exception 'brand_container no encontrado' using errcode = 'P0002';
  end if;
  if not (public.is_developer() or public.is_org_member(v_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select r.id, r.reading, r.status, r.schema_version, r.created_at,
         r.window_start, r.window_end, r.model
    into v_row
    from vera_dashboard_readings r
   where r.brand_container_id = p_brand_container_id
     and r.scope = p_scope
     and r.status in ('published','stale')
   order by r.created_at desc
   limit 1;

  if v_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'reading_id',     v_row.id,
    'reading',        v_row.reading,
    'status',         v_row.status,
    'schema_version', v_row.schema_version,
    'created_at',     v_row.created_at,
    'window_start',   v_row.window_start,
    'window_end',     v_row.window_end,
    'model',          v_row.model
  );
end;
$$;

-- 4.2 Historial de lecturas (deltas / "qué dijo VERA antes")
create or replace function public.get_vera_reading_history(
  p_brand_container_id uuid,
  p_scope text,
  p_limit int default 8
) returns setof jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare
  v_org uuid;
begin
  select bc.organization_id into v_org
    from brand_containers bc where bc.id = p_brand_container_id;
  if v_org is null or not (public.is_developer() or public.is_org_member(v_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select jsonb_build_object(
             'reading_id', r.id,
             'reading',    r.reading,
             'status',     r.status,
             'created_at', r.created_at
           )
      from vera_dashboard_readings r
     where r.brand_container_id = p_brand_container_id
       and r.scope = p_scope
     order by r.created_at desc
     limit least(greatest(p_limit, 1), 50);
end;
$$;

-- 4.3 Resolución de evidencia ("ver la prueba" — click en un ev_ref)
--     La lectura guarda en reading->'evidence' refs {kind, post_id|trend_topic_id|
--     signal_id|url,...}. Esta RPC resuelve el objeto real, scoped por org.
create or replace function public.get_vera_evidence(
  p_reading_id uuid,
  p_evidence_key text
) returns jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare
  v_r   record;
  v_ev  jsonb;
  v_out jsonb;
begin
  select r.organization_id, r.brand_container_id, r.reading
    into v_r
    from vera_dashboard_readings r
   where r.id = p_reading_id;
  if v_r.organization_id is null then
    raise exception 'reading no encontrada' using errcode = 'P0002';
  end if;
  if not (public.is_developer() or public.is_org_member(v_r.organization_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_ev := v_r.reading -> 'evidence' -> p_evidence_key;
  if v_ev is null then
    return null;
  end if;

  case v_ev->>'kind'
    when 'post' then
      select jsonb_build_object('kind','post','post', to_jsonb(bp) - 'media_assets')
        into v_out
        from brand_posts bp
       where bp.id = (v_ev->>'post_id')::uuid
         and bp.organization_id = v_r.organization_id;
    when 'comment' then
      select jsonb_build_object('kind','comment','post', to_jsonb(bp) - 'media_assets',
                                'note', v_ev->>'note')
        into v_out
        from brand_posts bp
       where bp.id = (v_ev->>'post_id')::uuid
         and bp.organization_id = v_r.organization_id;
    when 'trend' then
      select jsonb_build_object('kind','trend','trend', to_jsonb(tt))
        into v_out
        from trend_topics tt
       where tt.id = (v_ev->>'trend_topic_id')::uuid
         and tt.organization_id = v_r.organization_id;
    when 'signal' then
      select jsonb_build_object('kind','signal','signal', to_jsonb(ts))
        into v_out
        from targeted_trend_signals ts
       where ts.id = (v_ev->>'signal_id')::uuid
         and ts.brand_container_id = v_r.brand_container_id;
    when 'web' then
      v_out := jsonb_build_object('kind','web','url', v_ev->>'url',
                                  'title', v_ev->>'title', 'note', v_ev->>'note');
    else
      v_out := jsonb_build_object('kind', coalesce(v_ev->>'kind','unknown'),
                                  'raw', v_ev);
  end case;

  return coalesce(v_out, jsonb_build_object('kind', v_ev->>'kind', 'resolved', false));
end;
$$;

grant execute on function public.get_vera_reading(uuid, text) to authenticated;
grant execute on function public.get_vera_reading_history(uuid, text, int) to authenticated;
grant execute on function public.get_vera_evidence(uuid, text) to authenticated;
