/**
 * Prompt Forge — generador profesional de prompts de produccion (camino A).
 *
 * Division de cerebros: Vera (Claude) DECIDE que producir; este forge
 * (ChatGPT/gpt-4o + RAG del PLAYBOOK ARDE) ESCRIBE el prompt profesional. Vera
 * nunca redacta el prompt de produccion: lo encarga aqui y lo revisa.
 *
 * Forge LIBRE: dado un intent + producto opcional, recupera el conocimiento de
 * direccion de arte curado de ARDE (ai_global_vectors via creative-knowledge) y
 * forja un prompt listo para un modelo de imagen/video. El camino golden (slots
 * congelados por flow) lo resuelve el runner automaticamente al ejecutar un flow
 * — no se duplica aqui.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { chatCompletion } from "../lib/openai.js";
import { retrieveCreativeKnowledge } from "../services/creative-knowledge.service.js";

const SYSTEM_PROMPT = `Eres el ingeniero de prompts de produccion de ARDE Agency. Tu unico trabajo: convertir una intencion creativa + datos de producto en UN prompt profesional, listo para un modelo de imagen/video (estilo MidJourney/Flux/Nanobanana/Runway segun el medio).

Reglas:
- Escribe el prompt en INGLES (los modelos rinden mejor). Denso, especifico, cinematografico.
- Estructura el prompt: sujeto/producto exacto, escena/ambiente, composicion y encuadre, iluminacion, paleta/color grade, lente/camara, mood, calidad/render.
- APLICA el PLAYBOOK ARDE que se te entrega como direccion de arte; no lo copies textual, usalo como criterio de calidad y variedad.
- Fidelidad de producto: respeta forma, material y color reales. No inventes variantes del producto.
- Respeta las restricciones duras (palabras/elementos prohibidos, paleta de marca).
- Nada de texto ni logo dentro de la imagen salvo que se pida. Sin watermark.
- Devuelve SOLO el prompt final, sin explicaciones, sin comillas, sin encabezados.`;

export async function forgeProductionPrompt(params = {}, brandContainerId, organizationId) {
  const intent = String(params.intent || params.brief || "").trim();
  if (!intent) {
    throw new Error("forgeProductionPrompt: 'intent' es requerido (que quieres producir)");
  }
  const productionType = params.productionType || params.medium || "image";
  const creativeDirection = String(params.creativeDirection || "").trim();

  // Marca + brief + restricciones duras
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { data: brand } = await supabase
    .from("brand_containers")
    .select("nombre_marca, creative_brief, propuesta_valor, palabras_prohibidas, visual_dna")
    .eq("id", bc.id)
    .maybeSingle();

  const brandBrief = String(brand?.creative_brief || brand?.propuesta_valor || "").slice(0, 600);
  const prohibited = Array.isArray(brand?.palabras_prohibidas) ? brand.palabras_prohibidas : [];
  const paleta = brand?.visual_dna?.paleta;
  const hardConstraints = [
    prohibited.length ? `Prohibido: ${prohibited.join(", ")}` : "",
    Array.isArray(paleta) && paleta.length ? `Paleta de marca: ${paleta.join(", ")}` : "",
  ].filter(Boolean).join(". ");

  // Producto (opcional) — por id o por nombre
  let product = {};
  if (params.productId || params.productName) {
    let q = supabase
      .from("products")
      .select("nombre_producto, descripcion_producto, tipo_producto, beneficios_principales, diferenciadores, materiales_composicion, url_producto")
      .eq("organization_id", organizationId)
      .limit(1);
    q = params.productId
      ? q.eq("id", params.productId)
      : q.ilike("nombre_producto", `%${params.productName}%`);
    const { data: prows } = await q;
    if (prows && prows[0]) product = prows[0];
  }

  // RAG: PLAYBOOK ARDE (fail-open — si falla, forja sin el)
  const ctx = { product, brandBrief, hardConstraints };
  let knowledgeBlock = "";
  let knowledgeUsed = [];
  try {
    const { block, used } = await retrieveCreativeKnowledge(ctx);
    knowledgeBlock = block || "";
    knowledgeUsed = Array.isArray(used) ? used : [];
  } catch (e) {
    console.warn(`forgeProductionPrompt: RAG fail-open -> ${e.message}`);
  }

  const productLine = product.nombre_producto
    ? `Producto: ${product.nombre_producto}. ${product.descripcion_producto || ""}. Material: ${(product.materiales_composicion || []).join(", ") || "n/d"}.`
    : "Producto: no especificado; trabaja desde la intencion.";

  const userMsg = [
    `MEDIO: ${productionType}`,
    `INTENCION: ${intent}`,
    creativeDirection ? `DIRECCION CREATIVA: ${creativeDirection}` : "",
    productLine,
    brandBrief ? `MARCA (${brand?.nombre_marca || ""}): ${brandBrief}` : "",
    hardConstraints ? `RESTRICCIONES DURAS: ${hardConstraints}` : "",
    knowledgeBlock ? `\nPLAYBOOK ARDE (aplicar, no copiar textual):\n${knowledgeBlock}` : "",
  ].filter(Boolean).join("\n");

  const { content, usage } = await chatCompletion({
    model: params.model || "gpt-4o",
    temperature: 0.8,
    max_tokens: 700,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
  });

  return {
    prompt: String(content || "").trim(),
    mode: "free_forge",
    medium: productionType,
    brand: brand?.nombre_marca || null,
    product: product.nombre_producto || null,
    knowledge_used: knowledgeUsed.map((k) => k?.type || k?._type).filter(Boolean),
    note: "Prompt forjado por el especialista (ChatGPT) con PLAYBOOK ARDE. Revisalo: si no es lo que necesitas, refina la intencion/direccion y vuelve a llamar.",
    tokens: usage?.total_tokens || null,
  };
}
