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
      "id, nombre_campana, descripcion_interna, contexto_temporal, " +
      "objetivos_estrategicos, angulos_venta, cta, created_at"
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
      "id, nombre_campana, descripcion_interna, contexto_temporal, " +
      "objetivos_estrategicos, angulos_venta, oferta_principal, tono_modificador, " +
      "cta, cta_url, created_at, audience_id"
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
