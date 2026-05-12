/**
 * enrichment.populator.js
 *
 * Mission `vera_enrich_product`: usa Anthropic Claude para llenar campos
 * descriptivos de un producto que vienen vacíos desde la importación raw
 * de plataformas (Shopify, Amazon, etc.):
 *   - beneficios_principales (ARRAY text)
 *   - diferenciadores         (ARRAY text)
 *   - casos_de_uso            (ARRAY text)
 *   - caracteristicas_visuales (ARRAY text)
 *   - materiales_composicion   (ARRAY text)
 *
 * El usuario pidió explícitamente OpenAI/Anthropic para esta tarea
 * (excepción a la regla "no LLM en background"). Idempotente: si los
 * campos ya están llenos, se salta el producto sin gastar tokens.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

async function callAnthropic({ system, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in env");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  return (json?.content?.[0]?.text || "").trim();
}

const SYSTEM_PROMPT = `Eres un experto en marketing y product copywriting. Tu tarea: dado el nombre, descripción y tipo de un producto, generar 5 listas concisas en español:
- beneficios_principales: 3-5 beneficios reales del producto (qué gana el cliente)
- diferenciadores: 2-4 atributos únicos vs. competencia
- casos_de_uso: 3-5 contextos típicos de uso
- caracteristicas_visuales: 3-5 atributos físicos visibles (color, forma, tamaño, textura)
- materiales_composicion: 2-5 materiales/ingredientes principales (si aplica; lista vacía si no)

Reglas:
- Cada item máximo 80 caracteres
- En español neutro, voz comercial pero honesta
- Sin emojis, sin signos !!! o ???
- Si no tienes evidencia para un campo, devuelve lista vacía []
- Output ESTRICTAMENTE JSON, nada antes ni después`;

export class EnrichmentPopulator extends BasePopulator {
  constructor() { super("enrichment"); }

  // No tiene bootstrap propio — se invoca producto por producto.
  subjobSequence() { return []; }

  handles() { return ["vera_enrich_product"]; }

  dispatch(missionType) {
    if (missionType === "vera_enrich_product") return this.enrichProduct;
    return null;
  }

  async process(job) {
    const mt = job?.payload?.mission_type;
    if (mt !== "vera_enrich_product") throw new Error(`enrichment: unknown mission ${mt}`);
    return this.enrichProduct(job);
  }

  async enrichProduct(job) {
    const productId = job?.payload?.product_id;
    if (!productId) throw new Error("vera_enrich_product: missing product_id");

    const { data: prod, error: prodErr } = await supabase
      .from("products")
      .select("id, nombre_producto, descripcion_producto, tipo_producto, beneficios_principales, diferenciadores, casos_de_uso, caracteristicas_visuales, materiales_composicion, metadata")
      .eq("id", productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!prod) throw new Error(`Product not found: ${productId}`);

    // Idempotencia: si ya hay benefits + diff + use, no re-procesar (ahorra tokens)
    const hasBenefits = Array.isArray(prod.beneficios_principales) && prod.beneficios_principales.length > 0;
    const hasDiff     = Array.isArray(prod.diferenciadores) && prod.diferenciadores.length > 0;
    const hasUse      = Array.isArray(prod.casos_de_uso) && prod.casos_de_uso.length > 0;
    if (hasBenefits && hasDiff && hasUse) {
      return { ok: true, status: "skipped_already_enriched", product_id: productId };
    }

    const userMessage = JSON.stringify({
      nombre:      prod.nombre_producto,
      descripcion: (prod.descripcion_producto || "").slice(0, 1500),
      tipo:        prod.tipo_producto,
      tags_origen: prod.metadata?.shopify_tags || prod.metadata?.tags || null,
      vendor:      prod.metadata?.shopify_vendor || null,
    }, null, 2);

    let parsed;
    try {
      const text = await callAnthropic({ system: SYSTEM_PROMPT, user: userMessage });
      const cleaned = text.replace(/^```json?/i, "").replace(/```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`enrichment LLM/parse failed: ${e.message}`);
    }

    const sanitize = (arr) => Array.isArray(arr)
      ? arr.filter(s => typeof s === "string" && s.trim().length > 0).map(s => s.trim().slice(0, 200))
      : [];

    const update = {
      beneficios_principales:    sanitize(parsed.beneficios_principales),
      diferenciadores:           sanitize(parsed.diferenciadores),
      casos_de_uso:              sanitize(parsed.casos_de_uso),
      caracteristicas_visuales:  sanitize(parsed.caracteristicas_visuales),
      materiales_composicion:    sanitize(parsed.materiales_composicion),
      metadata: {
        ...(prod.metadata || {}),
        enriched_by:    `${MODEL}`,
        enriched_at:    new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };

    const { error: upErr } = await supabase.from("products").update(update).eq("id", productId);
    if (upErr) throw upErr;

    return {
      ok:                       true,
      product_id:                productId,
      benefits_count:            update.beneficios_principales.length,
      differentiators_count:     update.diferenciadores.length,
      use_cases_count:           update.casos_de_uso.length,
      visual_count:              update.caracteristicas_visuales.length,
      materials_count:           update.materiales_composicion.length,
      model:                     MODEL,
    };
  }
}
