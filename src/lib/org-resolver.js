/**
 * Helpers para resolver organizationId a partir de brand_container_id.
 * Usados por el webhook de señales de competidores y otros servicios internos.
 */
import { supabase } from "./supabase.js";

/**
 * Retorna la organización propietaria de un brand_container.
 * @param {string} brandContainerId
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function getOrgByBrandContainer(brandContainerId) {
  if (!brandContainerId) return null;

  const { data, error } = await supabase
    .from("brand_containers")
    .select("organization_id, organizations(id, name)")
    .eq("id", brandContainerId)
    .maybeSingle();

  if (error || !data) return null;

  const org = data.organizations;
  return org ? { id: org.id, name: org.name } : null;
}
