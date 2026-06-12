/**
 * catalog-analysis.service.js — Diagnóstico de catálogo (e-commerce).
 *
 * Capa de ANALISIS (distinta de enrichment, que RELLENA). Evalua la calidad de
 * la ficha de cada producto con REGLAS + MATEMATICA (sin LLM, apto background)
 * y produce:
 *   - por producto: ficha_score (0-100) + flags  → products.metadata.ficha
 *   - por marca:    rollup (promedio, % optimizable, top a mejorar, gaps)
 *
 * Cross-platform: corre sobre la tabla canonica `products`, sirve igual para
 * Shopify / Mercado Libre / Amazon. El LLM solo entra on-demand cuando el
 * humano pulsa "actualizar ficha" (cara al usuario), nunca aqui.
 *
 * Dimensiones implementadas: 1 (completitud SEO/GEO-ready) + 2 (oportunidades).
 */
import { supabase } from "../lib/supabase.js";

// Pesos del score (suman 100)
const W = {
  nombre: 10, descripcion: 25, precio: 10, tipo: 5,
  imagenes: 20, beneficios: 10, diferenciadores: 10, casos_uso: 10,
};
const TIPOS_GENERICOS = new Set(["otro", "fisico", "", null, undefined]);

function nonEmptyArr(v) { return Array.isArray(v) && v.length > 0; }

/** Puntua una ficha y devuelve { score, flags }. */
function scoreProduct(p, imageCount) {
  let score = 0;
  const flags = [];

  const nombre = (p.nombre_producto || "").trim();
  if (nombre.length >= 10) score += W.nombre;
  else if (nombre.length > 0) { score += W.nombre / 2; flags.push("nombre_corto"); }
  else flags.push("sin_nombre");

  const desc = (p.descripcion_producto || "").trim();
  if (desc.length >= 200) score += W.descripcion;
  else if (desc.length >= 50) { score += W.descripcion * 0.6; flags.push("descripcion_corta"); }
  else if (desc.length > 0) { score += W.descripcion * 0.3; flags.push("descripcion_muy_corta"); }
  else flags.push("sin_descripcion");

  if (p.precio_producto != null && Number(p.precio_producto) > 0) score += W.precio;
  else flags.push("sin_precio");

  if (!TIPOS_GENERICOS.has(p.tipo_producto)) score += W.tipo;
  else flags.push("tipo_generico");

  if (imageCount >= 3) score += W.imagenes;
  else if (imageCount >= 1) { score += W.imagenes / 2; flags.push("pocas_imagenes"); }
  else flags.push("sin_imagenes");

  if (nonEmptyArr(p.beneficios_principales)) score += W.beneficios; else flags.push("sin_beneficios");
  if (nonEmptyArr(p.diferenciadores))       score += W.diferenciadores; else flags.push("sin_diferenciadores");
  if (nonEmptyArr(p.casos_de_uso))          score += W.casos_uso; else flags.push("sin_casos_uso");

  return { score: Math.round(score), flags };
}

/**
 * Analiza el catálogo de una marca: puntua cada producto, persiste el score en
 * products.metadata.ficha y devuelve un rollup estrategico.
 * @returns {Promise<object>} resumen por marca
 */
export async function analyzeCatalog(brandContainerId, { persist = true } = {}) {
  if (!brandContainerId) throw new Error("analyzeCatalog: brandContainerId required");

  const { data: products, error } = await supabase
    .from("products")
    .select("id, nombre_producto, descripcion_producto, precio_producto, tipo_producto, primary_platform, beneficios_principales, diferenciadores, casos_de_uso, metadata")
    .eq("brand_container_id", brandContainerId);
  if (error) throw error;
  if (!products?.length) {
    return { brand_container_id: brandContainerId, products: 0, avg_score: null, optimizable: 0, items: [], gaps: {}, by_platform: {} };
  }

  // Conteo de imágenes por producto
  const ids = products.map((p) => p.id);
  const { data: imgs } = await supabase
    .from("product_images")
    .select("product_id")
    .in("product_id", ids)
    .eq("download_status", "stored");
  const imgCount = {};
  for (const r of imgs || []) imgCount[r.product_id] = (imgCount[r.product_id] || 0) + 1;

  const items = [];
  const gaps = {};            // flag → cuántos productos lo tienen
  const byPlatform = {};      // plataforma → {n, sum}
  const nowIso = new Date().toISOString();
  const updates = [];

  for (const p of products) {
    const { score, flags } = scoreProduct(p, imgCount[p.id] || 0);
    items.push({ id: p.id, name: p.nombre_producto, platform: p.primary_platform, score, flags });
    for (const f of flags) gaps[f] = (gaps[f] || 0) + 1;
    const plat = p.primary_platform || "unknown";
    byPlatform[plat] = byPlatform[plat] || { n: 0, sum: 0 };
    byPlatform[plat].n++; byPlatform[plat].sum += score;

    if (persist) {
      updates.push(
        supabase.from("products")
          .update({ metadata: { ...(p.metadata || {}), ficha: { score, flags, scored_at: nowIso } } })
          .eq("id", p.id)
      );
    }
  }
  if (persist) await Promise.allSettled(updates);

  const scores = items.map((i) => i.score);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const optimizable = items.filter((i) => i.score < 70);
  const topToImprove = [...optimizable].sort((a, b) => a.score - b.score).slice(0, 10);
  const byPlatformAvg = Object.fromEntries(
    Object.entries(byPlatform).map(([k, v]) => [k, { products: v.n, avg_score: Math.round(v.sum / v.n) }])
  );

  return {
    brand_container_id: brandContainerId,
    products:           products.length,
    avg_score:          avg,
    optimizable_count:  optimizable.length,
    optimizable_pct:    Math.round((optimizable.length / products.length) * 100),
    by_platform:        byPlatformAvg,
    gaps,                                   // qué falta y a cuántos (qué falla)
    top_to_improve:     topToImprove,       // priorizado (qué optimizar primero)
    scored_at:          nowIso,
  };
}
