/**
 * Herramientas de lectura de flows y ejecuciones.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

async function getBrandIdsForOrg(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data: brands } = await supabase
    .from("brands")
    .select("id")
    .eq("project_id", bc.id);

  return { bc, brandIds: (brands || []).map((b) => b.id) };
}

/**
 * Flujos disponibles en el catálogo público (no requiere org).
 */
export async function getAvailableFlows(filters = {}) {
  let query = supabase
    .from("content_flows")
    .select(
      "id, name, description, output_type, flow_category_type, " +
      "execution_mode, token_cost, likes_count, run_count, slug"
    )
    .eq("is_active", true)
    .eq("show_in_catalog", true);

  if (filters.category_type) query = query.eq("flow_category_type", filters.category_type);
  if (filters.output_type) query = query.eq("output_type", filters.output_type);

  const { data, error } = await query.order("run_count", { ascending: false }).limit(30);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getFlowSchedules(brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) return [];

  const { data, error } = await supabase
    .from("flow_schedules")
    .select("id, flow_id, brand_id, cron_expression, status, production_count, aspect_ratio, created_at")
    .in("brand_id", brandIds)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getFlowRuns(brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) return [];

  const { data, error } = await supabase
    .from("flow_runs")
    .select("id, flow_id, brand_id, status, created_at, tokens_consumed, is_paused")
    .in("brand_id", brandIds)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getFlowRunOutputs(runId, brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) {
    throw Object.assign(new Error("No hay brands en esta org"), { statusCode: 404 });
  }

  // Verifica que el run pertenece a esta org
  const { data: run } = await supabase
    .from("flow_runs")
    .select("id, brand_id")
    .eq("id", runId)
    .in("brand_id", brandIds)
    .maybeSingle();

  if (!run) {
    throw Object.assign(
      new Error("flow_run no encontrado para esta organización"),
      { statusCode: 404 }
    );
  }

  const { data, error } = await supabase
    .from("runs_outputs")
    .select("id, output_type, text_content, generated_copy, generated_hashtags, created_at")
    .eq("run_id", runId)
    .limit(10);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
