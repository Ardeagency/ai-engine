/**
 * analyze-packaging.service.js — el packaging como PALANCA de crecimiento (fila 23).
 *
 * Trata el empaque de producto como tres cosas a la vez, con VISION (gpt-4o):
 *   1. MEDIO   — ¿comunica la marca en el feed/anaquel en 0,5s? (activo distintivo)
 *   2. PRODUCTO— ¿el formato sugiere una ocasion de consumo nueva? (cruza con CEPs)
 *   3. DISPONIBILIDAD — ¿es legible/atractivo a distancia de anaquel/thumbnail?
 *
 * Read-only (diagnostico, no persiste). On-demand / cost-gated: sampleo N imagenes
 * de packaging (gate PACKAGING_MAX_IMAGES, default 5) + detail:"low". Vera lo usa
 * para proponer formato/empaque como jugada de crecimiento, no solo copy.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { analyzeImagesJSON } from "../lib/vision.js";

const MAX_IMAGES = parseInt(process.env.PACKAGING_MAX_IMAGES || "5", 10);

export async function analyzePackagingAsAsset(brandContainerId, organizationId, opts = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const maxImages = Math.max(1, Math.min(Number(opts.maxImages) || MAX_IMAGES, 10));

  // Imagenes de packaging: product_images de los productos de la marca.
  const { data: prodIds } = await supabase
    .from("products").select("id, nombre_producto").eq("brand_container_id", bc.id).limit(200);
  const ids = (prodIds || []).map((p) => p.id);
  if (!ids.length) {
    return { brand: bc.nombre_marca, images_analyzed: 0, skipped: "la marca no tiene productos en el catalogo" };
  }
  const nameById = new Map((prodIds || []).map((p) => [p.id, p.nombre_producto]));

  const { data: imgsRows, error: imgErr } = await supabase
    .from("product_images")
    .select("product_id, image_url, image_type")
    .in("product_id", ids)
    .not("image_url", "is", null)
    .in("image_type", ["principal", "product", "packaging", "galeria"])
    .limit(60);
  if (imgErr) throw new Error(`analyzePackaging images: ${imgErr.message}`);

  const imgs = (imgsRows || [])
    .filter((r) => /^https?:\/\//.test(r.image_url) && !/\.(mp4|mov|webm)(\?|$)/i.test(r.image_url))
    .slice(0, maxImages);
  if (!imgs.length) {
    return { brand: bc.nombre_marca, images_analyzed: 0, skipped: "sin imagenes de producto/packaging fetchables" };
  }

  // CEPs para el cruce "formato nuevo = ocasion nueva"
  const { data: ceps } = await supabase
    .from("category_entry_points").select("occasion, anchor_keyword, demand_score")
    .eq("brand_container_id", bc.id).order("demand_score", { ascending: false }).limit(8);
  const cepText = (ceps || []).length
    ? (ceps || []).map((c) => `- ${c.occasion}${c.anchor_keyword ? ` (ancla: ${c.anchor_keyword})` : ""}`).join("\n")
    : "(sin CEPs mapeados aun)";

  const instruction =
`Eres un estratega de marca (doctrina Ehrenberg-Bass) evaluando el PACKAGING de "${bc.nombre_marca}" como palanca de crecimiento — no solo como estetica. El empaque es MEDIO (activo distintivo), PRODUCTO (formato = ocasion) y DISPONIBILIDAD (legibilidad en anaquel/feed).

Te paso ${imgs.length} imagenes de producto/packaging de la marca.
Ocasiones de compra de la categoria (Category Entry Points) para cruzar con formato:
${cepText}

Responde SOLO JSON con esta forma exacta:
{
  "as_medium":       {"score":<0..1>,"reconocible_05s":<true|false>,"note":"<comunica la marca en el feed/anaquel?>"},
  "as_product":      {"score":<0..1>,"note":"<el formato sugiere ocasiones de consumo? cuales?>"},
  "as_availability": {"score":<0..1>,"note":"<legible/atractivo a distancia de anaquel y en thumbnail?>"},
  "new_format_opportunities": [{"formato":"<ej. multipack, sachet, formato viaje>","ocasion":"<CEP que habilita>","por_que":"<1 linea>"}],
  "distinctive_assets_on_pack": ["<color/forma/simbolo que funciona como activo>"],
  "risks": ["<lo que diluye marca o pierde legibilidad>"],
  "veredicto": "<1-2 lineas accionables>"
}`;

  const urls = imgs.map((r) => r.image_url);
  const { data: vis, usage, images_analyzed, model } = await analyzeImagesJSON(urls, instruction, { maxImages: urls.length, detail: "low", max_tokens: 1600 });
  if (!vis || vis._parse_error) {
    return { brand: bc.nombre_marca, images_analyzed, skipped: "vision no devolvio JSON valido", raw: vis?.raw };
  }

  return {
    brand: bc.nombre_marca,
    images_analyzed,
    model,
    products_sampled: [...new Set(imgs.map((i) => nameById.get(i.product_id)).filter(Boolean))].slice(0, 10),
    as_medium: vis.as_medium || null,
    as_product: vis.as_product || null,
    as_availability: vis.as_availability || null,
    new_format_opportunities: Array.isArray(vis.new_format_opportunities) ? vis.new_format_opportunities : [],
    distinctive_assets_on_pack: Array.isArray(vis.distinctive_assets_on_pack) ? vis.distinctive_assets_on_pack : [],
    risks: Array.isArray(vis.risks) ? vis.risks : [],
    veredicto: vis.veredicto || null,
    tokens: usage?.total_tokens ?? null,
  };
}
