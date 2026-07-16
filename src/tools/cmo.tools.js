/**
 * CMO Tools — expone a Vera la inteligencia CMO nueva (penetración + ocasiones +
 * demanda creada/cosechada + atribución a negocio real).
 *
 * Read-only. Envuelven RPCs ya vivos en Supabase (compute_penetration_proxy,
 * compute_cep_coverage, classify_demand_created_vs_harvested,
 * link_plays_to_conversions) para que Vera razone con la doctrina Ehrenberg-Bass:
 * crecer por penetración, cubrir el máximo de Category Entry Points, no matar
 * campañas que CREAN demanda, y medir NEGOCIO (leads/órdenes) en vez de vanidad.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { scoreCitability } from "../services/content-citability.service.js";
import { expandUseCases } from "../services/expand-use-cases.service.js";
import { auditDistinctiveAssets } from "../services/audit-distinctive-assets.service.js";
import { analyzePackagingAsAsset } from "../services/analyze-packaging.service.js";
import { generateAuthorityCluster } from "../services/generate-authority-cluster.service.js";

// ventana en días → ISO de p_date_from (p_date_to queda null = now en el RPC).
function _windowFromISO(windowDays, def) {
  const w = Math.max(7, Math.min(Number(windowDays) || def, 365));
  return new Date(Date.now() - w * 86400000).toISOString();
}

// getPenetrationDiagnosis — ¿crece la marca por penetración o exprime a los fieles?
export async function getPenetrationDiagnosis(brandContainerId, organizationId, windowDays) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const w = Math.max(7, Math.min(Number(windowDays) || 30, 365));
  const { data, error } = await supabase.rpc("compute_penetration_proxy", {
    p_brand_container_id: bc.id,
    p_window_days: w,
  });
  if (error) throw new Error(`getPenetrationDiagnosis: ${error.message}`);
  return data;
}

// getCEPGaps — ocasiones de compra de la categoría donde la marca NO está presente.
export async function getCEPGaps(brandContainerId, organizationId, windowDays) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const w = Math.max(7, Math.min(Number(windowDays) || 90, 365));
  const { data, error } = await supabase.rpc("compute_cep_coverage", {
    p_brand_container_id: bc.id,
    p_window_days: w,
  });
  if (error) throw new Error(`getCEPGaps: ${error.message}`);
  const ceps = Array.isArray(data?.ceps) ? data.ceps : [];
  const gaps = ceps.filter((c) => !c.covered);
  return { ...data, gaps, gaps_count: gaps.length };
}

// getDemandDiagnosis — ¿la pauta CREA demanda nueva o solo COSECHA la que ya existía?
// Regla CMO: ROAS alto/subiendo + penetración plana = drenaje (cosecha), no crecimiento.
// Antes de recomendar pausar un "burner", Vera verifica aquí si estaba creando demanda.
export async function getDemandDiagnosis(brandContainerId, organizationId, windowDays) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { data, error } = await supabase.rpc("classify_demand_created_vs_harvested", {
    p_org_id: organizationId,
    p_brand_container_ids: [bc.id],
    p_date_from: _windowFromISO(windowDays, 30),
  });
  if (error) throw new Error(`getDemandDiagnosis: ${error.message}`);
  return data;
}

// getConversionOutcomes — atribuye cada jugada a resultado de NEGOCIO (leads), no a
// engagement. Cierra el sesgo de vanidad del learning loop: mide qué jugadas traen
// leads reales. Requiere meta_leads poblada (gate Meta leads_retrieval).
export async function getConversionOutcomes(brandContainerId, organizationId, windowDays) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { data, error } = await supabase.rpc("link_plays_to_conversions", {
    p_org_id: organizationId,
    p_brand_container_ids: [bc.id],
    p_date_from: _windowFromISO(windowDays, 90),
  });
  if (error) throw new Error(`getConversionOutcomes: ${error.message}`);
  return data;
}

// scoreContentCitability — ¿este texto es citable por una IA? Rubrica reglada (GEO),
// sin LLM. Vera puntua un borrador ANTES de publicarlo y ve que falta para subir citas.
export function scoreContentCitability(text) {
  return scoreCitability(text);
}

// getUseCaseExpansion — casos de uso NUEVOS (ocasiones sin cubrir) para subir frecuencia. Reglado.
export function getUseCaseExpansion(brandContainerId, organizationId, opts) {
  return expandUseCases(brandContainerId, organizationId, opts || {});
}

// getDistinctiveAssetsAudit — blink test con VISION (gpt-4o): consistencia/reconocimiento
// de color/logo/tipografia en outputs vs activos definidos. Persiste asset_equity. Cuesta tokens.
export function getDistinctiveAssetsAudit(brandContainerId, organizationId, opts) {
  return auditDistinctiveAssets(brandContainerId, organizationId, opts || {});
}

// getPackagingAnalysis — VISION sobre packaging: medio (activo) + producto (ocasion) + disponibilidad. Cuesta tokens.
export function getPackagingAnalysis(brandContainerId, organizationId, opts) {
  return analyzePackagingAsAsset(brandContainerId, organizationId, opts || {});
}

// getAuthorityClusterPlan — plan de cluster de autoridad (pilar + articulos citables + enlaces) via LLM. Cuesta tokens.
export function getAuthorityClusterPlan(brandContainerId, organizationId, opts) {
  return generateAuthorityCluster(brandContainerId, organizationId, opts || {});
}
