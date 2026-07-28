/**
 * Herramientas de lectura de campañas.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

/**
 * Campanas de la marca. Las ACTIVAS van SIEMPRE, completas; las pausadas se
 * recortan.
 *
 * EL FALLO QUE ARREGLA (WAKEUP, 2026-07-28): ordenaba por created_at y cortaba
 * en 20. Con 104 pausadas y 2 activas, esas 20 salian TODAS pausadas y las
 * activas quedaban fuera de la ventana. Vera escribio "sin pauta activa, todas
 * las campanas son de 2023 y estan en pausa" mientras la card de al lado del
 * tablero mostraba las 2 activas con 5.221.798 de gasto y ROAS 10.6x. No fue
 * invencion suya: la tool no se las enseno.
 *
 * Tampoco devolvia cached_spend ni cached_roas, asi que ni con la campana
 * delante podia saber si habia dinero corriendo.
 */
export async function getCampaigns(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const COLS =
    "id, nombre_campana, external_campaign_name, descripcion_interna, platform, " +
    "platform_objective, status, cta, cta_url, starts_at, ends_at, created_at, " +
    "budget_daily, budget_total, budget_currency, " +
    "cached_spend, cached_roas, cached_ctr, cached_clicks, cached_conversions, cached_impressions";

  // Las activas NUNCA se recortan: son las que dicen si hay pauta corriendo.
  const { data: activas, error: e1 } = await supabase
    .from("campaigns").select(COLS)
    .eq("brand_container_id", bc.id).eq("status", "active")
    .order("cached_spend", { ascending: false, nullsFirst: false });
  if (e1) throw e1;

  const { data: resto, error: e2 } = await supabase
    .from("campaigns").select(COLS)
    .eq("brand_container_id", bc.id).neq("status", "active")
    .order("created_at", { ascending: false })
    .limit(20);
  if (e2) throw e2;

  const { count: total } = await supabase
    .from("campaigns").select("id", { count: "exact", head: true })
    .eq("brand_container_id", bc.id);

  const lista = [...(activas || []), ...(resto || [])];
  // El resumen va DELANTE para que no haya que contar filas: la afirmacion
  // "no hay pauta activa" tiene que chocar con un numero, no con una lista larga.
  lista.resumen = {
    activas: (activas || []).length,
    total_registradas: total ?? lista.length,
    no_activas_mostradas: (resto || []).length,
    gasto_de_las_activas: (activas || []).reduce((a, c) => a + (Number(c.cached_spend) || 0), 0),
    nota: (activas || []).length
      ? `HAY ${(activas || []).length} campana(s) ACTIVA(S). No digas que la pauta esta apagada.`
      : "ninguna campana en estado active — pero comprueba el gasto real antes de afirmar que no hay pauta",
  };
  return lista;
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
