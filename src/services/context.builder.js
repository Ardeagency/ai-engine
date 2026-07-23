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
      .select("id, nombre_marca, mercado_objetivo, idiomas_contenido, nicho_core, sub_nichos, arquetipo, propuesta_valor, creative_brief, verbal_dna, visual_dna, palabras_clave, palabras_prohibidas, objetivos_estrategicos")
      .eq("id", brandContainerId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (bc) {
      // Shape legacy (consumidores aun pueden esperar brand_identity).
      const brand_identity = {
        nicho_mercado:          bc.nicho_core || null,
        arquetipo_personalidad: bc.arquetipo  || null,
        tono_comunicacion:      bc.verbal_dna?.tono   || null,
        estilo_escritura:       bc.verbal_dna?.estilo || null,
        palabras_clave:         bc.palabras_clave || [],
        objetivos_marca:        bc.objetivos_estrategicos || null,
      };

      // ── Reduccion creativa para prompts del LLM generador ────────────
      // Antes pasabamos verbal_dna+visual_dna+palabras_clave crudos al prompt:
      // el LLM tomaba todo literal (verbo_rotacion_pool entero como copy,
      // sub_nichos como nombres de variantes, default_scene_anchor blueprint
      // exacto). Los frames salian todos identicos.
      //
      // Ahora separamos en 3 buckets:
      //   creative_brief    — sintesis corta (~280 chars) que VA al system
      //                       prompt como inspiracion principal
      //   hard_constraints  — reglas duras inviolables (paleta, never list,
      //                       prohibido, formato estricto). VAN al system
      //                       prompt como REGLAS
      //   soft_inspiration  — contexto creativo (tono, manifesto, signature).
      //                       VA marcado como "contexto, no instruccion"
      //
      // Los campos crudos (verbal_dna, visual_dna completos) siguen en bc
      // para herramientas que los necesiten explicitamente (vera-brain-feed,
      // brand-indexer). Pero NO se inyectan crudos en system prompts.

      const briefFallback = (bc.propuesta_valor || '').trim().slice(0, 280) || null;
      const creativeBrief = (bc.creative_brief || '').trim() || briefFallback;

      const vDna = bc.verbal_dna || {};
      const visDna = bc.visual_dna || {};

      const hard_constraints = {
        paleta:               visDna.paleta || null,
        never:                Array.isArray(visDna.never) ? visDna.never : [],
        palabras_prohibidas:  Array.isArray(bc.palabras_prohibidas) ? bc.palabras_prohibidas : [],
        formato:              vDna.formato || null,
        tipografia_prohibido: visDna.tipografia?.prohibido || null,
      };

      const soft_inspiration = {
        tono:               Array.isArray(vDna.tono) ? vDna.tono : [],
        pilares:            Array.isArray(vDna.pilares) ? vDna.pilares : [],
        manifiesto:         vDna.manifiesto_core || null,
        tagline:            vDna.tagline || null,
        verbos_inspiracion: Array.isArray(vDna.verbos_inspiracion || vDna.verbo_rotacion_pool)
          ? (vDna.verbos_inspiracion || vDna.verbo_rotacion_pool).slice(0, 6)
          : [],
        estetica:           visDna.estetica || null,
        preferred_moods:    Array.isArray(visDna.preferred_moods || visDna.trend_compatibility?.preferred)
          ? (visDna.preferred_moods || visDna.trend_compatibility.preferred).slice(0, 5)
          : [],
        signature_hints:    Array.isArray(visDna.signature_hints || visDna.signature_elements)
          ? (visDna.signature_hints || visDna.signature_elements).slice(0, 4)
          : [],
      };

      ctx.active_brand = {
        ...bc,
        brand_identity,
        creative_brief: creativeBrief,
        hard_constraints,
        soft_inspiration,
      };

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
          "nombre_servicio, descripcion_servicio, moneda, entregables, metodologia_pasos"
        )
        .eq("organization_id", organizationId)
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
