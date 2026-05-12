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

  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select(
      "id, nicho_mercado, arquetipo_personalidad, tono_comunicacion, estilo_escritura, " +
      "palabras_clave, palabras_prohibidas, objetivos_marca, enfoque_marca"
    )
    .eq("project_id", bc.id)
    .maybeSingle();
  if (brandErr) throw brandErr;

  return { brand_container: bc, brand: brand || null };
}

export async function getAudiences(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data: brands } = await supabase
    .from("brands")
    .select("id")
    .eq("project_id", bc.id);

  const brandIds = (brands || []).map((b) => b.id);
  if (!brandIds.length) return [];

  const { data, error } = await supabase
    .from("audiences")
    .select("id, name, description, awareness_level, dolores, deseos, estilo_lenguaje")
    .in("brand_id", brandIds);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getBrandEntities(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("brand_entities")
    .select("id, entity_type, name, description, price, currency")
    .eq("brand_container_id", bc.id);

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
    .eq("brand_container_id", bc.id)
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

  // 2. Obtener brand_ids de tabla brands (intermedia) para audiences
  const { data: brandRows } = await supabase
    .from("brands")
    .select("id")
    .in("project_id", brandIds);
  const innerBrandIds = (brandRows || []).map((b) => b.id);

  // 3. Conteos en paralelo
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
    innerBrandIds.length
      ? supabase.from("audiences").select("id", { count: "exact", head: true }).in("brand_id", innerBrandIds)
      : Promise.resolve({ count: 0 }),
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
