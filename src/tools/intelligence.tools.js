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
    .select("id, name, domain, target_identifier, is_active, metadata, relevance")
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

  // FUENTE DE VERDAD: `post_source` ('own' | 'competitor' | 'reference'), NO
  // `is_competitor`. Ese booleano solo separa competidor de todo-lo-demas, asi
  // que los REFERENTES (is_competitor=false) caian en el mismo saco que la
  // marca: el 63% de lo que devolvia una consulta "propia" no era de la marca.
  // Sin argumento devuelve los posts DE LA MARCA. Con isCompetitor=true, los de
  // los perfiles monitoreados (competidores Y referentes).
  const q = supabase
    .from("brand_posts")
    .select(
      "id, network, profile_handle, content, metrics, post_source, is_competitor, " +
      "captured_at, unpublished_at, media_assets, permalink"
    )
    .eq("brand_container_id", bc.id);
  const { data, error } = await (isCompetitor
    ? q.in("post_source", ["competitor", "reference"])
    : q.eq("post_source", "own"))
    .order("captured_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  // Se entrega la DESCRIPCION VISUAL (lo que se ve en la imagen o el video), no el
  // blob de URLs. Vera venia juzgando el contenido leyendo solo el copy: sin esto
  // no puede saber si un post mostraba el producto, a una persona o un estadio.
  return (Array.isArray(data) ? data : []).map((p) => {
    const desc = p.media_assets?.description || null;
    const { media_assets, ...resto } = p;
    return {
      ...resto,
      media_type: media_assets?.media_type || null,
      que_se_ve: desc,           // PRODUCTOS / TEMA / ESCENA / PERSONAS / ACCION
      sin_analisis_visual: !desc,
    };
  });
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
