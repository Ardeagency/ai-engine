/**
 * vera-cards.schema.js — Contrato de las CARDS del dashboard de VERA (cards.v3).
 *
 * EL PRINCIPIO (Cami): "El RPC no es el widget. La LECTURA que VERA hace del
 * RPC es el widget." La estructura la diseñamos nosotros; el CONTENIDO lo llena
 * VERA con libertad total. Mismo vaso, otro líquido.
 *
 * QUÉ CAMBIA FRENTE A cards.v2 (5 tipos temáticos: observacion / virtudes /
 * desventajas / audiencia / algoritmo):
 *  - v2 definía FORMATOS (markdown, chart, table) pero no exigía contenido
 *    estratégico. Sin contrato, `virtudes` salió como una lista de KPIs
 *    ("TikTok 71% view-rate · ROAS 12.5x") y `observacion` como un resumen —
 *    justo las dos cosas que Cami rechaza.
 *  - v3 vuelve a los 3 tipos de la taxonomía de Cami — indice / momento /
 *    decision — y cada uno EXIGE los campos que lo hacen un juicio. Lo que no
 *    es juicio (una métrica suelta) ya no puede ser card: baja a evidencia.
 *
 * LA REGLA DURA: `implicacion` y `apuesta` son obligatorios en toda decisión.
 * Son los dos campos que TODA propuesta anterior omitió, y sin ellos lo que
 * sale es una recomendación reactiva, no estrategia. El validador RECHAZA la
 * lectura si faltan — así "si es solo widget, falla" es regla de código y no
 * buena intención.
 *
 * TEST DE UNA PREGUNTA: cada card responde "¿y esto qué significa / qué hago?",
 * nunca "¿cuánto es X?".
 *
 * schema_version: 3
 */
import { z } from "zod";

export const CARDS_SCHEMA = "cards.v3";
export const CARDS_SCHEMA_VERSION = 3;

// Mínimos de longitud pensados como ANTI-RELLENO: un `implicacion` de 12
// caracteres ("es malo", "N/A") pasa un .min(1) y vacía el contrato de sentido.
const TITLE = z.string().min(4).max(90);
const LINE = z.string().min(12).max(180);   // lectura glanceable de una línea
const JUDGMENT = z.string().min(40).max(600); // afirmación con sustancia
const TONE = z.enum(["positive", "neutral", "warning", "critical"]);

// Refs de evidencia resolubles por get_vera_evidence. Se hereda la laxitud de
// v1 a propósito: VERA usa claves semánticas (ev_tiktok, ev1) e ids externos;
// una referencia imperfecta es mejor que rechazar la lectura entera.
const EV_KEY = z.string().regex(/^ev[a-zA-Z0-9_]{0,24}$/, "la clave de evidencia debe empezar por 'ev'");
const EV_REFS = z.array(EV_KEY).min(1).max(8);

/* ── BLOQUES DE PRESENTACIÓN ────────────────────────────────────────────────
   Se conservan TAL CUAL de cards.v2: el frontend ya los sabe pintar en estilo
   de marca (BrandGrid.mixin.js `_veraBlockHtml`). Son el "vaso" — no se tocan.
   VERA los usa para sustentar visualmente su juicio, nunca como la card misma. */
const markdownBlock = z.object({
  type: z.literal("markdown"),
  markdown: z.string().min(1).max(2000),
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

const pyramidBlock = z.object({
  type: z.literal("pyramid"),
  title: z.string().max(90).optional().nullable(),
  buckets: z.array(z.string().max(20)).max(12),
  left: z.object({ name: z.string().max(24), values: z.array(z.number()) }).strict(),
  right: z.object({ name: z.string().max(24), values: z.array(z.number()) }).strict(),
}).strict();

const choroplethBlock = z.object({
  type: z.literal("choropleth"),
  title: z.string().max(90).optional().nullable(),
  scope: z.enum(["world", "country"]).optional().nullable(),
  regions: z.array(z.object({
    code: z.string().max(8),            // ISO-3166 (CO, MX, US…)
    name: z.string().max(60).optional().nullable(),
    value: z.number(),
  }).strict()).max(80),
}).strict();

/* Bloque VIVO: no lleva datos, es un marcador de "aquí va el panel de producto".
   El frontend llama a dashboard_producto_estrella y pinta la ficha + la tabla
   con las imágenes que resuelve el propio RPC contra nuestro storage.
   POR QUÉ SIN DATOS: si VERA emitiera las cifras podría alterarlas, y si
   emitiera las URLs de imagen podría inyectar un destino arbitrario en el
   navegador del cliente (VERA lee contenido scrapeado — ese es el vector).
   Ella decide DÓNDE va el panel y escribe el juicio; el dato es autoritativo. */
const productoEstrellaBlock = z.object({
  type: z.literal("producto_estrella"),
  title: z.string().max(90).optional().nullable(),
}).strict();

const presentationBlock = z.discriminatedUnion("type", [
  markdownBlock, chartBlock, tableBlock, statBlock, pyramidBlock, choroplethBlock,
  productoEstrellaBlock,
]);
const BLOCKS = z.array(presentationBlock).max(8).optional().nullable();

/* ── TIPO 1 · ÍNDICE ────────────────────────────────────────────────────────
   Score 0-100 que VERA COMPUTA cruzando N fuentes. Clave: el número no sale de
   un RPC pintado como arco (eso es la trampa que Cami nombró) — sale del juicio
   de VERA, y viene acompañado de la lectura que lo explica. Sin `lectura` un
   índice es un número huérfano: por eso es obligatoria. */
const indiceCard = z.object({
  type: z.literal("indice"),
  title: TITLE,                       // ej. "Salud de marca", "Coherencia de tono"
  score: z.number().min(0).max(100),
  lectura: LINE,                      // qué significa ese número, en una línea
  tone: TONE,
  // Qué cruzó VERA para llegar al score. Hace auditable el índice y evita el
  // "87 porque sí". No es la fórmula: es lo que ella dice haber pesado.
  componentes: z.array(z.object({
    nombre: z.string().max(50),
    peso: z.string().max(40).optional().nullable(),  // ej. "40%", "señal fuerte"
    nota: z.string().max(140).optional().nullable(),
  }).strict()).min(2).max(6),
  evidence: EV_REFS,
  blocks: BLOCKS,
}).strict();

/* ── TIPO 2 · MOMENTO ───────────────────────────────────────────────────────
   Una SITUACIÓN, no una métrica. Reemplaza a `observacion` (que salía como
   resumen) y absorbe lo que antes eran `virtudes`/`desventajas`: que TikTok
   rinda no es una card, es evidencia. La card es la lectura de esa situación.
   `so_what` es obligatorio — es literalmente el test de una pregunta hecho
   campo: si VERA no puede decir qué significa, no hay momento que mostrar. */
const momentoCard = z.object({
  type: z.literal("momento"),
  title: TITLE,
  situacion: JUDGMENT,   // qué está pasando
  so_what: JUDGMENT,     // y esto qué significa  ← el campo que mata el resumen
  tone: TONE,
  evidence: EV_REFS,
  blocks: BLOCKS,
}).strict();

/* ── TIPO 3 · DECISIÓN ──────────────────────────────────────────────────────
   La card HÉROE: lo aprobable. Contrato de 7 campos definido por Cami.
   `implicacion` (qué significa para mi posición en la categoría) y `apuesta`
   (qué se gana o se arriesga en términos comerciales) son los dos que toda
   propuesta anterior omitió — van con mínimo de 40 caracteres para que no se
   rellenen con una frase hueca. */
const decisionCard = z.object({
  type: z.literal("decision"),
  title: TITLE,
  situacion: JUDGMENT,    // qué está pasando
  implicacion: JUDGMENT,  // qué significa para mi posición en la categoría
  jugada: JUDGMENT,       // qué hacer, concreto
  mecanismo: JUDGMENT,    // por qué eso funciona (algoritmo, psicología, canal)
  apuesta: JUDGMENT,      // qué se gana / qué se arriesga comercialmente
  ventana: z.enum(["hoy", "esta_semana", "este_mes", "este_trimestre"]),
  confianza: z.enum(["alta", "media", "exploratoria"]),
  tone: TONE,
  evidence: EV_REFS,
  // Brief PRODUCIBLE: lo que el equipo necesita para ejecutar sin reinterpretar.
  // Es lo que habilita "Aprobar y producir" (hereda el patrón de v1).
  brief: z.object({
    formato: z.string().max(60).optional().nullable(),
    canal: z.string().max(40).optional().nullable(),
    copy_seed: z.string().max(280).optional().nullable(),
    visual_brief: z.string().max(280).optional().nullable(),
  }).strict().optional().nullable(),
  // Lo estampa ai-engine al persistir (strategic_recommendations.id). VERA no lo emite.
  rec_id: z.string().uuid().optional().nullable(),
  blocks: BLOCKS,
}).strict();

/* ── TIPO 4 · INGREDIENTE ───────────────────────────────────────────────────
   El par Virtudes/Desventajas, reencuadrado (JC 2026-07-21): NO dan métricas —
   dan el INGREDIENTE SECRETO que potencia tu contenido y lo que lo COLAPSA.
   La diferencia es causal, no de signo:
     ❌ v2:  "TikTok genera 71% de view-rate"            (métrica en verde)
     ✅ v3:  "Grabar la receta en una sola toma continua, con el producto en la
              mano y sonido ambiente real — sin cortes ni música — es lo que
              dispara tu retención: el espectador no siente publicidad."
   Por eso `ingrediente` y `mecanismo` son obligatorios y largos: un número
   suelto no cabe en ellos. `polaridad` conserva el par hermano verde/rojo que
   el frontend ya pinta (_veraDuoHtml). */
const ingredienteCard = z.object({
  type: z.literal("ingrediente"),
  polaridad: z.enum(["potencia", "colapsa"]),
  title: TITLE,
  // QUÉ es exactamente — el gesto, el formato, la decisión creativa concreta.
  // No "el engagement" ni "la cadencia": el ingrediente que se puede repetir
  // (o dejar de hacer) mañana.
  ingrediente: JUDGMENT,
  // POR QUÉ produce ese efecto: algoritmo, psicología del espectador, canal.
  mecanismo: JUDGMENT,
  // Dónde se ve operando, para que sea verificable y no una intuición.
  donde_se_ve: z.string().min(20).max(400),
  tone: TONE,
  evidence: EV_REFS,
  blocks: BLOCKS,
}).strict();

const cardSchema = z.discriminatedUnion("type", [indiceCard, momentoCard, decisionCard, ingredienteCard]);

/* ── LA LECTURA COMPLETA ────────────────────────────────────────────────────
   Regla de jerarquía de Cami: "decisión arriba, evidencia abajo". Se exige AL
   MENOS UNA decisión — si la lectura no llega a nada aprobable, no es un
   dashboard de decisiones, es un informe. El ORDEN de render lo impone el
   frontend (decision primero); el array puede venir en cualquier orden. */
export const cardsReadingSchema = z.object({
  schema: z.literal(CARDS_SCHEMA),
  cards: z.array(cardSchema).min(2).max(8)
    .refine((cs) => cs.some((c) => c.type === "decision"), {
      message: "la lectura debe traer al menos una card de tipo 'decision' — sin algo aprobable es un informe, no un dashboard",
    }),
}).strict();

/**
 * Valida una lectura cards.v3.
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 *   `errors` vuelve en lenguaje corto para reinyectarlo a VERA en el reintento:
 *   decirle exactamente qué campo faltó es lo que hace que la segunda pasada
 *   sirva (antes se le repetía "falta el sobre" sin más pistas).
 */
export function validateCardsReading(raw) {
  const parsed = cardsReadingSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors = parsed.error.issues.slice(0, 12).map((i) => {
    const path = i.path.join(".") || "(raíz)";
    return `${path}: ${i.message}`;
  });
  return { ok: false, errors };
}
