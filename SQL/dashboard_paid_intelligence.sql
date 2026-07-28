-- dashboard_paid_intelligence — INTELIGENCIA COMPLETA de campañas pagas.
-- Vera ve TODO (JC 2026-07-16): todas las métricas de cada campaña + el desglose
-- de acciones de Meta (post_engagement, video_view, link_click, purchase...),
-- para analizar y diagnosticar. No un resumen curado — el panorama completo.
create or replace function public.dashboard_paid_intelligence(p_brand_container_id uuid)
returns jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare
  v_org uuid; v_out jsonb;
begin
  select organization_id into v_org from brand_containers where id = p_brand_container_id;
  if v_org is null then raise exception 'brand no encontrado' using errcode='P0002'; end if;
  if not (public.is_developer() or public.is_org_member(v_org)) then
    raise exception 'forbidden' using errcode='42501'; end if;

  with ins as (  -- métricas diarias por campaña (todas las columnas + actions de Meta)
    select campaign_id, external_ad_id, external_adset_id,
           impressions, reach, clicks, unique_clicks, spend, conversions,
           conversion_value, ctr, cpc, cpm, roas, raw_payload
    from ad_insights_daily where brand_container_id = p_brand_container_id
  ),
  acts as (  -- desglose de acciones de Meta desanidado (post_engagement, video_view, link_click, purchase...)
    select i.campaign_id, a->>'action_type' as action_type, sum((a->>'value')::numeric) as val
    from ins i, lateral jsonb_array_elements(coalesce(i.raw_payload->'actions','[]'::jsonb)) a
    group by 1,2
  ),
  camp_metrics as (  -- TODAS las métricas agregadas por campaña
    select c.id, c.nombre_campana, c.platform, c.platform_objective, c.status,
           c.budget_daily, c.budget_total, c.cta,
           coalesce(sum(i.impressions),0) impressions, coalesce(sum(i.reach),0) reach,
           coalesce(sum(i.clicks),0) clicks, coalesce(sum(i.unique_clicks),0) unique_clicks,
           round(coalesce(sum(i.spend),0),0) spend, coalesce(sum(i.conversions),0) conversions,
           round(coalesce(sum(i.conversion_value),0),0) conversion_value,
           round(avg(nullif(i.ctr,0))::numeric,3) ctr, round(avg(nullif(i.cpc,0))::numeric,2) cpc,
           round(avg(nullif(i.cpm,0))::numeric,0) cpm, round(avg(nullif(i.roas,0))::numeric,2) roas,
           round((coalesce(sum(i.impressions),0)::numeric / nullif(sum(i.reach),0)),2) frequency,
           round((coalesce(sum(i.clicks),0)::numeric / nullif(sum(i.impressions),0) * 100),2) ctr_calc,
           round((coalesce(sum(i.conversions),0)::numeric / nullif(sum(i.clicks),0) * 100),2) cvr
    from campaigns c
    left join ins i on i.campaign_id = c.id
    where c.brand_container_id = p_brand_container_id
    group by c.id, c.nombre_campana, c.platform, c.platform_objective, c.status, c.budget_daily, c.budget_total, c.cta
  ),
  camp_full as (  -- cada campaña con TODAS sus métricas + su desglose de acciones
    select cm.*, coalesce((
        select jsonb_object_agg(a.action_type, a.val) from acts a
        where a.campaign_id = cm.id
      ), '{}'::jsonb) as acciones
    from camp_metrics cm
  ),
  ads as (
    select external_ad_id, round(sum(spend),0) spend, sum(clicks) clicks, sum(conversions) conv,
           round(avg(nullif(ctr,0))::numeric,3) ctr, round(avg(nullif(cpc,0))::numeric,2) cpc,
           round(avg(nullif(roas,0))::numeric,2) roas
    from ins group by external_ad_id
  )
  select jsonb_build_object(
    'resumen', (select jsonb_build_object(
        'campanas_total', count(*), 'activas', count(*) filter (where status='active'),
        'gasto_total', sum(spend), 'impresiones_total', sum(impressions), 'reach_total', sum(reach),
        'clicks_total', sum(clicks), 'conversiones_total', sum(conversions),
        'valor_conversiones_total', sum(conversion_value),
        'roas_ponderado', round(sum(roas*spend) filter (where roas is not null)/nullif(sum(spend) filter (where roas is not null),0),2),
        'ctr_promedio', round(avg(nullif(ctr,0)),2), 'cpc_promedio', round(avg(nullif(cpc,0)),2)
      ) from camp_full),
    'por_objetivo', (select coalesce(jsonb_object_agg(platform_objective, o),'{}'::jsonb) from (
        select platform_objective, jsonb_build_object('campanas',count(*),'gasto',sum(spend),'conv',sum(conversions),'ctr_prom',round(avg(nullif(ctr,0)),2),'roas_prom',round(avg(nullif(roas,0)),2)) o
        from camp_full where platform_objective is not null group by platform_objective) t),
    -- CADA campaña (activas + top 12 por gasto) con TODAS sus métricas + acciones
    'campanas', (select coalesce(jsonb_agg(row_to_json(cf) order by cf.spend desc),'[]'::jsonb)
        from (select * from camp_full where status='active' or spend>0 order by spend desc limit 15) cf),
    'ranking', jsonb_build_object(
      'mejor_roas', (select jsonb_build_object('campana',nombre_campana,'roas',roas,'conv',conversions,'gasto',spend) from camp_full where roas is not null order by roas desc limit 1),
      'mejor_ctr',  (select jsonb_build_object('campana',nombre_campana,'ctr',ctr,'objetivo',platform_objective) from camp_full where ctr is not null order by ctr desc limit 1),
      'mejor_cvr',  (select jsonb_build_object('campana',nombre_campana,'cvr',cvr,'conv',conversions) from camp_full where cvr is not null order by cvr desc limit 1),
      'mejor_anuncio_ctr', (select jsonb_build_object('ad_id',external_ad_id,'ctr',ctr,'cpc',cpc,'conv',conv,'spend',spend) from ads where ctr is not null order by ctr desc limit 1),
      'anuncio_mas_barato_bueno', (select jsonb_build_object('ad_id',external_ad_id,'cpc',cpc,'ctr',ctr,'conv',conv) from ads where cpc is not null and ctr>=2 order by cpc asc limit 1)
    ),
    'demografia_que_convierte', (select real_demographics from campaigns
        where brand_container_id=p_brand_container_id and real_demographics is not null
          and (real_demographics->'gender') <> '{}'::jsonb order by cached_roas desc nulls last limit 1)
  ) into v_out;
  return v_out;
end;
$$;
grant execute on function public.dashboard_paid_intelligence(uuid) to authenticated;
