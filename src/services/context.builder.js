/**
 * Context Builder — ensambla un paquete de contexto seguro para OpenClaw.
 *
 * Solo expone datos org-scoped y nunca incluye tokens ni credenciales.
 * Este objeto es lo que OpenClaw recibe como "visión del mundo" de la organización.
 */
import { supabase } from "../lib/supabase.js";
import {
  getBrandContainers, getIntegrations, getProducts,
  getAudiences, getBrandEntities,
} from "../tools/brand.tools.js";
import { getFlowRuns, getFlowSchedules } from "../tools/flow.tools.js";
import { getCampaigns } from "../tools/campaign.tools.js";
import { getIntelligenceEntities, getTrendTopics } from "../tools/intelligence.tools.js";

function redactIntegration(row) {
  return {
    platform: row.platform ?? null,
    external_account_name: row.external_account_name ?? null,
    is_active: row.is_active ?? null,
    last_sync_at: row.last_sync_at ?? null,
  };
}

/**
 * @param {string} organizationId
 * @param {string|null} brandContainerId  — Si viene en el contexto de conversación
 * @returns {object} Contexto seguro para OpenClaw
 */
export async function buildOrgContext(organizationId, brandContainerId = null) {
  const ctx = {
    organization_id: organizationId,
    brand_containers: [],
    active_brand: null,
    integrations: [],
    recent_flow_runs: [],
    active_schedules: [],
  };

  // Todos los brand_containers de la org
  try {
    ctx.brand_containers = await getBrandContainers(organizationId);
  } catch (e) {
    console.warn("context.builder: getBrandContainers error:", e.message);
  }

  // Si hay un brand_container activo en la conversación, enriquece el contexto
  if (brandContainerId) {
    const { data: bc } = await supabase
      .from("brand_containers")
      .select("id, nombre_marca, mercado_objetivo, idiomas_contenido")
      .eq("id", brandContainerId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (bc) {
      const { data: brand } = await supabase
        .from("brands")
        .select(
          "id, nicho_mercado, arquetipo_personalidad, tono_comunicacion, " +
          "estilo_escritura, palabras_clave, objetivos_marca"
        )
        .eq("project_id", brandContainerId)
        .maybeSingle();

      ctx.active_brand = { ...bc, brand_identity: brand || null };

      try {
        const integrations = await getIntegrations(brandContainerId, organizationId);
        ctx.integrations = integrations.map(redactIntegration);
      } catch (e) {
        console.warn("context.builder: getIntegrations error:", e.message);
      }

      try {
        const schedules = await getFlowSchedules(brandContainerId, organizationId);
        ctx.active_schedules = schedules.filter((s) => s.status === "active");
      } catch (e) {
        console.warn("context.builder: getFlowSchedules error:", e.message);
      }

      try {
        const runs = await getFlowRuns(brandContainerId, organizationId);
        ctx.recent_flow_runs = runs.slice(0, 5);
      } catch (e) {
        console.warn("context.builder: getFlowRuns error:", e.message);
      }
    }
  }

  return ctx;
}

/**
 * Construye el contexto completo de una marca para inyectar en el mensaje de Vera.
 * Incluye productos, servicios, audiencias, campañas, entidades, tendencias y más.
 *
 * @param {string} brandContainerId
 * @param {string} organizationId
 * @returns {object} fullContext con todos los datos de la marca
 */
export async function buildFullBrandContext(brandContainerId, organizationId) {
  if (!brandContainerId) return null;

  // Nombre de la marca
  let brandName = null;
  try {
    const { data: bc } = await supabase
      .from("brand_containers")
      .select("nombre_marca")
      .eq("id", brandContainerId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    brandName = bc?.nombre_marca ?? null;
  } catch (_) { /* non-fatal */ }

  // También buscar servicios directamente
  async function getServices() {
    try {
      const { data } = await supabase
        .from("services")
        .select(
          "nombre_servicio, descripcion_servicio, duracion_estimada, precio_base, moneda, " +
          "beneficios_principales, diferenciadores, casos_de_uso, entregables, " +
          "metodologia_pasos, url_servicio"
        )
        .eq("brand_container_id", brandContainerId)
        .limit(15);
      return data ?? [];
    } catch (_) { return []; }
  }

  // Ejecutar todas las consultas en paralelo
  const [
    products, services, audiences, campaigns,
    entities, intelligenceEntities, trendTopics,
    recentRuns, activeSchedules,
  ] = await Promise.allSettled([
    getProducts(brandContainerId, organizationId).catch(() => []),
    getServices(),
    getAudiences(brandContainerId, organizationId).catch(() => []),
    getCampaigns(brandContainerId, organizationId).catch(() => []),
    getBrandEntities(brandContainerId, organizationId).catch(() => []),
    getIntelligenceEntities(brandContainerId, organizationId).catch(() => []),
    getTrendTopics(brandContainerId, organizationId).catch(() => []),
    getFlowRuns(brandContainerId, organizationId).catch(() => []),
    getFlowSchedules(brandContainerId, organizationId)
      .then((s) => s.filter((x) => x.status === "active"))
      .catch(() => []),
  ]).then((results) => results.map((r) => r.status === "fulfilled" ? r.value : []));

  return {
    brandName,
    products,
    services,
    audiences,
    campaigns,
    entities,
    intelligenceEntities,
    trendTopics,
    recentRuns,
    activeSchedules,
  };
}
