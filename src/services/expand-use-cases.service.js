/**
 * expand-use-cases.service.js — casos de uso NUEVOS para subir frecuencia de compra.
 *
 * Doctrina (fila 24): comunicar usos adicionales legitimos multiplica la frecuencia
 * sin robar share. Cruza los Category Entry Points (ocasiones de compra de la
 * categoria) contra los casos_de_uso YA declarados en el catalogo: las ocasiones NO
 * cubiertas son oportunidades de "uso nuevo". A cada ocasion en blanco le sugiere el
 * producto que mejor calza (overlap de tokens con beneficios/casos/descripcion) y la
 * palabra-ancla de esa ocasion.
 *
 * Reglado, SIN LLM (matching de tokens). Read-only. Vera lo usa para proponer
 * contenido de "uso nuevo" anclado por ocasion. Complementa compute_cep_coverage
 * (que mide presencia) agregando el PAR producto×ocasion accionable.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

const STOP = new Set([
  "de","la","el","los","las","un","una","unos","unas","y","o","para","por","con","en","a","del","al",
  "que","se","su","sus","lo","como","mas","muy","tu","mi","este","esta","estos","estas","the","and","for",
  "with","your","product","producto","marca",
]);

function _tokens(...parts) {
  const t = parts.filter(Boolean).join(" ").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");        // strip acentos
  const words = t.match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  return new Set(words.filter((w) => !STOP.has(w)));
}

function _overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * expandUseCases(brandContainerId, organizationId, opts?)
 * @returns {{ total_ceps, products, covered, new_use_cases:Array, nota }}
 */
export async function expandUseCases(brandContainerId, organizationId, opts = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 12, 50));

  const [{ data: ceps, error: cepErr }, { data: prods, error: prodErr }] = await Promise.all([
    supabase
      .from("category_entry_points")
      .select("cep_name, occasion, anchor_keyword, demand_score")
      .eq("brand_container_id", bc.id),
    supabase
      .from("products")
      .select("nombre_producto, casos_de_uso, beneficios_principales, descripcion_producto")
      .eq("brand_container_id", bc.id)
      .limit(300),
  ]);
  if (cepErr) throw new Error(`expandUseCases CEPs: ${cepErr.message}`);
  if (prodErr) throw new Error(`expandUseCases products: ${prodErr.message}`);

  const cepList = Array.isArray(ceps) ? ceps : [];
  const prodList = Array.isArray(prods) ? prods : [];
  if (!cepList.length) {
    return { total_ceps: 0, products: prodList.length, covered: 0, new_use_cases: [],
      nota: "Sin Category Entry Points mapeados aun. Corre map_category_entry_points primero." };
  }

  // Universo de usos YA declarados (todos los casos_de_uso del catalogo).
  const declaredUses = _tokens(
    ...prodList.flatMap((p) => [
      Array.isArray(p.casos_de_uso) ? p.casos_de_uso.join(" ") : (p.casos_de_uso || ""),
    ])
  );

  // Tokens por producto (para elegir el mejor calce por ocasion).
  const prodTokens = prodList.map((p) => ({
    name: p.nombre_producto,
    tokens: _tokens(
      p.nombre_producto,
      Array.isArray(p.beneficios_principales) ? p.beneficios_principales.join(" ") : p.beneficios_principales,
      Array.isArray(p.casos_de_uso) ? p.casos_de_uso.join(" ") : p.casos_de_uso,
      p.descripcion_producto,
    ),
  }));

  const gaps = [];
  for (const cep of cepList) {
    const cepTok = _tokens(cep.cep_name, cep.occasion, cep.anchor_keyword);
    // "cubierta" = la ocasion ya aparece en los casos_de_uso declarados (>=2 tokens).
    const covered = _overlap(cepTok, declaredUses) >= 2;
    if (covered) continue;
    // Mejor producto para esta ocasion: mayor overlap de tokens (sin exigir match).
    let best = null, bestScore = -1;
    for (const pt of prodTokens) {
      const s = _overlap(cepTok, pt.tokens);
      if (s > bestScore) { bestScore = s; best = pt; }
    }
    gaps.push({
      occasion:       cep.occasion || cep.cep_name,
      cep_name:       cep.cep_name,
      anchor_keyword: cep.anchor_keyword || null,
      demand_score:   cep.demand_score != null ? Number(cep.demand_score) : null,
      suggested_product: best?.name || null,
      fit:            bestScore > 0 ? "producto con afinidad" : "sin calce claro — usar la marca",
      rationale: `Ocasion "${cep.occasion || cep.cep_name}" no aparece en los casos_de_uso del catalogo. `
        + `Comunica el uso de ${best?.name ? `"${best.name}"` : "la marca"} para esta ocasion`
        + (cep.anchor_keyword ? `, anclado en "${cep.anchor_keyword}".` : "."),
    });
  }

  gaps.sort((a, b) => (b.demand_score ?? 0) - (a.demand_score ?? 0));

  return {
    total_ceps: cepList.length,
    products:   prodList.length,
    covered:    cepList.length - gaps.length,
    new_use_cases: gaps.slice(0, limit),
    nota: "Casos de uso NUEVOS = ocasiones de la categoria (CEPs) que el catalogo aun no comunica. "
      + "Subir frecuencia = plantar la marca en esas ocasiones sin robar share. Reglado, sin LLM.",
  };
}
