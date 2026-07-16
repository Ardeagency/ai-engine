/**
 * Map Category Entry Points — mapea las OCASIONES de compra de la categoría (CEP).
 *
 * Doctrina (cmo-mindset): una marca atada a una sola ocasión tiene techo bajo.
 * Los Category Entry Points son el cuándo/dónde/por qué/con quién se compra la
 * categoría; cada uno es un ancla de intención distinta. Este populator llena
 * public.category_entry_points para que compute_cep_coverage mida en qué ocasiones
 * la marca está presente y cuáles están en blanco.
 *
 * Generación PUNTUAL (no LLM recurrente en background): idempotente — si la marca
 * ya tiene CEPs mapeados, hace skip. Se dispara una vez por marca desde
 * strategy-review (cubre marcas existentes y nuevas). Patrón chatCompletion
 * calcado de strategy-review.service.js / brand-dna-generator.
 */
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabase.js";
import { chatCompletion } from "../lib/openai.js";

const MODEL = process.env.CEP_MAP_MODEL || "gpt-4o";

const SYSTEM_PROMPT = `Eres un estratega de marca experto en Category Entry Points (CEP) de la ciencia de marcas (Ehrenberg-Bass). Dada una marca y su categoría, mapea las OCASIONES reales en que la gente compra/usa esa CATEGORÍA (no la marca) — el cuándo, dónde, por qué y con quién.

Reglas:
- Piensa en la CATEGORÍA, no solo en la marca: incluye ocasiones que la marca podría no estar atendiendo aún (ahí está el crecimiento).
- Cada CEP debe tener una PALABRA-ANCLA de intención (una palabra/expresión con la que alguien buscaría o pensaría en esa ocasión).
- Estima la demanda relativa de cada ocasión de 0 a 100 (qué tan grande/frecuente es).
- Entre 5 y 8 CEPs. Concretos y accionables, no genéricos.

Devuelve SOLO un JSON válido (sin markdown) con esta forma exacta:
{"ceps":[{"cep_name":"...","occasion":"cuándo/dónde/por qué/con quién","anchor_keyword":"...","demand_score":0}]}`;

function _parseCeps(content) {
  if (!content) return [];
  let c = String(content).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s >= 0 && e > s) c = c.slice(s, e + 1);
  try {
    const obj = JSON.parse(c);
    const ceps = Array.isArray(obj?.ceps) ? obj.ceps : [];
    return ceps.filter((x) => x && x.cep_name).slice(0, 8);
  } catch (_) {
    return [];
  }
}

export async function mapCategoryEntryPoints(brandContainerId, organizationId) {
  if (!brandContainerId || !organizationId) return { generated: 0, error: "missing ids" };

  // Idempotencia: si ya hay CEPs mapeados para la marca, no re-generar (puntual).
  const { count: existing } = await supabase
    .from("category_entry_points")
    .select("*", { count: "exact", head: true })
    .eq("brand_container_id", brandContainerId);
  if (existing && existing > 0) {
    return { generated: 0, skipped: existing, status: "already_mapped" };
  }

  // Contexto liviano: marca + nicho + productos (sin el builder pesado).
  const { data: bc } = await supabase
    .from("brand_containers")
    .select("nombre_marca, nicho_core, mercado_objetivo, sub_nichos")
    .eq("id", brandContainerId)
    .maybeSingle();
  if (!bc) return { generated: 0, status: "no_brand" };

  const { data: prods } = await supabase
    .from("products")
    .select("nombre_producto")
    .eq("brand_container_id", brandContainerId)
    .limit(20);
  const productos = (prods || []).map((p) => p.nombre_producto).filter(Boolean);

  const userMsg =
    `MARCA: ${bc.nombre_marca || "—"}\n` +
    `NICHO/CATEGORÍA: ${bc.nicho_core || "—"}\n` +
    `SUB-NICHOS: ${Array.isArray(bc.sub_nichos) ? bc.sub_nichos.join(", ") : bc.sub_nichos || "—"}\n` +
    `MERCADO OBJETIVO: ${bc.mercado_objetivo || "—"}\n` +
    `PRODUCTOS: ${productos.length ? productos.join(", ") : "—"}\n\n` +
    `Mapea los Category Entry Points de esta categoría. Devuelve SOLO el JSON.`;

  let content, model;
  try {
    const res = await chatCompletion({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    });
    content = res.content;
    model = res.model;
  } catch (e) {
    console.warn(`[cep-map] LLM falló brand=${brandContainerId}: ${e.message}`);
    return { generated: 0, error: e.message };
  }

  const ceps = _parseCeps(content);
  if (!ceps.length) return { generated: 0, status: "no_ceps_parsed" };

  let generated = 0;
  for (const c of ceps) {
    const dscore = Number.isFinite(+c.demand_score) ? Math.max(0, Math.min(100, +c.demand_score)) : null;
    const { error: insErr } = await supabase
      .from("category_entry_points")
      .upsert(
        {
          id: randomUUID(),
          organization_id: organizationId,
          brand_container_id: brandContainerId,
          cep_name: String(c.cep_name).slice(0, 200),
          occasion: c.occasion || null,
          anchor_keyword: c.anchor_keyword || null,
          demand_score: dscore,
          source: "llm",
        },
        { onConflict: "brand_container_id,cep_name", ignoreDuplicates: true }
      );
    if (insErr) {
      console.warn(`[cep-map] insert falló brand=${brandContainerId}: ${insErr.message}`);
      continue;
    }
    generated++;
  }

  console.log(`[cep-map] brand=${brandContainerId} → ${generated} CEPs mapeados (modelo ${model})`);
  return { generated, model };
}
