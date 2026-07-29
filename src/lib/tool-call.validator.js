/**
 * Tool Call Validator — valida la forma y seguridad de las tool_calls que devuelve OpenClaw.
 *
 * Protege contra:
 *   - Tools no registradas (hallucination de nombres)
 *   - Parámetros mal tipados (UUID inválidos, objetos en lugar de strings, etc.)
 *   - Prototype pollution / injection patterns
 *   - Exceso de tool_calls por ronda
 */
import { AVAILABLE_TOOL_NAMES } from "../services/tool.dispatcher.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DANGEROUS_PATTERNS = ["__proto__", "constructor", "prototype", "<script", "DROP TABLE", "--"];

// Campos de TEXTO LIBRE por tool: su valor es contenido natural/markdown (no
// fluye a SQL), así que el escaneo anti-inyección SQL (p.ej. "--" en tablas o
// separadores markdown) produce falsos positivos. A estos campos se les exime
// del escaneo SQL completo, pero igual se les aplica un escaneo ESTRICTO
// (XSS/prototype) para que un <script> o __proto__ nunca pase al renderer.
const FREETEXT_PARAMS = { createArtifact: ["content", "html"], webSearch: ["query"], initiateConversation: ["opening_message", "topic", "reason"], scoreContentCitability: ["text"] };
const STRICT_PATTERNS = ["<script", "__proto__", "javascript:", "onerror="];

const MAX_TOOL_CALLS_PER_ROUND = 5;

// Esquema de validación por tool: campo → tipo esperado
// "uuid" = string UUID | "object" = plain object | "boolean" = bool | "string" = string
export const TOOL_SCHEMAS = {
  // Escritura del tablero. Sin esto la tool queda registrada pero SIN parametros
  // en el esquema MCP: Vera la ve, la llama, y no tiene por donde pasarle nada.
  // Lo detecto ella misma en la primera prueba — "el schema no expone ningun
  // parametro, asi que no hay forma de pasarle el brandContainerId".
  publishMiMarcaCard:      { brandContainerId: "uuid", periodo: "string", card: "object" },
  getMiMarcaProgress:      { brandContainerId: "uuid" },
  updateMiMarcaCardItems:  { brandContainerId: "uuid", periodo: "string", cardType: "string", agregar: "array", eliminar: "array" },
  getPublicacionDestacada:     { brandContainerId: "uuid", periodo: "string" },
  explainPublicacionDestacada: { brandContainerId: "uuid", postId: "uuid", analisis: "string" },
  verPublicacion:              { postId: "uuid" },
  // ── Esquemas que faltaban ─────────────────────────────────────────────
  // Sin entrada aqui, el MCP le expone la tool con properties vacio: Vera la
  // ve, la llama, y no tiene por donde pasarle nada. Lo detecto ella sola dos
  // veces el 2026-07-28 — 22 tools estaban asi, getAdsBreakdown incluida.
  listToolsFor:                 { scope: "string" },
  getBodyMissions:              { status: "string", limit: "string" },
  getPendingActions:            { status: "string", limit: "string" },
  getPendingActionDetail:       { action_id: "uuid" },
  getStrategyOpportunityScore:  { brandContainerId: "uuid", limit: "string" },
  getCompetitorAnalysis:        { brandContainerId: "uuid", entityName: "string" },
  runContentFlow:               { flowSlug: "string", inputs: "object" },
  getMetaPageInsights:          { brandContainerId: "uuid", range: "string" },
  getMetaPosts:                 { brandContainerId: "uuid", limit: "string" },
  getInstagramInsights:         { brandContainerId: "uuid", range: "string" },
  getInstagramPosts:            { brandContainerId: "uuid", limit: "string" },
  getAdsBreakdown:              { organizationId: "uuid", groupBy: "string", days: "string", limit: "string" },
  getGoogleAnalytics:           { range: "string", propertyId: "string" },
  getPenetrationDiagnosis:      { brandContainerId: "uuid", windowDays: "string" },
  getCEPGaps:                   { brandContainerId: "uuid", windowDays: "string" },
  getDemandDiagnosis:           { brandContainerId: "uuid", windowDays: "string" },
  getConversionOutcomes:        { brandContainerId: "uuid", windowDays: "string" },
  scoreContentCitability:       { text: "string" },
  getUseCaseExpansion:          { brandContainerId: "uuid" },
  getDistinctiveAssetsAudit:    { brandContainerId: "uuid" },
  describirPublicacion:        { postId: "uuid", descripcion: "string" },
  getMaterialDeCodigos:        { brandContainerId: "uuid", maxPiezas: "string" },
  getMaterialDeEmpaque:        { brandContainerId: "uuid", maxImagenes: "string" },
  registrarMedicionDeCodigos:  { brandContainerId: "uuid", mediciones: "object" },
  getSerieDeCodigos:           { brandContainerId: "uuid", desde: "string" },
  getBrandContainers:      {},
  getBrandProfile:         { brandContainerId: "uuid" },
  getAudiences:            { brandContainerId: "uuid" },
  getBrandEntities:        { brandContainerId: "uuid" },
  getProducts:             { brandContainerId: "uuid" },
  getIntegrations:         { brandContainerId: "uuid" },
  getIntelligenceEntities: { brandContainerId: "uuid" },
  getIntelligenceSignals:  { entityId: "uuid", brandContainerId: "uuid" },
  getBrandPosts:           { brandContainerId: "uuid" },
  getTrendTopics:          { brandContainerId: "uuid" },
  getRetailPrices:         { brandContainerId: "uuid" },
  getCampaigns:            { brandContainerId: "uuid" },
  getCampaignDetail:       { campaignId: "uuid", brandContainerId: "uuid" },
  harvestPostComments:     { brand_post_id: "uuid", cap: "string", reason: "string" },
  getHarvestedComments:    { job_id: "string", limit: "string" },
  getAvailableFlows:       {},
  getUpcomingDates:        {},
  getFlowSchedules:        { brandContainerId: "uuid" },
  getFlowRuns:             { brandContainerId: "uuid" },
  getFlowRunOutputs:       { runId: "uuid", brandContainerId: "uuid" },
  likeFlow:                { flowId: "uuid" },
  createFlowSchedule:      { params: "object", brandContainerId: "uuid" },
  triggerFlowRun:          { params: "object", brandContainerId: "uuid" },

  // VERA Cycle Pulse tools
  createOrgNotification:         { title: "string", body: "string", severity: "string", type: "string", action_url: "string", action_label: "string", brand_container_id: "uuid", metadata: "object", params: "object" },
  createNotification:            { title: "string", body: "string", severity: "string", type: "string", action_url: "string", action_label: "string", brand_container_id: "uuid", metadata: "object", params: "object" },
  proposeStrategicRecommendation:{ title: "string", description: "string", topic: "string", tone: "string", mood: "string", confidence: "string", rationale: "string", brand_container_id: "uuid", anchor_product_name: "string", target_persona: "string" },
  proposePendingAction:          { params: "object", brandContainerId: "uuid" },
  getBrainFeed:                  { feed_id: "uuid", bucket: "string" },
  // Command Center / canvas de estrategia
  placeNodeOnCanvas: { strategy_id: "uuid", node_type: "string", node_id: "uuid", position_x: "string", position_y: "string", reason: "string" },
  moveNodeOnCanvas: { placement_id: "uuid", position_x: "string", position_y: "string", reason: "string" },
  removeNodeFromCanvas: { placement_id: "uuid", reason: "string" },
  connectNodes: { strategy_id: "uuid", source_type: "string", source_id: "uuid", target_type: "string", target_id: "uuid", reason: "string", edge_kind: "string", label: "string" },
  disconnectNodes: { edge_id: "uuid", reason: "string" },
  setVeraState: { placement_id: "uuid", state: "string", reasoning: "string" },
  createStrategy: { brand_container_id: "uuid", name: "string", description: "string", reason: "string" },
  listStrategies: { brand_container_id: "uuid" },
  createStickyNote: { strategy_id: "uuid", content: "string", reason: "string" },
  createGroup: { strategy_id: "uuid", title: "string", reason: "string" },
  buildStrategy: { brand_container_id: "uuid", name: "string", goal: "string", reason: "string", objetivo: "string", budget_total: "string", budget_daily: "string" },
  proposeExternalAction: { action_type: "string", target_table: "string", vera_reasoning: "string" },

  // ── Aliases canonicos v3 (mismas validaciones que los canonical correspondientes) ──
  getBrandDNA:               { brandContainerId: "uuid" },
  getPendingBriefs:          {},
  getFlows:                  {},
  getFlowInputs:             { flowId: "uuid", params: "object", brandContainerId: "uuid" },
  forgeProductionPrompt:     { params: "object", brandContainerId: "uuid" },
  // El input REAL de KIE, declarado entero. Desde que se quito el LLM intermedio
  // (2026-07-28) el `prompt` de Vera viaja verbatim al proveedor: si no ve los
  // campos, no puede dirigir la pieza. Antes esto era `params: "object"` — un
  // saco opaco — y ella tenia que adivinar que ponerle.
  generateImageDirect: {
    params: {
      type: "object",
      description: "input de KIE (modelo nano-banana-pro). Tu escribes el prompt final: NO hay otro modelo que lo reescriba.",
      properties: {
        prompt: {
          type: "string",
          description: "OBLIGATORIO. La imagen COMPLETA descrita por ti, tal cual se va a generar: sujeto, accion, escena, luz, paleta, encuadre/plano, estilo, y el texto exacto si la pieza lleva texto. Entre 10 y 5000 caracteres. Lo que escribas es lo que sale — un prompt vago da una imagen generica.",
        },
        image_input: {
          type: "array",
          items: { type: "string" },
          description: "Opcional. Hasta 5 URLs http(s) publicas de imagenes de REFERENCIA (foto del producto, pieza previa, rostro de un personaje) para que la generacion parta de ellas. Vacio o ausente = texto a imagen.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"],
          description: "Encuadre. Default 1:1. Feed de Instagram 4:5, historias y Reels 9:16, portada web 16:9.",
        },
        resolution: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Default 2K. 1K para bocetos y pruebas (mas barato), 4K solo si la pieza se va a imprimir o ampliar.",
        },
        output_format: {
          type: "string",
          enum: ["png", "jpg"],
          description: "Default png. Usa png si lleva texto o necesita transparencia; jpg si es una foto y pesa mucho.",
        },
      },
      required: ["prompt"],
    },
    brandContainerId: "uuid",
  },
  generateVideoDirect: {
    params: {
      type: "object",
      description: "input de KIE (modelo bytedance/seedance-2-fast). Tu escribes el prompt final: NO hay otro modelo que lo reescriba.",
      properties: {
        prompt: {
          type: "string",
          description: "OBLIGATORIO. El plano COMPLETO descrito por ti: sujeto, accion, movimiento de camara, ambiente, luz, paleta y estilo. Entre 10 y 5000 caracteres. Lo que escribas es lo que sale.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
          description: "Encuadre. Default 16:9. Reels/TikTok/historias 9:16.",
        },
        resolution: {
          type: "string",
          enum: ["480p", "720p", "1080p", "4k"],
          description: "Default 720p. 480p para bocetos (mas barato). La variante rapida puede no servir 1080p/4k: si el proveedor lo rechaza te lo digo con su mensaje.",
        },
        duration: {
          type: "integer",
          minimum: 4,
          maximum: 15,
          description: "Segundos de video, NUMERO entero entre 4 y 15. Default 5. Cada segundo cuesta: pide 15 solo si el plano lo necesita.",
        },
        first_frame_url: {
          type: "string",
          description: "Opcional. URL http(s) publica de una imagen que sera el PRIMER fotograma. Sirve para animar una pieza que ya generaste con generateImageDirect.",
        },
        last_frame_url: {
          type: "string",
          description: "Opcional. URL http(s) publica de la imagen que sera el ULTIMO fotograma. Con first_frame_url, define un recorrido entre dos imagenes fijas.",
        },
        reference_image_urls: {
          type: "array",
          items: { type: "string" },
          description: "Opcional. Hasta 5 URLs http(s) de imagenes de referencia de ESTILO o de personaje (para que el video se parezca a ellas, no para usarlas como fotogramas).",
        },
        reference_video_urls: {
          type: "array",
          items: { type: "string" },
          description: "Opcional. Hasta 5 URLs http(s) de videos de referencia: de ahi toma movimiento y ritmo.",
        },
        reference_audio_urls: {
          type: "array",
          items: { type: "string" },
          description: "Opcional. Hasta 5 URLs http(s) de audio de referencia (voz o musica a la que ajustarse).",
        },
        generate_audio: {
          type: "boolean",
          description: "Opcional. true = el modelo genera pista de audio. Default del proveedor si no lo pones.",
        },
        return_last_frame: {
          type: "boolean",
          description: "Opcional. true = devuelve tambien el ultimo fotograma como imagen. Util para encadenar un segundo plano que siga a este.",
        },
        web_search: {
          type: "boolean",
          description: "Opcional. true = el modelo consulta la web para referencias visuales reales (una marca, un lugar, una persona publica).",
        },
      },
      required: ["prompt"],
    },
    brandContainerId: "uuid",
  },
  getRunsAwaitingApproval:   { brandContainerId: "uuid" },
  approveRunStage:           { params: "object", brandContainerId: "uuid" },
  getScraperStatus:          {},
  updateBrandDNA:            { params: "object" },
  updateProduct:             { params: "object" },
  updateAudienceConcept:     { params: "object" },
  addCompetitorToMonitoring: { handle: "string" },
  triggerFlow:               { params: "object", brandContainerId: "uuid" },
  inspectRun:                { runId: "uuid" },

  // ── Outcomes — loop de retroalimentación (lectura) ───────────────────────
  getActionOutcomes:         { verdict: "string", since: "string", limit: "string" },
  getActionOutcomeDetail:    { action_id: "uuid" },
  getOutcomeSummary:         { window_days: "string" },

  // ── Fase B bloque 1: tools MISSING v3 implementadas ─────────────────────
  getMonitoringTriggers:     { brandContainerId: "uuid" },
  getMonitoringTargets:      { brandContainerId: "uuid" },
  pauseFlow:                 { params: "object" },
  updateCampaignConcept:     { params: "object" },
  addKeywordToTrends:        { params: "object" },
  generateTrendBrief:        { params: "object" },
  removeKeywordFromTrends:   { params: "object" },
  createDefensiveWatch:      { params: "object" },
  triggerDeepScrape:         { params: "object" },
  getBrandHealthMetrics:     { brandContainerId: "uuid" },
  searchIntelligence:        { params: "object" },
  webSearch:                 { params: "object" },
  webFetch:                  { params: "object" },
  getBrandKit:               { params: "object" },
  createArtifact:            { params: "object" },
  listArtifacts:             { params: "object" },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function isValidUUID(val) {
  return typeof val === "string" && UUID_RE.test(val);
}

function hasDangerousContent(raw) {
  const s = String(raw).toLowerCase();
  return DANGEROUS_PATTERNS.some((p) => s.includes(p.toLowerCase()));
}

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Valida un único tool_call { name, params }.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return { valid: false, reason: "tool_call debe ser un objeto" };
  }

  const { name, params } = toolCall;

  // 1. Name check
  if (typeof name !== "string" || !name.trim()) {
    return { valid: false, reason: "tool_call.name debe ser un string no vacío" };
  }

  if (!AVAILABLE_TOOL_NAMES.includes(name)) {
    return {
      valid: false,
      reason: `Tool "${name}" no está en la lista de herramientas permitidas`,
    };
  }

  // 2. Params structure
  const p = params ?? {};
  if (typeof p !== "object" || Array.isArray(p) || p === null) {
    return { valid: false, reason: "tool_call.params debe ser un objeto plano" };
  }

  // 3. Injection / prototype pollution check
  // Para tools con campos de texto libre (markdown), escaneamos los params SIN
  // esos campos contra los patrones completos (incluye SQL "--"), y aparte
  // escaneamos el texto libre solo contra patrones ESTRICTOS (XSS/proto).
  const freetextFields = FREETEXT_PARAMS[name] || [];
  let scanTarget = p;
  let freetextBlob = "";
  if (freetextFields.length) {
    scanTarget = JSON.parse(JSON.stringify(p));
    const inner = (scanTarget.params && typeof scanTarget.params === "object") ? scanTarget.params : scanTarget;
    for (const f of freetextFields) {
      if (inner[f] !== undefined) { freetextBlob += " " + String(inner[f]); delete inner[f]; }
    }
  }
  if (hasDangerousContent(JSON.stringify(scanTarget))) {
    return { valid: false, reason: "tool_call.params contiene patrones no permitidos" };
  }
  if (freetextBlob) {
    const lower = freetextBlob.toLowerCase();
    if (STRICT_PATTERNS.some((x) => lower.includes(x))) {
      return { valid: false, reason: "tool_call.params: el contenido contiene patrones no permitidos (script/proto)" };
    }
  }

  // 4. Field type validation per schema
  const schema = TOOL_SCHEMAS[name] ?? {};
  for (const [field, spec] of Object.entries(schema)) {
    const val = p[field];
    if (val === undefined || val === null || val === "") continue; // optional fields skip

    // Un spec puede venir como tipo ("uuid") o como JSON Schema completo (ver
    // TOOL_SCHEMAS). En el segundo caso aqui solo se comprueba la FORMA externa;
    // los campos internos los valida el servicio, que puede explicar el porque.
    const expectedType = (spec && typeof spec === "object") ? (spec.type || "object") : spec;

    if (expectedType === "uuid") {
      if (!isValidUUID(val)) {
        return {
          valid: false,
          reason: `Parámetro "${field}" en tool "${name}" debe ser un UUID válido (recibido: ${JSON.stringify(val)})`,
        };
      }
    } else if (expectedType === "object") {
      if (typeof val !== "object" || Array.isArray(val)) {
        return {
          valid: false,
          reason: `Parámetro "${field}" en tool "${name}" debe ser un objeto`,
        };
      }
    } else if (expectedType === "boolean") {
      if (typeof val !== "boolean") {
        return {
          valid: false,
          reason: `Parámetro "${field}" en tool "${name}" debe ser boolean`,
        };
      }
    } else if (expectedType === "string") {
      if (typeof val !== "string") {
        return {
          valid: false,
          reason: `Parámetro "${field}" en tool "${name}" debe ser string`,
        };
      }
    } else if (expectedType === "array") {
      if (!Array.isArray(val)) {
        return {
          valid: false,
          reason: `Parámetro "${field}" en tool "${name}" debe ser un array`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Valida un array completo de tool_calls devuelto por OpenClaw en una ronda.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateToolCallBatch(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return { valid: false, errors: ["tool_calls debe ser un array"] };
  }

  if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
    return {
      valid: false,
      errors: [
        `OpenClaw solicitó ${toolCalls.length} tools en una ronda (máximo permitido: ${MAX_TOOL_CALLS_PER_ROUND})`,
      ],
    };
  }

  const errors = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const result = validateToolCall(toolCalls[i]);
    if (!result.valid) {
      errors.push(`tool_calls[${i}]: ${result.reason}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
