/**
 * content-citability.service.js — ¿es este contenido CITABLE por una IA?
 *
 * Rubrica reglada (Princeton "citability", GEO 2026), SIN LLM: los motores de IA
 * (respuestas de ChatGPT/Perplexity/Google AI) citan piezas que tienen estructura
 * extractable: TL;DR, respuestas directas, datos con fuente, tablas/listas, cita de
 * experto, definiciones, encabezados claros. Medimos la PRESENCIA de esas señales
 * en un texto y devolvemos un score + que falta para subir citas.
 *
 * Cierra la contradiccion de AISC: se mide visibilidad IA (Radiografia GEO) pero se
 * PRODUCE visual. Esta tool deja que Vera puntue un borrador de texto ANTES de
 * publicarlo, y guia generate_authority_cluster hacia lo que la IA realmente cita.
 *
 * Es determinista (reglas + conteos). Reusable desde chat y ciclo, cero creditos.
 */

// Pesos de cada factor (suman 100). Derivados de la rubrica de citabilidad GEO:
// lo que mas correlaciona con ser citado son datos-con-fuente y respuestas directas.
const FACTORS = [
  { key: "tldr",        label: "TL;DR / resumen al inicio",              weight: 15 },
  { key: "stats",       label: "Estadisticas / cifras concretas",        weight: 15 },
  { key: "sources",     label: "Fuentes citadas (enlaces / referencias)", weight: 20 },
  { key: "structure",   label: "Encabezados / seccionado claro",         weight: 12 },
  { key: "lists_tables",label: "Listas o tablas (datos estructurados)",   weight: 13 },
  { key: "expert_quote",label: "Cita de experto / atribucion",           weight: 10 },
  { key: "definitions", label: "Definiciones directas ('X es Y')",        weight: 8  },
  { key: "qa",          label: "Preguntas + respuestas directas",        weight: 7  },
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Cada detector devuelve un ratio 0..1 (que tan bien cumple el factor).
function detect(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const lines = t.split(/\r?\n/);
  const words = (t.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) || []).length;
  // paragraphs / secciones aproximadas
  const headings = lines.filter((l) => /^\s{0,3}#{1,6}\s+\S/.test(l) || /^\s{0,3}[A-ZÁÉÍÓÚÑ][^.!?]{0,60}:\s*$/.test(l)).length;
  const bulletLines = lines.filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length;
  const tableRows = lines.filter((l) => /\|.*\|/.test(l)).length;
  // stats: numeros con % / unidades / magnitudes ("30%", "3x", "1,200", "USD 5")
  const stats = (t.match(/\b\d[\d.,]*\s?(%|x\b|percent|por ciento|usd|eur|cop|mil|millones|k\b|bn\b)?/gi) || [])
    .filter((m) => /%|x|usd|eur|cop|mil|millones|k|bn|\d{3,}/i.test(m)).length;
  // fuentes: urls, "segun", "fuente:", "[1]", "(Autor, 2025)"
  const urls = (t.match(/https?:\/\/\S+/gi) || []).length;
  const citeMarks = (t.match(/\bseg[uú]n\b|\bfuente\s*:?|\[\d+\]|\(\s*\p{Lu}[\p{L} .]+,\s*\d{4}\s*\)/giu) || []).length;
  const sources = urls + citeMarks;
  // cita de experto: comillas + atribucion, o "dijo/afirma/segun <Nombre>"
  const quotes = (t.match(/[“"«][^”"»]{15,}[”"»]/g) || []).length;
  const attributions = (t.match(/\b(dijo|afirma|explica|seg[uú]n|declar[oó]|sostiene)\b/gi) || []).length;
  const expert = Math.min(quotes, attributions) + (quotes > 0 && /\bexperto|director|ceo|dr\.|investigador|analista\b/i.test(lower) ? 1 : 0);
  // definiciones: "X es/son/se define"
  const defs = (t.match(/\b[\p{Lu}][\p{L} ]{2,40}\s+(es|son|se define como|se refiere a)\s+/gu) || []).length;
  // Q&A: lineas que terminan en '?', o encabezados interrogativos
  const questions = (t.match(/[^.\n]{6,}\?/g) || []).length;
  // TL;DR explicito o resumen al inicio
  const hasTldr = /\btl;?dr\b|\bresumen\b|\ben resumen\b|\bclave[s]?:/i.test(lower.slice(0, 400));
  const secApprox = Math.max(1, headings, Math.ceil(words / 180));

  return {
    tldr:        hasTldr ? 1 : 0,
    stats:       clamp01(stats / Math.max(2, secApprox)),          // ~1 stat por seccion
    sources:     clamp01(sources / Math.max(2, secApprox)),        // ~1 fuente por seccion
    structure:   clamp01(headings / Math.max(2, Math.ceil(words / 220))),
    lists_tables:clamp01((bulletLines + tableRows) / Math.max(3, secApprox)),
    expert_quote:clamp01(expert / 1),
    definitions: clamp01(defs / Math.max(1, Math.ceil(secApprox / 2))),
    qa:          clamp01(questions / Math.max(1, Math.ceil(secApprox / 2))),
    _meta: { words, headings, bulletLines, tableRows, stats, sources, quotes, defs, questions, hasTldr },
  };
}

/**
 * scoreCitability(text) — puntua 0..100 la citabilidad IA de una pieza de texto.
 * @param {string} text
 * @returns {{ score:number, grade:string, breakdown:Array, missing:Array, suggestions:Array, meta:object }}
 */
export function scoreCitability(text) {
  const t = String(text || "").trim();
  if (t.length < 40) {
    return {
      score: 0, grade: "insuficiente",
      breakdown: [], missing: FACTORS.map((f) => f.label),
      suggestions: ["El texto es demasiado corto para evaluar citabilidad (min ~40 caracteres)."],
      meta: { words: (t.match(/\S+/g) || []).length },
    };
  }
  const r = detect(t);
  let score = 0;
  const breakdown = [];
  const missing = [];
  for (const f of FACTORS) {
    const ratio = clamp01(r[f.key]);
    const pts = Math.round(ratio * f.weight);
    score += pts;
    breakdown.push({ factor: f.label, ratio: Math.round(ratio * 100) / 100, points: pts, max: f.weight });
    if (ratio < 0.5) missing.push(f.label);
  }
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? "alta" : score >= 60 ? "media" : score >= 35 ? "baja" : "muy baja";

  // Sugerencias accionables, ordenadas por mayor punto perdido.
  const gap = FACTORS
    .map((f) => ({ f, lost: f.weight - Math.round(clamp01(r[f.key]) * f.weight) }))
    .filter((x) => x.lost > 0)
    .sort((a, b) => b.lost - a.lost);
  const TIPS = {
    tldr: "Agrega un TL;DR o parrafo-resumen de 2-3 lineas al inicio con la respuesta clave.",
    stats: "Incluye cifras concretas (%, magnitudes) — la IA cita datos, no adjetivos.",
    sources: "Cita fuentes: enlaces, 'segun <fuente>' o referencias [n]. Es el factor #1 de citabilidad.",
    structure: "Divide en secciones con encabezados claros (H2/H3) por subtema.",
    lists_tables: "Convierte enumeraciones en listas o tablas: la IA extrae datos estructurados.",
    expert_quote: "Agrega una cita textual atribuida a un experto o fuente con nombre y rol.",
    definitions: "Incluye una definicion directa del tipo 'X es Y' que la IA pueda extraer literal.",
    qa: "Formula preguntas frecuentes y respondelas de forma directa (formato Q&A).",
  };
  const suggestions = gap.slice(0, 5).map((x) => TIPS[x.f.key]).filter(Boolean);

  return { score, grade, breakdown, missing, suggestions, meta: r._meta };
}
