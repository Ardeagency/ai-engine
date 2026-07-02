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
const FREETEXT_PARAMS = { createArtifact: ["content", "html"], webSearch: ["query"] };
const STRICT_PATTERNS = ["<script", "__proto__", "javascript:", "onerror="];

const MAX_TOOL_CALLS_PER_ROUND = 5;

// Esquema de validación por tool: campo → tipo esperado
// "uuid" = string UUID | "object" = plain object | "boolean" = bool | "string" = string
export const TOOL_SCHEMAS = {
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
  getAvailableFlows:       {},
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
  for (const [field, expectedType] of Object.entries(schema)) {
    const val = p[field];
    if (val === undefined || val === null || val === "") continue; // optional fields skip

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
