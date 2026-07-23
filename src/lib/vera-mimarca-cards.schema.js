/**
 * vera-mimarca-cards.schema.js — Contrato de las CARDS del tab MI MARCA (cards.v2).
 *
 * EL PRINCIPIO (libertad controlada): el frontend define los MOLDES (las
 * tarjetas del tab Mi Marca) y VERA los LLENA con su juicio. El "vaso" es fijo;
 * el "liquido" es de Vera. Este contrato es el vaso.
 *
 * POR QUÉ EXISTE SEPARADO DE cards.v3 (vera-cards.schema.js):
 *  - El tab Mi Marca (BrandGrid.mixin.js) renderiza tipos temáticos concretos —
 *    observacion / virtudes / desventajas / audiencia / audiencias_recomendadas
 *    / algoritmo — que NO son los de v3 (indice/momento/decision/ingrediente).
 *    v3 vive en el scope 'diagnostico' y se deja como está.
 *  - Más importante: los BLOQUES de visualización usan NOMBRES DE CAMPO DISTINTOS
 *    a v3. Lo que pinta el frontend v2 manda:
 *      · pyramid  → { groups[], male[], female[] }   (NO buckets/left/right)
 *      · choropleth → { data:[{code,name,value}] }    (NO regions)
 *    (ver BrandGrid.mixin.js `_paintPyramid` / `_paintChoropleth`).
 *
 * DISCIPLINA HEREDADA DE v3 (anti-KPI): cada card es un JUICIO, no un número.
 * Las cards de texto exigen `markdown` con sustancia (min 60 chars); un dato
 * suelto ("47 posts", "4.2% engagement") no cabe ahí y baja a evidencia/bloque.
 *
 * schema_version: 2
 */
import { z } from "zod";

export const MIMARCA_SCHEMA = "cards.v2";
export const MIMARCA_SCHEMA_VERSION = 2;

const TONE = z.enum(["positive", "neutral", "warning", "critical"]);
const TITLE = z.string().min(3).max(90);
// El juicio escrito. Min alto a propósito: es la barrera anti-relleno que
// impide que una card de texto sea una métrica disfrazada de frase.
const JUDGMENT_MD = z.string().min(60).max(2000);

/* ── BLOQUES DE PRESENTACIÓN ────────────────────────────────────────────────
   Nombres de campo EXACTOS que pinta BrandGrid.mixin.js (`_veraBlockHtml`,
   `_paintVeraCharts`, `_paintPyramid`, `_paintChoropleth`, `_veraTableHtml`).
   Son el sustento visual del juicio — nunca la card en sí. */
const markdownBlock = z.object({
  type: z.literal("markdown"),
  markdown: z.string().min(1).max(2000),
  title: z.string().max(90).optional().nullable(),
}).strict();

const chartBlock = z.object({
  type: z.literal("chart"),
  title: z.string().max(90).optional().nullable(),
  kind: z.enum(["bar", "line", "donut", "area"]),
  labels: z.array(z.string().max(40)).max(40),
  series: z.array(z.object({
    name: z.string().max(40).optional().nullable(),
    values: z.array(z.number()).max(40),
  }).strict()).min(1).max(4),
  format: z.enum(["number", "percent"]).optional().nullable(),
}).strict();

const tableBlock = z.object({
  type: z.literal("table"),
  title: z.string().max(90).optional().nullable(),
  columns: z.array(z.string().max(40)).min(1).max(6),
  rows: z.array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(6)).max(20),
}).strict();

const statBlock = z.object({
  type: z.literal("stat"),
  value: z.union([z.string().max(24), z.number()]),
  label: z.string().max(60),
}).strict();

// Pyramid v2: barras espejadas hombres/mujeres por grupo de edad.
const pyramidBlock = z.object({
  type: z.literal("pyramid"),
  title: z.string().max(90).optional().nullable(),
  groups: z.array(z.string().max(20)).min(1).max(12),
  male: z.array(z.number()).max(12),
  female: z.array(z.number()).max(12),
}).strict();

// Choropleth v2: intensidad por país. code = ISO-2 o ISO-3 (el pintor mapea).
const choroplethBlock = z.object({
  type: z.literal("choropleth"),
  title: z.string().max(90).optional().nullable(),
  data: z.array(z.object({
    code: z.string().max(8),
    name: z.string().max(60).optional().nullable(),
    value: z.number(),
  }).strict()).min(1).max(80),
}).strict();

// Bloque VIVO: marcador de "aquí va el panel de producto". Sin datos — el
// frontend llama a dashboard_producto_estrella y pinta cifras+imágenes
// autoritativas (Vera no emite números ni URLs; ese es el vector de inyección).
const productoEstrellaBlock = z.object({
  type: z.literal("producto_estrella"),
  title: z.string().max(90).optional().nullable(),
}).strict();

const presentationBlock = z.discriminatedUnion("type", [
  markdownBlock, chartBlock, tableBlock, statBlock, pyramidBlock, choroplethBlock,
  productoEstrellaBlock,
]);
const BLOCKS = z.array(presentationBlock).max(8).optional().nullable();

/* ── CARDS DE TEXTO (juicio) ────────────────────────────────────────────────
   observacion · virtudes · desventajas · algoritmo. Exigen `markdown` con
   sustancia; `blocks` es opcional para sustentar. */
const textCard = (t) => z.object({
  type: z.literal(t),
  title: TITLE.optional().nullable(),
  tone: TONE.optional().nullable(),
  markdown: JUDGMENT_MD,
  blocks: BLOCKS,
}).strict();

const observacionCard = textCard("observacion");
const virtudesCard = textCard("virtudes");
const desventajasCard = textCard("desventajas");
const algoritmoCard = textCard("algoritmo");

/* ── AUDIENCIA (viz) ────────────────────────────────────────────────────────
   Quién te sigue: choropleth + pyramid + comentario. OPCIONAL — solo si hay
   datos demográficos reales; una card inventada es peor que su ausencia. */
const audienciaCard = z.object({
  type: z.literal("audiencia"),
  title: TITLE.optional().nullable(),
  tone: TONE.optional().nullable(),
  blocks: z.array(presentationBlock).min(1).max(8),
}).strict();

/* ── AUDIENCIAS RECOMENDADAS ─────────────────────────────────────────────────
   Fichas accionables: a quién debería hablarle la marca. `id` es la clave que
   el frontend usa para descartar/deduplicar (un slug tuyo, ej. "aud_reposteros").
   Se nombran como un GRUPO DE GENTE, no por demografía. */
const audienciasRecomendadasCard = z.object({
  type: z.literal("audiencias_recomendadas"),
  title: TITLE.optional().nullable(),
  items: z.array(z.object({
    id: z.string().min(2).max(48),
    name: z.string().min(2).max(60),
    priority: z.enum(["alta", "media", "baja"]),
    rationale: z.string().max(160).optional().nullable(),
    interests: z.array(z.string().max(40)).max(6).optional().nullable(),
  }).strict()).min(2).max(8),
}).strict();

const cardSchema = z.discriminatedUnion("type", [
  observacionCard, virtudesCard, desventajasCard, algoritmoCard,
  audienciaCard, audienciasRecomendadasCard,
]);

// Los moldes que el tab exige llenar. `audiencia` (viz) queda fuera: depende de
// datos demográficos que no toda marca tiene, y un mapa inventado envenena.
const REQUIRED_TYPES = ["observacion", "virtudes", "desventajas", "algoritmo", "audiencias_recomendadas"];

/* ── LA LECTURA COMPLETA ────────────────────────────────────────────────────
   Libertad controlada como regla de código: la lectura DEBE traer las 5 cards
   obligatorias. Si falta alguna, el molde queda vacío en el dashboard — por eso
   se rechaza y se le devuelve a Vera exactamente cuál faltó. */
export const mimarcaCardsSchema = z.object({
  schema: z.literal(MIMARCA_SCHEMA),
  cards: z.array(cardSchema).min(5).max(10).superRefine((cs, ctx) => {
    const present = new Set(cs.map((c) => c.type));
    for (const t of REQUIRED_TYPES) {
      if (!present.has(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `falta la card obligatoria '${t}' — el molde de Mi Marca la exige`,
        });
      }
    }
  }),
}).strict();

/**
 * Valida una lectura cards.v2 del tab Mi Marca.
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 *   `errors` en lenguaje corto por campo para reinyectarlo a VERA en el reintento.
 */
export function validateMiMarcaCards(raw) {
  const parsed = mimarcaCardsSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors = parsed.error.issues.slice(0, 12).map((i) => {
    const path = i.path.join(".") || "(raíz)";
    return `${path}: ${i.message}`;
  });
  return { ok: false, errors };
}
