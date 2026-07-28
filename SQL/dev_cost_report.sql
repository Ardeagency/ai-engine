-- dev_cost_report(p_days) — calculador de costo REAL para la sección Dev.
-- Agrega credit_usage por función y por org, y compara costo real vs precio de
-- plan (margen). Todo el gasto (Anthropic, Apify, OpenAI, ComfyUI) en un lugar.
-- Solo developers (is_developer).
create or replace function public.dev_cost_report(p_days int default 30)
returns jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare
  v_since timestamptz := now() - make_interval(days => greatest(1, p_days));
  v_by_func jsonb;
  v_by_org  jsonb;
  v_total   numeric;
begin
  if not public.is_developer() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Costo por función (kind → etiqueta legible + proveedor)
  select coalesce(jsonb_agg(row_to_json(t) order by t.usd desc), '[]'::jsonb)
    into v_by_func
  from (
    select
      cu.kind,
      case cu.kind
        when 'claude_tokens'        then 'VERA — sesiones agénticas'
        when 'vera_chat'            then 'VERA — chat'
        when 'vera_dashboard_reading' then 'VERA — dashboard (lectura)'
        when 'vera_brief_generation' then 'VERA — briefs de tendencias'
        when 'visibility_probe'     then 'Sensor de visibilidad IA (GEO)'
        when 'claude_describe'      then 'Descripción de imágenes'
        when 'pattern_llm_classify' then 'Clasificación de posts'
        when 'cmo_brief'            then 'Brief CMO (legacy)'
        when 'apify_scrape'         then 'Scraping (Apify)'
        when 'meta_ads_library_query' then 'Meta Ads Library'
        when 'flow_execution'       then 'Generación de contenido (flows)'
        else cu.kind
      end as label,
      case cu.kind
        when 'claude_tokens' then 'Anthropic' when 'vera_chat' then 'Anthropic'
        when 'vera_brief_generation' then 'Anthropic' when 'visibility_probe' then 'Anthropic'
        when 'vera_dashboard_reading' then 'Anthropic'
        when 'claude_describe' then 'Anthropic/Gemini' when 'pattern_llm_classify' then 'OpenAI'
        when 'cmo_brief' then 'OpenAI' when 'apify_scrape' then 'Apify'
        when 'meta_ads_library_query' then 'Apify' when 'flow_execution' then 'ComfyUI/KIE'
        else 'otro'
      end as provider,
      count(*) as ops,
      round(sum(cu.usd_cost)::numeric, 4) as usd,
      round(avg(cu.usd_cost)::numeric, 5) as usd_avg
    from credit_usage cu
    where cu.created_at >= v_since and cu.usd_cost is not null and cu.usd_cost > 0
    group by cu.kind
  ) t;

  -- Costo por org vs precio del plan (margen)
  select coalesce(jsonb_agg(row_to_json(o) order by o.usd_cost desc), '[]'::jsonb)
    into v_by_org
  from (
    select
      org.id as organization_id,
      org.name as org_name,
      coalesce(pl.name, '—') as plan,
      pl.price_usd_month as plan_price,
      pl.credits_monthly,
      round(sum(cu.usd_cost)::numeric, 4) as usd_cost,
      -- proyección mensual desde el período observado
      round((sum(cu.usd_cost) * 30.0 / greatest(1, p_days))::numeric, 4) as usd_cost_monthly_proj,
      round((coalesce(pl.price_usd_month,0) - sum(cu.usd_cost) * 30.0 / greatest(1, p_days))::numeric, 2) as margin_monthly_proj
    from credit_usage cu
    join organizations org on org.id = cu.organization_id
    left join subscriptions s on s.organization_id = org.id and s.status in ('trial','active','past_due')
    left join plans pl on pl.id = s.plan_id
    where cu.created_at >= v_since and cu.usd_cost is not null and cu.usd_cost > 0
    group by org.id, org.name, pl.name, pl.price_usd_month, pl.credits_monthly
  ) o;

  select round(sum(usd_cost)::numeric, 4) into v_total
  from credit_usage where created_at >= v_since and usd_cost > 0;

  return jsonb_build_object(
    'period_days', p_days,
    'since', v_since,
    'total_usd', coalesce(v_total, 0),
    'by_function', v_by_func,
    'by_org', v_by_org
  );
end;
$$;
grant execute on function public.dev_cost_report(int) to authenticated;
