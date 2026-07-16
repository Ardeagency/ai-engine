/**
 * vera-reading.schema.js — Contrato de bloques tipados de las lecturas del
 * dashboard que produce VERA (Sesión Dashboard).
 *
 * PRINCIPIOS:
 *  - JSON de BLOQUES TIPADOS, nunca HTML: el frontend renderiza con sus
 *    componentes y escapa todo texto (VERA lee contenido de internet — un
 *    caption malicioso jamás debe convertirse en markup ejecutable).
 *  - Toda afirmación central (insight/hypothesis/recommended_move) referencia
 *    evidencia resoluble del mapa `evidence` (regla heredada de vera_strategist:
 *    los insights centrales exigen >=3 datapoints de capas distintas).
 *  - ai-engine valida ANTES de persistir. Lo inválido no llega a la tabla.
 *
 * schema_version: 1
 */
import { z } from "zod";

export const READING_SCHEMA_VERSION = 1;

// El modelo improvisa sinónimos de dirección ("stable", "neutral") — se
// normalizan en vez de rechazar la lectura entera por un enum.
const DIR_NORM = {
  stable: "flat", steady: "flat", neutral: "flat", flat: "flat", igual: "flat",
  up: "up", sube: "up", alza: "up",
  down: "down", baja: "down", cae: "down",
  new: "new", nuevo: "new", nueva: "new",
  gone: "gone", desaparecio: "gone", "desapareció": "gone",
};
const normDir = (v) => (typeof v === "string" ? (DIR_NORM[v.toLowerCase().trim()] || v) : v);

const SHORT = z.string().min(1).max(140);
const BODY = z.string().min(1).max(650);
const QUOTE = z.string().min(1).max(280);
// Claves semánticas permitidas (ev1, ev_kit, ev_tour...) — VERA las usa y son
// más legibles; solo exigimos prefijo ev y caracteres seguros.
const EV_KEY = z.string().regex(/^ev[a-zA-Z0-9_]{0,24}$/, "evidence key debe empezar por 'ev'");
const EV_REFS = z.array(EV_KEY).min(1).max(8);

// ── Bloques del catálogo v1 ─────────────────────────────────────────────────
const insightBlock = z.object({
  type: z.literal("insight"),
  title: SHORT,
  body: BODY,
  severity: z.enum(["opportunity", "warning", "threat", "neutral"]),
  evidence: EV_REFS,
}).strict();

const triangulationBlock = z.object({
  type: z.literal("signal_triangulation"),
  signals: z.array(z.object({
    observation: z.string().min(1).max(280),
    source_ref: EV_KEY,
  }).strict()).min(2).max(5),
  so_what: BODY,
}).strict();

const hypothesisBlock = z.object({
  type: z.literal("hypothesis"),
  statement: BODY,
  confidence: z.enum(["alta", "media", "exploratoria"]),
  how_to_verify: z.string().min(1).max(280),
  evidence: EV_REFS,
}).strict();

const receiptBlock = z.object({
  type: z.literal("receipt"),
  quote: QUOTE,
  author_handle: z.string().max(80).optional().nullable(),
  platform: z.string().max(30).optional().nullable(),
  engagement: z.number().int().nonnegative().optional().nullable(),
  source_ref: EV_KEY,
}).strict();

const recommendedMoveBlock = z.object({
  type: z.literal("recommended_move"),
  action: BODY,
  rationale: BODY,
  urgency: z.enum(["hoy", "esta_semana", "este_mes"]),
  evidence: EV_REFS,
  // Brief PRODUCIBLE: lo que el equipo/flujo necesita para ejecutar sin
  // reinterpretar. Habilita "Aprobar y producir" en el dashboard.
  brief: z.object({
    formato: z.string().max(60).optional().nullable(),      // ej. carousel, reel, imagen
    canal: z.string().max(40).optional().nullable(),         // ej. instagram, tiktok
    copy_seed: z.string().max(280).optional().nullable(),    // semilla de copy lista
    visual_brief: z.string().max(280).optional().nullable(), // dirección visual
  }).strict().optional().nullable(),
  // Lo estampa ai-engine al persistir (strategic_recommendations.id) — VERA no lo emite.
  rec_id: z.string().uuid().optional().nullable(),
}).strict();

// Tile de estado: el número clave que se lee en 2 segundos. Van PRIMERO en la
// narrativa — el dashboard los renderiza como fila de KPIs con delta.
const statTileBlock = z.object({
  type: z.literal("stat_tile"),
  label: z.string().min(1).max(44),
  value: z.string().min(1).max(24),
  delta: z.string().max(28).optional().nullable(),
  direction: z.preprocess(normDir, z.enum(["up", "down", "flat"])).optional().nullable(),
  note: z.string().max(90).optional().nullable(),
}).strict();

const watchlistBlock = z.object({
  type: z.literal("watchlist_item"),
  what: SHORT,
  why_watching: BODY,
  check_back: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
}).strict();

const deltaBlock = z.object({
  type: z.literal("delta"),
  changed: BODY,
  direction: z.preprocess(normDir, z.enum(["up", "down", "new", "gone", "flat"])),
}).strict();

const blockSchema = z.discriminatedUnion("type", [
  statTileBlock,
  insightBlock,
  triangulationBlock,
  hypothesisBlock,
  receiptBlock,
  recommendedMoveBlock,
  watchlistBlock,
  deltaBlock,
]);

// ── Evidencia (refs resolubles por get_vera_evidence) ──────────────────────
// IDs laxos: idealmente UUIDs reales de tools, pero los tools a veces exponen
// ids externos/slugs. get_vera_evidence resuelve best-effort (resolved:false
// si no puede) — mejor una referencia imperfecta que rechazar la lectura.
const LAX_ID = z.string().min(3).max(120);
const evidenceEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("post"), post_id: LAX_ID, entity: z.string().max(120).optional().nullable(), note: z.string().max(200).optional().nullable() }).strict(),
  z.object({ kind: z.literal("comment"), post_id: LAX_ID, note: z.string().max(200).optional().nullable() }).strict(),
  z.object({ kind: z.literal("trend"), trend_topic_id: LAX_ID, keyword: z.string().max(120).optional().nullable() }).strict(),
  z.object({ kind: z.literal("signal"), signal_id: LAX_ID, note: z.string().max(200).optional().nullable() }).strict(),
  z.object({ kind: z.literal("web"), url: z.string().url().max(500), title: z.string().max(200).optional().nullable(), note: z.string().max(200).optional().nullable() }).strict(),
  z.object({ kind: z.literal("metric"), tool: z.string().max(60), note: z.string().max(280) }).strict(),
]);

// ── Lectura de UNA sección ──────────────────────────────────────────────────
export const scopeReadingSchema = z.object({
  headline: SHORT,
  narrative: z.array(blockSchema).min(1).max(12),
  evidence: z.record(EV_KEY, evidenceEntry).refine(
    (m) => Object.keys(m).length <= 24,
    { message: "máximo 24 entradas de evidencia" }
  ),
  meta: z.object({
    tone_of_reading: z.string().max(80).optional().nullable(),
    data_confidence: z.enum(["alta", "media", "baja"]).optional().nullable(),
    silence_ok: z.boolean().optional().nullable(),
  }).strict().optional().nullable(),
}).strict().superRefine((reading, ctx) => {
  // Toda referencia ev* usada en bloques debe existir en el mapa evidence
  const keys = new Set(Object.keys(reading.evidence || {}));
  const used = [];
  for (const b of reading.narrative) {
    if ("evidence" in b && Array.isArray(b.evidence)) used.push(...b.evidence);
    if ("source_ref" in b && b.source_ref) used.push(b.source_ref);
    if (b.type === "signal_triangulation") used.push(...b.signals.map((s) => s.source_ref));
  }
  for (const k of used) {
    if (!keys.has(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `referencia de evidencia huérfana: ${k}` });
    }
  }
});

export const SCOPES = ["mi_marca", "monitoreo", "tendencias", "estrategia"];

// ── Salida completa de la sesión (las 4 secciones) ─────────────────────────
export const dashboardReadingOutputSchema = z.object({
  mi_marca: scopeReadingSchema,
  monitoreo: scopeReadingSchema,
  tendencias: scopeReadingSchema,
  estrategia: scopeReadingSchema,
}).strict();

/**
 * Valida el output de la sesión. Devuelve { ok, data | errors }.
 * Los errores se devuelven en formato compacto para re-inyectarlos a VERA
 * en el reintento ("tu JSON falló por X — corrígelo").
 */
export function validateReadingOutput(raw) {
  const parsed = dashboardReadingOutputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors = parsed.error.issues.slice(0, 12).map(
    (i) => `${i.path.join(".")}: ${i.message}`
  );
  return { ok: false, errors };
}
