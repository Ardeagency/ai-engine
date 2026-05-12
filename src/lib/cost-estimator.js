/**
 * Cost estimator — predicción heurística (sin LLM) del costo USD que tendrá
 * un mensaje cuando OpenClaw lo procese, antes de invocarlo.
 *
 * Si supera el threshold per-org (`org_claude_caps.confirm_threshold_usd`),
 * el chat.controller pide confirmación al usuario antes de gastar tokens.
 *
 * La heurística NO es exacta — está sintonizada para ser conservadora:
 *   prefiere sobre-estimar y preguntar de más antes que dejar pasar una
 *   tarea de $20 sin advertencia. Calibrar con datos reales tras 1-2 semanas.
 */
import { supabase } from "./supabase.js";

const HEAVY_PATTERNS = [
  /\binvestig(a|ar|ación|ación profunda|ación exhaustiva)\b/i,
  /\banáli(sis|cis) (exhaustivo|profundo|completo|detallado)\b/i,
  /\b(deep|exhaustive|comprehensive)[ -]?research\b/i,
  /\btoda la web\b/i,
  /\btodos? los\b.*(competidores|productos|posts|marcas|catálogo|histórico)/i,
  /\btodas? las\b.*(marcas|posts|publicaciones|conversaciones)/i,
  /\bcatalog(a|ar)\b/i,
  /\bscraping (masivo|completo|de todo)\b/i,
  /\b(genera|crea|escribe)\b.*\b(\d{2,}|cien|mil|cincuenta)\b/i,        // "genera 50 variantes"
  /\b(análisis|reporte|informe) (mensual|anual|trimestral|completo)\b/i,
];

// Pricing alineado con anthropic-proxy (USD por millón de tokens). Fallback Sonnet.
const PRICE_INPUT  = 3.00;
const PRICE_OUTPUT = 15.00;

const TOKENS_PER_CHAR = 0.25; // ~1 token cada 4 chars (para mensajes en español)

function estimateInputTokens(text, attachments = []) {
  const textTokens = Math.ceil(String(text || "").length * TOKENS_PER_CHAR);
  // Cada attachment suma overhead — imagen ~1500 tokens, video/PDF ~3000.
  const attachOverhead = (attachments || []).reduce((s, a) => {
    if (!a) return s;
    const t = String(a.type || a.mime || "").toLowerCase();
    if (t.startsWith("image"))           return s + 1500;
    if (t.startsWith("video"))           return s + 4000;
    if (t.includes("pdf") || t.includes("document")) return s + 3000;
    return s + 500;
  }, 0);
  return textTokens + attachOverhead;
}

function detectHeavyKeywords(text) {
  const matches = [];
  for (const re of HEAVY_PATTERNS) {
    const m = String(text || "").match(re);
    if (m) matches.push(m[0]);
  }
  return matches;
}

/**
 * Promedio de USD por mensaje en los últimos 3 turnos de la org. Se usa como
 * piso para predicciones cuando el patrón histórico ya es alto.
 */
async function recentAvgUsdPerMessage(organizationId) {
  try {
    const { data } = await supabase
      .from("credit_usage")
      .select("usd_cost")
      .eq("organization_id", organizationId)
      .in("kind", ["vera_chat", "claude_describe"])
      .order("created_at", { ascending: false })
      .limit(3);
    if (!data?.length) return 0;
    const sum = data.reduce((s, r) => s + Number(r.usd_cost || 0), 0);
    return sum / data.length;
  } catch (_) {
    return 0;
  }
}

/**
 * Estima el costo USD esperado de un mensaje + duración aproximada.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {Array}  [args.attachments]
 * @param {string} args.organizationId — para leer cap de la org y promedio histórico
 *
 * @returns {Promise<{
 *   usd_estimate: number,        // mejor estimación
 *   usd_min: number,             // banda baja (50% del estimate)
 *   usd_max: number,             // banda alta (1.5× del estimate)
 *   minutes_min: number,
 *   minutes_max: number,
 *   reasons: string[],           // razones humanas
 *   threshold_usd: number,       // cap configurado
 *   confirm_required: boolean,   // true si usd_estimate >= threshold
 *   confirm_enabled: boolean,    // false → ignorar y procesar
 *   model: string,
 * }>}
 */
export async function estimateClaudeTaskCost({ message, attachments = [], organizationId }) {
  // Cargar config de la org en paralelo con el cálculo histórico.
  const [{ data: caps }, recentAvg] = await Promise.all([
    supabase
      .from("org_claude_caps")
      .select("confirm_threshold_usd, confirm_enabled")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    recentAvgUsdPerMessage(organizationId),
  ]);

  const thresholdUsd = Number(caps?.confirm_threshold_usd ?? 5.00);
  const confirmEnabled = caps?.confirm_enabled !== false;

  const inputTokens = estimateInputTokens(message, attachments);
  const heavyMatches = detectHeavyKeywords(message);
  const isHeavy = heavyMatches.length > 0;

  // Multiplicadores: las tareas pesadas amplifican output via tool-loops.
  const outputMultiplier = isHeavy ? 6 : 1.5;
  const baseOutputTokens = isHeavy ? 80_000 : 8_000;
  const expectedOutputTokens = Math.round(inputTokens * outputMultiplier + baseOutputTokens);

  // Tool calls añaden round-trips: cada uno reusa contexto + genera output.
  const expectedToolCalls = isHeavy ? 25 : 3;
  const toolUsdExtra = expectedToolCalls * 0.40; // promedio empírico

  const inputUsd  = (inputTokens          / 1e6) * PRICE_INPUT;
  const outputUsd = (expectedOutputTokens / 1e6) * PRICE_OUTPUT;
  const baseUsd   = inputUsd + outputUsd + toolUsdExtra;

  // Si el promedio histórico es más alto, lo usamos como piso (la org tiene
  // patrón de mensajes pesados — confiar más en histórico que en heurística).
  const usdEstimate = Math.max(baseUsd, recentAvg * 1.2);

  const reasons = [];
  if (isHeavy) reasons.push(`Palabras clave detectadas: ${heavyMatches.slice(0, 3).join(", ")}`);
  if (inputTokens > 5_000) reasons.push(`Input largo (~${inputTokens.toLocaleString()} tokens)`);
  if ((attachments || []).length >= 3) reasons.push(`${attachments.length} archivos adjuntos`);
  if (recentAvg > thresholdUsd / 2) reasons.push(`Promedio reciente alto ($${recentAvg.toFixed(2)}/mensaje)`);
  if (!reasons.length) reasons.push("Estimación basada en longitud y multiplicadores estándar");

  return {
    usd_estimate:  Number(usdEstimate.toFixed(2)),
    usd_min:       Number((usdEstimate * 0.6).toFixed(2)),
    usd_max:       Number((usdEstimate * 1.6).toFixed(2)),
    minutes_min:   isHeavy ? 5  : 1,
    minutes_max:   isHeavy ? 60 : 8,
    reasons,
    threshold_usd: thresholdUsd,
    confirm_required: confirmEnabled && usdEstimate >= thresholdUsd,
    confirm_enabled: confirmEnabled,
    model:         "claude-sonnet-4 (estimado)",
    debug: {
      input_tokens:        inputTokens,
      expected_output_tokens: expectedOutputTokens,
      expected_tool_calls: expectedToolCalls,
      heavy_matches:       heavyMatches,
      recent_avg_usd:      recentAvg,
    },
  };
}
