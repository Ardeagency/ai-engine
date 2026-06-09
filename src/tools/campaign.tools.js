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
