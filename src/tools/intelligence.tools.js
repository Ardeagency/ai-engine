/**
 * Herramientas de inteligencia competitiva.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

export async function getIntelligenceEntities(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("intelligence_entities")
    .select("id, name, domain, target_identifier, is_active")
    .eq("brand_container_id", bc.id);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getIntelligenceSignals(entityId, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  // Verifica que la entidad pertenece a este brand_container
  const { data: entity } = await supabase
    .from("intelligence_entities")
    .select("id")
    .eq("id", entityId)
    .eq("brand_container_id", bc.id)
    .maybeSingle();

  if (!entity) {
    throw Object.assign(
      new Error("intelligence_entity no encontrado para esta organización"),
      { statusCode: 404 }
    );
  }

  const { data, error } = await supabase
    .from("intelligence_signals")
    .select("id, signal_type, content_text, content_numeric, ai_analysis, captured_at")
    .eq("entity_id", entityId)
    .order("captured_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getBrandPosts(brandContainerId, organizationId, isCompetitor = false) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("brand_posts")
    .select("id, network, profile_handle, content, metrics, sentiment, is_competitor, captured_at")
    .eq("brand_container_id", bc.id)
    .eq("is_competitor", isCompetitor)
    .order("captured_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getTrendTopics(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("trend_topics")
    .select("id, keyword, source, category, velocity_score, relevance_score, sentiment, detected_at")
    .eq("brand_container_id", bc.id)
    .order("detected_at", { ascending: false })
    .limit(15);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getRetailPrices(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data, error } = await supabase
    .from("retail_prices")
    .select("id, retailer, product_name, price, currency, stock_status, promo_label, captured_at")
    .eq("brand_container_id", bc.id)
    .order("captured_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
