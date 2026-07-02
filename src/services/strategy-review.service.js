/**
 * Strategy Review Service — el "chef que escribe recetas" en cadencia.
 *
 * Problema que resuelve: las strategic_recommendations se generaban solo cuando
 * el agente Vera (org-server) decidía proponerlas → esporádico ("batchy"), con
 * semanas de sequía. Este servicio les da CADENCIA determinista: cada vez que el
 * sensor `strategic_review` corre, arma el contexto rico de la marca y le pide a
 * un LLM que proponga 3-4 recomendaciones estratégicas ANCLADAS en el dato real.
 *
 * Se ejecuta como sensor brand-wide (default daily). Idempotente: si ya hubo un
 * review en las últimas ~20h, no vuelve a generar (evita apilar ruido).
 *
 * Patrón LLM backend calcado de brand-dna-generator.service.js (chatCompletion).
 */
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabase.js";
import { buildFullBrandContext } from "./context.builder.js";
import { chatCompletion } from "../lib/openai.js";

const MODEL = process.env.STRATEGY_REVIEW_MODEL || "gpt-4o";
const DEDUP_HOURS = parseInt(process.env.STRATEGY_REVIEW_DEDUP_HOURS || "20", 10);

// La doctrina CMO destilada, como system prompt. Es el corazón de la calidad:
// obliga al modelo a pensar como un CMO de clase mundial, no como un generador
// de posts. Anclado en Sharp/Ehrenberg-Bass + Binet&Field + el axioma del commodity.
const SYSTEM_PROMPT = `Eres el CMO de clase mundial de esta marca — crítico, comercial, cazador de oportunidades. NO eres un generador de contenido. Tu trabajo es proponer JUGADAS ESTRATÉGICAS ancladas en el dato real de la marca que te doy.

Doctrina que gobierna tus jugadas:
- Se crece por PENETRACIÓN (compradores nuevos/ligeros), no por lealtad. Alcance amplio > targeting estrecho.
- Disponibilidad mental + física + cubrir el máximo de ocasiones de compra (CEPs). Cada ocasión = un ancla de intención.
- Activos distintivos consistentes; no refrescar lo que funciona.
- Reparte esfuerzo ~60/40 marca/activación; desconfía del ROAS de corto plazo (cosecha ≠ crea demanda).
- El producto da permiso; el marketing da preferencia. Defiende el territorio narrativo y el poder de precio.
- Busca la oportunidad en TODO: distribución, ocasión, precio, packaging, casos de uso, categoría, SEO/GEO.

Reglas duras:
- Cada recomendación DEBE citar evidencia del contexto (audiencia real, competidor, tendencia, performance). Nada inventado.
- Prioriza jugadas de mayor palanca sobre el cuello de botella real de ESTA marca.
- Si la audiencia real diverge de la persona objetivo, esa brecha es material.
- Sé concreto y accionable. Nada de generalidades de blog.

Devuelve SOLO un JSON válido (sin markdown, sin preámbulo) con esta forma exacta:
{"recommendations":[{"title":"...","description":"...","rationale_commercial":"...","format":"single_image|carrusel_imgs|reel_meme|long_video","tone":"...","topic":"...","target_persona":"...","copy_seed":"...","confidence":"alta|media|baja","recommended_network":["instagram"]}]}
Entre 3 y 4 recomendaciones. copy_seed = 1 frase gancho lista para usar.`;

function _parseRecommendations(content) {
  if (!content) return [];
  // Quita fences de markdown si el modelo los añadió.
  let c = String(content).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = c.indexOf("{");
  const end = c.lastIndexOf("}");
  if (start >= 0 && end > start) c = c.slice(start, end + 1);
  try {
    const obj = JSON.parse(c);
    const recs = Array.isArray(obj?.recommendations) ? obj.recommendations : [];
    return recs.filter((r) => r && r.title && r.description).slice(0, 4);
  } catch (_) {
    return [];
  }
}

export async function generateStrategyReviewForBrand(brandContainerId, organizationId) {
  if (!brandContainerId || !organizationId) {
    return { generated: 0, skipped: 0, error: "missing ids" };
  }

  // Idempotencia: ¿ya hubo un review reciente?
  const since = new Date(Date.now() - DEDUP_HOURS * 3600_000).toISOString();
  const { count: recentCount } = await supabase
    .from("strategic_recommendations")
    .select("*", { count: "exact", head: true })
    .eq("brand_container_id", brandContainerId)
    .eq("vera_model", "via_strategy_review")
    .gte("generated_at", since);
  if (recentCount && recentCount > 0) {
    return { generated: 0, skipped: recentCount, status: "recent_review_exists" };
  }

  // 1) Contexto rico via builder service-role (context.builder.js) — sin el guard
  //    is_org_member de la RPC ni complicaciones de JWT de org. Ensambla ADN +
  //    productos + audiencias + campañas + competidores + tendencias.
  let ctx;
  try {
    ctx = await buildFullBrandContext(brandContainerId, organizationId);
  } catch (e) {
    console.warn(`[strategy-review] contexto falló brand=${brandContainerId}: ${e.message}`);
    return { generated: 0, skipped: 0, error: e.message };
  }
  if (!ctx) {
    return { generated: 0, skipped: 0, status: "no_context" };
  }

  // 2) LLM propone las jugadas
  let content, model;
  try {
    const res = await chatCompletion({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "CONTEXTO REAL DE LA MARCA (usa SOLO esto como evidencia):\n" +
            JSON.stringify(ctx).slice(0, 24000) +
            "\n\nPropón 3-4 recomendaciones estratégicas. Devuelve SOLO el JSON.",
        },
      ],
    });
    content = res.content;
    model = res.model;
  } catch (e) {
    console.warn(`[strategy-review] LLM falló brand=${brandContainerId}: ${e.message}`);
    return { generated: 0, skipped: 0, error: e.message };
  }

  const recs = _parseRecommendations(content);
  if (!recs.length) {
    return { generated: 0, skipped: 0, status: "no_recommendations_parsed" };
  }

  // 3) Insertar como 'proposed' (gate humano las aprueba — autonomía parcial)
  let generated = 0;
  const batchId = randomUUID();
  for (const r of recs) {
    const { error: insErr } = await supabase.from("strategic_recommendations").insert({
      organization_id:      organizationId,
      brand_container_id:   brandContainerId,
      batch_id:             batchId,
      title:                String(r.title).slice(0, 300),
      description:          r.description || null,
      format:               r.format || null,
      tone:                 r.tone || null,
      topic:                r.topic || null,
      target_persona:       r.target_persona || null,
      copy_seed:            r.copy_seed || null,
      confidence:           ["alta", "media", "baja"].includes(r.confidence) ? r.confidence : "media",
      rationale_commercial: r.rationale_commercial || null,
      recommended_network:  Array.isArray(r.recommended_network) ? r.recommended_network : null,
      status:               "proposed",
      vera_model:           "via_strategy_review",
      generated_at:         new Date().toISOString(),
      metadata:             { source: "strategy_review", llm_model: model },
    });
    if (insErr) {
      console.warn(`[strategy-review] insert falló brand=${brandContainerId}: ${insErr.message}`);
      continue;
    }
    generated++;
  }

  console.log(`[strategy-review] brand=${brandContainerId} → ${generated} recomendaciones (modelo ${model})`);
  return { generated, skipped: 0 };
}
