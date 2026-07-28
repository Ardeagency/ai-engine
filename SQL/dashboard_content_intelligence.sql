-- dashboard_content_intelligence — INTELIGENCIA de contenido orgánico para Vera.
-- NO clasifica (nada de tonos/temas — esa lógica murió). Da las métricas REALES
-- de cada post + el contenido crudo + los ratios que revelan el POR QUÉ funciona
-- (retención, intención de guardar, viralidad, poder de conversión a seguidor).
-- Vera lee esto + ve el video/imagen + cruza con Trends, y razona ella el porqué.
create or replace function public.dashboard_content_intelligence(
  p_brand_container_id uuid, p_source text default 'own', p_limit int default 12
) returns jsonb
language plpgsql security definer stable
set search_path to 'public'
as $$
declare v_org uuid; v_out jsonb;
begin
  select organization_id into v_org from brand_containers where id = p_brand_container_id;
  if v_org is null then raise exception 'brand no encontrado' using errcode='P0002'; end if;
  if not (public.is_developer() or public.is_org_member(v_org)) then
    raise exception 'forbidden' using errcode='42501'; end if;

  with p as (
    select id, content, hashtags, network, permalink, captured_at,
           profile_handle, engagement_total, reach_total, media_assets,
           (metrics->>'likes')::numeric likes, (metrics->>'comments')::numeric comments,
           (metrics->>'shares')::numeric shares, coalesce((metrics->>'saves')::numeric,(metrics->>'saved')::numeric) saves,
           (metrics->>'reach')::numeric reach, (metrics->>'impressions')::numeric impressions,
           (metrics->>'plays')::numeric plays, (metrics->>'video_views')::numeric video_views,
           (metrics->>'avg_watch_time_ms')::numeric watch_ms, (metrics->>'video_duration_s')::numeric dur_s,
           (metrics->>'follows')::numeric follows, (metrics->>'profile_visits')::numeric profile_visits,
           (metrics->>'total_interactions')::numeric total_int
    from brand_posts
    where brand_container_id = p_brand_container_id and post_source = p_source
      and engagement_total > 0
  ),
  scored as (
    select *,
      round(saves / nullif(reach,0) * 100, 2)  as save_rate,        -- intención (guardar)
      round(shares / nullif(reach,0) * 100, 2)  as share_rate,       -- viralidad
      round(follows / nullif(reach,0) * 100, 2) as follow_rate,      -- conversión a seguidor
      round(profile_visits / nullif(reach,0) * 100, 2) as visit_rate,-- curiosidad generada
      round(comments / nullif(reach,0) * 100, 2) as comment_rate,    -- conversación
      round((watch_ms/1000.0) / nullif(dur_s,0) * 100, 1) as retention_pct -- retención de video
    from p
  ),
  post_json as (
    select jsonb_build_object(
      'post_id', id, 'caption', left(content, 400), 'hashtags', hashtags, 'red', network,
      'link', permalink, 'fecha', to_char(captured_at,'YYYY-MM-DD'),
      'formato', case when video_views>0 or plays>0 then 'video/reel' else 'imagen/carrusel' end,
      'engagement', engagement_total, 'reach', reach, 'impresiones', impressions,
      'likes', likes, 'comments', comments, 'shares', shares, 'saves', saves,
      'video_views', video_views, 'watch_time_s', round(watch_ms/1000.0,1), 'duracion_s', dur_s,
      'follows', follows, 'profile_visits', profile_visits,
      'ratios', jsonb_build_object('save_rate_%',save_rate,'share_rate_%',share_rate,
        'follow_rate_%',follow_rate,'visit_rate_%',visit_rate,'comment_rate_%',comment_rate,
        'retencion_%',retention_pct)
    ) j, engagement_total, save_rate, share_rate, follow_rate, retention_pct, saves, shares
    from scored
  )
  select jsonb_build_object(
    'resumen', (select jsonb_build_object(
        'posts_con_datos', count(*),
        'engagement_promedio', round(avg(engagement_total)),
        'save_rate_promedio', round(avg(save_rate),2),
        'share_rate_promedio', round(avg(share_rate),2),
        'retencion_promedio', round(avg(retention_pct),1)
      ) from post_json),
    -- El contenido que más rinde por engagement (con TODO para que Vera lo lea y razone)
    'top_engagement', (select coalesce(jsonb_agg(j order by engagement_total desc),'[]'::jsonb)
        from (select * from post_json order by engagement_total desc limit p_limit) t),
    -- Rankings por dimensión: qué genera QUÉ (Vera diagnostica el patrón)
    'lider_intencion',   (select j from post_json where save_rate is not null order by save_rate desc limit 1),
    'lider_viralidad',   (select j from post_json where share_rate is not null order by share_rate desc limit 1),
    'lider_retencion',   (select j from post_json where retention_pct is not null order by retention_pct desc limit 1),
    'lider_crecimiento', (select j from post_json where follow_rate is not null order by follow_rate desc limit 1)
  ) into v_out;
  return v_out;
end;
$$;
grant execute on function public.dashboard_content_intelligence(uuid, text, int) to authenticated;
