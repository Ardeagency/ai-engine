/**
 * Herramientas de lectura de campañas.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

export async function getCampaigns(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("campaigns")
    .select(
      "id, nombre_campana, descripcion_interna, platform_objective, status, " +
      "cta, cta_url, starts_at, ends_at, created_at"
    )
    .eq("brand_container_id", bc.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getCampaignDetail(campaignId, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("campaigns")
    .select(
      "id, nombre_campana, descripcion_interna, platform_objective, status, " +
      "cta, cta_url, starts_at, ends_at, budget_total, budget_currency, " +
      "cached_roas, cached_spend, persona_id, created_at"
    )
    .eq("id", campaignId)
    .eq("brand_container_id", bc.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error("Campaña no encontrada"), { statusCode: 404 });
  }
  return data;
}

/**
 * getAdsBreakdown — el desglose de la pauta que faltaba.
 *
 * Hasta el 2026-07-27 lo unico que Vera podia leer de medios pagados era el
 * resumen por campana (getPaidIntelligence) y las metricas en vivo. No podia
 * bajar al ANUNCIO ni al AD SET, ni ver la evolucion por dia, ni la frecuencia
 * —y sin frecuencia no se puede diagnosticar desgaste creativo, que es de lo
 * primero que mira quien compra medios. El dato estaba en `ad_insights_daily`
 * (por anuncio, por adset y por dia) y ninguna tool lo exponia.
 *
 * FRECUENCIA = impresiones / alcance. No viene en la tabla: se calcula aqui.
 * Por encima de ~3 la misma gente esta viendo el mismo anuncio demasiadas veces
 * y el rendimiento suele caer: es señal de rotar creativo, no de subir puja.
 *
 * @param {object} p
 * @param {'ad'|'adset'|'day'|'campaign'} [p.groupBy='ad']
 * @param {number} [p.days=30]   ventana hacia atras
 * @param {number} [p.limit=20]
 */
export async function getAdsBreakdown({ brandContainerId, organizationId, groupBy = "ad", days = 30, limit = 20 }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const ventana = Math.min(365, Math.max(1, Number(days) || 30));
  const tope = Math.min(100, Math.max(1, Number(limit) || 20));
  const desde = new Date(Date.now() - ventana * 86400000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("ad_insights_daily")
    .select(
      "platform, date, campaign_id, external_ad_id, external_adset_id, " +
      "impressions, reach, clicks, unique_clicks, spend, conversions, conversion_value"
    )
    .eq("brand_container_id", bc.id)
    .gte("date", desde);
  if (error) throw error;
  if (!data?.length) {
    return { ventana_dias: ventana, agrupado_por: groupBy, filas: [], nota: "sin datos de pauta en la ventana" };
  }

  const clave = {
    ad: (r) => r.external_ad_id || "(sin anuncio)",
    adset: (r) => r.external_adset_id || "(sin adset)",
    day: (r) => r.date,
    campaign: (r) => r.campaign_id || "(sin campana)",
  }[groupBy] || ((r) => r.external_ad_id);

  const acc = new Map();
  for (const r of data) {
    const k = clave(r);
    const a = acc.get(k) || {
      id: k, dias: new Set(), impresiones: 0, alcance: 0, clics: 0,
      gasto: 0, conversiones: 0, valor_conversiones: 0,
    };
    a.dias.add(r.date);
    a.impresiones += Number(r.impressions) || 0;
    a.alcance += Number(r.reach) || 0;
    a.clics += Number(r.clicks) || 0;
    a.gasto += Number(r.spend) || 0;
    a.conversiones += Number(r.conversions) || 0;
    a.valor_conversiones += Number(r.conversion_value) || 0;
    acc.set(k, a);
  }

  const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const filas = [...acc.values()].map((a) => {
    // El alcance se suma por dia, asi que es un techo: la frecuencia real es
    // >= a esta. Se declara para que nadie la lea como exacta.
    const frecuencia = a.alcance > 0 ? a.impresiones / a.alcance : null;
    return {
      id: a.id,
      dias_activo: a.dias.size,
      gasto: n2(a.gasto),
      impresiones: a.impresiones,
      alcance: a.alcance,
      clics: a.clics,
      ctr: a.impresiones ? n2((a.clics / a.impresiones) * 100) : null,
      cpc: a.clics ? n2(a.gasto / a.clics) : null,
      cpm: a.impresiones ? n2((a.gasto / a.impresiones) * 1000) : null,
      conversiones: a.conversiones,
      cpa: a.conversiones ? n2(a.gasto / a.conversiones) : null,
      roas: a.gasto ? n2(a.valor_conversiones / a.gasto) : null,
      frecuencia_aprox: frecuencia == null ? null : n2(frecuencia),
      desgaste: frecuencia == null ? null : frecuencia >= 3 ? "alto — rotar creativo" : frecuencia >= 2 ? "vigilar" : "sano",
    };
  }).sort((x, y) => y.gasto - x.gasto).slice(0, tope);

  const total = filas.reduce((s, f) => s + f.gasto, 0);
  return {
    ventana_dias: ventana,
    agrupado_por: groupBy,
    plataformas: [...new Set(data.map((r) => r.platform))],
    gasto_en_la_ventana: n2(total),
    concentracion: filas.length && total
      ? `el ${n2((filas[0].gasto / total) * 100)}% del gasto esta en "${filas[0].id}"`
      : null,
    filas,
    nota_frecuencia: "frecuencia_aprox = impresiones/alcance sumando dias; el alcance diario se solapa, asi que es un PISO, no el dato exacto de Meta",
  };
}
