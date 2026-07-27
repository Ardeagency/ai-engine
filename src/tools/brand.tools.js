/**
 * Herramientas de lectura de datos de marca.
 * TODAS las consultas están org-scoped.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 * NUNCA expone: access_token, refresh_token, encryption_iv.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

export async function getBrandContainers(organizationId) {
  const { data, error } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca, mercado_objetivo, idiomas_contenido, created_at")
    .eq("organization_id", organizationId);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getBrandProfile(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  // El ADN vive directo en brand_containers (la tabla "brands" legacy ya no existe).
  // resolveBrandContainer solo trae { id, nombre_marca } — hacemos una segunda query
  // para traer todos los campos del ADN.
  const { data: dna, error } = await supabase
    .from("brand_containers")
    .select(
      "id, nombre_marca, mercado_objetivo, idiomas_contenido, " +
      "nicho_core, sub_nichos, arquetipo, propuesta_valor, mision_vision, " +
      "verbal_dna, visual_dna, palabras_clave, palabras_prohibidas, objetivos_estrategicos"
    )
    .eq("id", bc.id)
    .maybeSingle();
  if (error) throw error;

  return { brand_container: dna || bc, brand: null };
}

export async function getAudiences(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  // audience_personas apunta directo a brand_container_id (sin tabla brands intermedia).
  // real_age_distribution / real_gender_distribution los escribe el sensor
  // meta_audience_demographics y son el ÚNICO origen de la card "audiencia"
  // (mapa + pirámide) del dashboard. Sin ellas Vera pedía el dato, no lo veía y
  // omitía la card — obedeciendo bien el prompt sobre una plataforma que la
  // dejaba ciega. No se omiten aunque vengan vacías: que Vera sepa que no hay.
  // is_featured / is_liked / is_active son el ENFOQUE DE AUDIENCIAS que la
  // organizacion ya declaro: cuales eligio destacar y cuales sigue trabajando.
  // Sin ellas Vera recomendaba audiencias sueltas, sin saber a cuales apunta el
  // negocio — y una recomendacion que ignora el plan del cliente no sirve.
  // gatillos_compra / objeciones / psicograficos son el porque de cada una.
  const { data, error } = await supabase
    .from("audience_personas")
    .select(
      "id, name, description, awareness_level, dolores, deseos, estilo_lenguaje, " +
      "objeciones, gatillos_compra, datos_psicograficos, " +
      "target_age_min, target_age_max, target_genders, " +
      "is_featured, is_liked, is_active, " +
      "real_age_distribution, real_gender_distribution, real_location_distribution, real_interests"
    )
    .eq("brand_container_id", bc.id);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getBrandEntities(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("brand_entities")
    .select("id, entity_type, name, description, price, currency")
    .eq("organization_id", organizationId);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getProducts(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("products")
    .select(
      "id, nombre_producto, descripcion_producto, precio_producto, moneda, " +
      "beneficios_principales, diferenciadores, casos_de_uso"
    )
    .eq("organization_id", organizationId)
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * Integraciones redactadas: NUNCA incluye access_token, refresh_token ni encryption_iv.
 */
export async function getIntegrations(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("brand_integrations")
    .select("id, platform, external_account_name, is_active, last_sync_at, scope")
    .eq("brand_container_id", bc.id);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * getOrgOverview — resumen ejecutivo de todo lo que existe en la organización.
 *
 * Devuelve conteos reales de cada entidad sin necesitar llamar múltiples tools.
 * Ideal para que Vera entienda el estado de la org antes de hacer cualquier tarea.
 */
export async function getOrgOverview(organizationId) {
  if (!organizationId) throw new Error("organizationId requerido");

  // 1. Marcas
  const { data: brands } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca, created_at")
    .eq("organization_id", organizationId);

  const brandList = brands || [];
  const brandIds  = brandList.map((b) => b.id);

  if (!brandIds.length) {
    return {
      organization_id: organizationId,
      brands: [],
      totals: { brands: 0 },
      message: "La organización no tiene marcas configuradas todavía.",
    };
  }

  // 2. Conteos en paralelo (audience_personas apunta directo a brand_container_id)
  const [
    { count: productsCount },
    { count: audiencesCount },
    { count: entitiesCount },
    { count: campaignsCount },
    { count: integrationsCount },
    { count: flowRunsCount },
    { count: schedulesCount },
    { data: integrationsList },
  ] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }).in("brand_container_id", brandIds),
    supabase.from("audience_personas").select("id", { count: "exact", head: true }).in("brand_container_id", brandIds),
    supabase.from("brand_entities").select("id", { count: "exact", head: true }).in("brand_container_id", brandIds),
    supabase.from("campaigns").select("id", { count: "exact", head: true }).in("brand_container_id", brandIds),
    supabase.from("brand_integrations").select("id", { count: "exact", head: true })
      .in("brand_container_id", brandIds).eq("is_active", true),
    supabase.from("flow_runs").select("id", { count: "exact", head: true }).in("brand_container_id", brandIds),
    supabase.from("flow_schedules").select("id", { count: "exact", head: true })
      .in("brand_container_id", brandIds).eq("is_active", true),
    supabase.from("brand_integrations")
      .select("platform, is_active, external_account_name")
      .in("brand_container_id", brandIds),
  ]);

  // 4. Resumen por marca
  const brandSummaries = await Promise.all(
    brandList.map(async (bc) => {
      const [{ count: pCount }, { count: cCount }, { count: iCount }] = await Promise.all([
        supabase.from("products").select("id", { count: "exact", head: true }).eq("brand_container_id", bc.id),
        supabase.from("campaigns").select("id", { count: "exact", head: true }).eq("brand_container_id", bc.id),
        supabase.from("brand_integrations").select("id", { count: "exact", head: true })
          .eq("brand_container_id", bc.id).eq("is_active", true),
      ]);
      return {
        name:                bc.nombre_marca,
        products_count:      pCount || 0,
        campaigns_count:     cCount || 0,
        integrations_count:  iCount || 0,
      };
    })
  );

  return {
    organization_id: organizationId,
    brands: brandSummaries,
    totals: {
      brands:           brandIds.length,
      products:         productsCount    || 0,
      audiences:        audiencesCount   || 0,
      entities:         entitiesCount    || 0,
      campaigns:        campaignsCount   || 0,
      integrations:     integrationsCount || 0,
      flow_runs:        flowRunsCount    || 0,
      schedules_active: schedulesCount   || 0,
    },
    integrations: (integrationsList || []).map((i) => ({
      platform: i.platform,
      account:  i.external_account_name || "Sin nombre",
      active:   i.is_active,
    })),
    data_model_reference: "Ver DATA_MODEL.md para descripción completa de cada entidad.",
  };
}

/**
 * getDataHorizon — desde cuando la plataforma OBSERVA cada fuente.
 *
 * Nace de un error real (2026-07-27): Vera escribio "la pauta lleva mas de un
 * año apagada" cuando habia 5,6M COP gastados ESE MES. Lo que pasaba es que los
 * datos de pauta empiezan el 2 de julio de 2026 — no porque la marca no pautara
 * antes, sino porque la plataforma empezo a mirar ese dia. Sin saber donde
 * empieza su propia vista, quien analiza confunde "no lo tengo" con "no paso",
 * y rellena el hueco con una historia que suena verdadera.
 *
 * Devuelve, por fuente: desde cuando hay dato, hasta cuando, y cuantas filas.
 * La regla de lectura va incluida en la respuesta para que viaje con el dato.
 */
export async function getDataHorizon(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const rango = async (tabla, campoFecha, filtros = {}) => {
    let q = supabase.from(tabla).select(campoFecha, { count: "exact" }).eq("brand_container_id", bc.id);
    for (const [k, v] of Object.entries(filtros)) q = q.eq(k, v);
    const [asc, desc] = await Promise.all([
      q.order(campoFecha, { ascending: true }).limit(1),
      supabase.from(tabla).select(campoFecha).eq("brand_container_id", bc.id)
        .match(filtros).order(campoFecha, { ascending: false }).limit(1),
    ]);
    const desde = asc?.data?.[0]?.[campoFecha] || null;
    const hasta = desc?.data?.[0]?.[campoFecha] || null;
    return {
      desde: desde ? String(desde).slice(0, 10) : null,
      hasta: hasta ? String(hasta).slice(0, 10) : null,
      filas: asc?.count ?? 0,
    };
  };

  const [propios, monitoreados, pauta, campanas] = await Promise.all([
    rango("brand_posts", "captured_at", { post_source: "own" }),
    rango("brand_posts", "captured_at", { post_source: "competitor" }),
    rango("ad_insights_daily", "date"),
    rango("campaigns", "created_at"),
  ]);

  return {
    publicaciones_propias: propios,
    publicaciones_monitoreadas: monitoreados,
    gasto_de_pauta: pauta,
    campanas_registradas: campanas,
    como_leerlo:
      "Estas fechas son desde cuando la PLATAFORMA observa cada fuente, no desde " +
      "cuando existe la marca. Que no haya dato antes de una fecha NO significa que " +
      "no pasara nada: significa que no lo tienes. Nunca afirmes que algo estuvo " +
      "apagado, detenido o ausente en un periodo que cae fuera de tu horizonte.",
  };
}
