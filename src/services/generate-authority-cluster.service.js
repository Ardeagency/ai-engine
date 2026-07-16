/**
 * generate-authority-cluster.service.js — clusters de AUTORIDAD, no posts sueltos (fila 26).
 *
 * El factor que mas correlaciona con SEO+GEO es el contenido interconectado por tema
 * (topic cluster): un PILAR + articulos citables que enlazan entre si. Este servicio
 * toma el universo de keywords de la marca (extract_brand_keyword_universe) + sus
 * Category Entry Points + su ADN, y con gpt-4o disena UN cluster listo para produccion:
 * pilar + briefs de articulo (cada uno anclado en un CEP y optimizado para ser CITABLE
 * por IA) + plan de enlazado interno. Devuelve un PLAN (no produce el contenido: el
 * motor de AISC es imagen/video; el texto largo se produce aparte).
 *
 * On-demand / cost-gated (1 llamada LLM). Alimenta la Radiografia de Visibilidad.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { chatCompletion } from "../lib/openai.js";

const MODEL = process.env.AUTHORITY_CLUSTER_MODEL || "gpt-4o";

export async function generateAuthorityCluster(brandContainerId, organizationId, opts = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const nArticles = Math.max(3, Math.min(Number(opts.articles) || 6, 10));

  const [{ data: brand }, kwRes, { data: ceps }] = await Promise.all([
    supabase.from("brand_containers").select("nombre_marca, nicho_core, propuesta_valor, palabras_clave").eq("id", bc.id).maybeSingle(),
    supabase.rpc("extract_brand_keyword_universe", { p_brand_container_id: bc.id }),
    supabase.from("category_entry_points").select("occasion, anchor_keyword, demand_score").eq("brand_container_id", bc.id).order("demand_score", { ascending: false }).limit(10),
  ]);

  const kw = kwRes?.data || {};
  const keywords = [...new Set([...(kw.niche || []), ...(kw.products || []), ...(brand?.palabras_clave || [])])].slice(0, 40);
  const cepList = (ceps || []).map((c) => `${c.occasion}${c.anchor_keyword ? ` (ancla: ${c.anchor_keyword})` : ""}`);

  if (!keywords.length && !cepList.length) {
    return { brand: bc.nombre_marca, skipped: "sin universo de keywords ni CEPs (corre map_category_entry_points y poblá el catálogo primero)" };
  }

  const instruction =
`Eres un estratega de contenido SEO+GEO. Diseña UN cluster de autoridad interconectado para la marca "${bc.nombre_marca}"${brand?.nicho_core ? ` (nicho: ${brand.nicho_core})` : ""}.

Propuesta de valor: ${brand?.propuesta_valor || "(no definida)"}
Universo de keywords de la marca: ${keywords.join(", ") || "(pocos)"}
Ocasiones de compra de la categoria (CEPs) para anclar articulos: ${cepList.join(" | ") || "(sin CEPs)"}

Un cluster de autoridad = 1 pagina PILAR (tema amplio, evergreen) + ${nArticles} articulos de apoyo que enlazan al pilar y entre si. Cada articulo debe ser CITABLE por IA (incluir: TL;DR, dato+fuente por seccion, tabla o lista, y una cita de experto).

Responde SOLO JSON con esta forma exacta:
{
  "pillar": {"title":"<titulo del pilar>","target_keyword":"<kw principal>","angle":"<por que gana autoridad>","sections":["<seccion>","..."]},
  "articles": [
    {"title":"<titulo>","target_keyword":"<kw>","cep":"<ocasion que sirve o null>","angle":"<angulo>","citable_elements":["<stat a incluir>","<tabla>","<cita de experto sugerida>"],"links_to":["pillar","<otro titulo de este cluster>"]}
  ],
  "internal_linking":"<como se enlazan pilar<->articulos en 1-2 lineas>",
  "why_this_cluster":"<por que este cluster construye autoridad SEO+GEO para la marca, 1-2 lineas>"
}
Genera EXACTAMENTE ${nArticles} articulos.`;

  const { content: raw, usage, model } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "user", content: instruction }],
    max_tokens: 2200,
    temperature: 0.5,
    response_format: { type: "json_object" },
  });

  let plan = null;
  try { plan = JSON.parse(raw); } catch { return { brand: bc.nombre_marca, skipped: "LLM no devolvio JSON valido", raw: String(raw).slice(0, 600) }; }

  return {
    brand: bc.nombre_marca,
    model,
    pillar: plan.pillar || null,
    articles: Array.isArray(plan.articles) ? plan.articles : [],
    internal_linking: plan.internal_linking || null,
    why_this_cluster: plan.why_this_cluster || null,
    keywords_used: keywords.length,
    ceps_used: cepList.length,
    tokens: usage?.total_tokens ?? null,
    nota: "PLAN de cluster (pilar + articulos citables + enlaces). El contenido de TEXTO se produce aparte; el motor AISC es imagen/video.",
  };
}
