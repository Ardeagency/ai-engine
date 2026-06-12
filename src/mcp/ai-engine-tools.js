#!/usr/bin/env node
/**
 * ai-engine MCP Server v2 — proxy stdio → HTTP al control plane.
 *
 * Este proceso corre en CADA org-server (Hetzner). OpenClaw lo ejecuta como
 * subproceso vía stdio. NO tiene acceso directo a Supabase ni a los secretos
 * del control plane — solo al token de su org.
 *
 * Flujo:
 *   1. OpenClaw pide tools/list → este server hace GET /mcp/list-tools al control plane
 *   2. El control plane filtra por nivel de autonomía actual y devuelve la lista
 *   3. OpenClaw pide tools/call → este server hace POST /mcp/dispatch
 *   4. El control plane resuelve org del token, ejecuta dispatchTool, devuelve resultado
 *
 * Variables de entorno requeridas:
 *   AI_ENGINE_URL    — URL del control plane (e.g. http://5.161.243.1:3000)
 *   ORG_TOKEN        — token de autenticación de la org (mismo que /agent/run)
 *   CONVERSATION_ID  — opcional, para que las tools con consent puedan acceder a TASK_EVENTs
 *
 * Registro en OpenClaw:
 *   openclaw mcp set ai-engine '{"command":"node","args":["/opt/ai-engine-mcp/server.js"]}'
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Configuración ────────────────────────────────────────────────────────────

const AI_ENGINE_URL    = process.env.AI_ENGINE_URL;
const ORG_TOKEN        = process.env.ORG_TOKEN;
const CONVERSATION_ID  = process.env.CONVERSATION_ID || null; // se actualiza por turn via env

if (!AI_ENGINE_URL || !ORG_TOKEN) {
  console.error("[mcp] AI_ENGINE_URL y ORG_TOKEN son obligatorios — abortando");
  process.exit(1);
}

const LIST_CACHE_TTL_MS = 60_000;
let _listCache = null; // { expiresAt, data }

// ── Cliente HTTP ──────────────────────────────────────────────────────────────

async function callListTools() {
  const now = Date.now();
  if (_listCache && now < _listCache.expiresAt) return _listCache.data;

  const res = await fetch(`${AI_ENGINE_URL}/mcp/list-tools`, {
    method: "GET",
    headers: { "X-Org-Token": ORG_TOKEN },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`list-tools failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  _listCache = { expiresAt: now + LIST_CACHE_TTL_MS, data };
  return data;
}

async function callDispatch(toolName, params) {
  // conversation_id resolution priority:
  //   1. params._conversationId (Vera lo pasa cuando lo conoce — viene del enrichedMessage)
  //   2. process.env.CONVERSATION_ID (env del subprocess, fallback)
  // Removemos _conversationId de params antes de enviar — es metadato, no parámetro real.
  const cleanParams = { ...(params || {}) };
  const passedConvId = cleanParams._conversationId;
  delete cleanParams._conversationId;

  const body = {
    tool: toolName,
    params: cleanParams,
    conversation_id: passedConvId || process.env.CONVERSATION_ID || CONVERSATION_ID,
  };

  const res = await fetch(`${AI_ENGINE_URL}/mcp/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Org-Token":   ORG_TOKEN,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000), // permite tools largas tipo runScraperTest
  });

  const data = await res.json().catch(() => null);
  return { httpStatus: res.status, data };
}

// ── Descripciones cortas por tool — fallback si list-tools no las trae ────────
// El control plane puede agregar `description` a /mcp/list-tools en el futuro;
// por ahora usamos una tabla local liviana.

const SHORT_DESCRIPTIONS = {
  getOrgOverview: "Resumen ejecutivo de la organización: marcas, productos, audiencias, campañas, integraciones, flujos.",
  getBrandContainers: "Lista todas las marcas (brand containers) de la organización.",
  getBrandProfile: "Perfil de marca activa: tono, arquetipo, keywords, palabras prohibidas, objetivos.",
  getAudiences: "Audiencias con dolores, deseos, objeciones y gatillos.",
  getProducts: "Catálogo con precios, beneficios y diferenciadores.",
  getCampaigns: "Campañas con objetivos, ángulos de venta y CTAs.",
  getAvailableFlows: "Flujos de automatización disponibles.",
  getBrandEntities: "Entidades de marca: productos, lugares, personas.",
  getIntegrations: "Plataformas conectadas (sin tokens, solo disponibilidad).",
  getIntelligenceEntities: "Competidores y entidades monitoreadas.",
  getIntelligenceSignals: "Señales recientes de un competidor.",
  getTrendTopics: "Keywords trending detectadas.",
  getBrandPosts: "Posts de la marca o de competidores.",
  getRetailPrices: "Precios de retail comparativos.",
  getMonitoringTriggers: "Triggers de monitoreo activos.",
  getSensorRuns: "Ejecuciones recientes de sensores.",
  getBrandVulnerabilities: "Vulnerabilidades detectadas por el sistema.",
  getUrlWatchers: "URLs vigiladas para cambios.",
  getPendingAnalysisJobs: "Jobs de análisis encolados.",
  getBodyMissions: "Misiones automáticas de Vera (briefings, análisis).",
  getBriefingHoy: "Briefing del día actual de Vera (Bogotá UTC-5).",
  getPendingActions: "Cola de acciones que Vera propuso (estados pending/approved/executed/etc).",
  getPendingActionDetail: "Detalle completo de una pending_action específica.",
  getStrategyOpportunityScore: "Score compuesto de oportunidad por topic (velocity*0.4 + gap*0.35 + relevancia*0.25).",
  getActionOutcomes: "Outcomes medidos de tus acciones ejecutadas (verdict positive/neutral/negative + delta vs baseline).",
  getActionOutcomeDetail: "Todas las ventanas de medición (24h/7d/30d) de una acción ejecutada específica.",
  getOutcomeSummary: "Agregado de outcomes: success rate por action_type + calibración de tu confianza declarada vs resultados reales.",
  getScraperSessions: "Estado de sesiones autenticadas (Instagram, TikTok, Facebook).",
  getScraperDashboard: "Dashboard del sistema de scraping.",
  getScraperHealth: "Salud de cada scraper (healthy/degraded/broken).",
  getCompetitorAnalysis: "Análisis profundo de un competidor por nombre.",
  getContentAnalysisSummary: "Resumen de análisis de contenido.",
  updateMonitoringTrigger: "Ajusta un trigger de monitoreo (interno).",
  addIntelligenceEntity: "Agrega una entidad a monitorear.",
  updateIntelligenceEntity: "Actualiza una entidad monitoreada.",
  upsertUrlWatcher: "Crea o actualiza un URL watcher.",
  toggleUrlWatcher: "Activa/desactiva un URL watcher.",
  runScraperTest: "Test de scraping para diagnosticar (timeout 60s).",
  getFlowRuns: "Historial de ejecuciones de flujos.",
  getFlowSchedules: "Flujos programados activos.",
  getFlowRunOutputs: "Outputs de un run específico.",
  getSocialSummary: "Resumen cross-platform de integraciones activas.",
  getMetaPageInsights: "Métricas de página de Facebook (parámetro range).",
  getMetaPosts: "Posts recientes de Facebook con engagement.",
  getInstagramInsights: "Métricas de cuenta IG Business.",
  getInstagramPosts: "Posts de Instagram con engagement.",
  getGoogleAnalytics: "Sesiones, usuarios, fuentes desde GA4.",
  updateBrandProfile: "Actualiza perfil de marca (REQUIERE CONSENT).",
  updateBrandContainer: "Actualiza brand container (REQUIERE CONSENT).",
  upsertAudience: "Crea o actualiza audiencia (REQUIERE CONSENT).",
  deleteAudience: "Elimina audiencia (REQUIERE CONSENT).",
  upsertProduct: "Crea o actualiza producto (REQUIERE CONSENT).",
  deleteProduct: "Elimina producto (REQUIERE CONSENT).",
  upsertBrandColor: "Agrega/actualiza color de marca.",
  deleteBrandColor: "Elimina color (REQUIERE CONSENT).",
  upsertBrandFont: "Agrega/actualiza fuente.",
  upsertBrandRule: "Agrega/actualiza regla de comunicación.",
  deleteBrandRule: "Elimina regla (REQUIERE CONSENT).",
  likeFlow: "Marca un flow como favorito.",
  createFlowSchedule: "Programa un flow recurrente (REQUIERE CONSENT).",
  triggerFlowRun: "Ejecuta un flow inmediatamente (REQUIERE CONSENT).",
};

function getDescription(toolName) {
  return SHORT_DESCRIPTIONS[toolName] || `Tool: ${toolName} (proxy a ai-engine).`;
}

// ── Setup MCP server ──────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "ai-engine",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// list_tools — dinámico, consulta al control plane y filtra por nivel actual
server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const { tools = [], level = "?", tool_schemas = {} } = await callListTools();
    return {
      tools: tools.map((toolName) => ({
        name: toolName,
        description: `[nivel: ${level}] ${getDescription(toolName)}`,
        inputSchema: tool_schemas[toolName] || {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      })),
    };
  } catch (e) {
    console.error(`[mcp] list-tools error: ${e.message}`);
    return { tools: [] };
  }
});

// call_tool — proxy a /mcp/dispatch
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  const args = request.params?.arguments || {};

  if (!toolName) {
    return {
      isError: true,
      content: [{ type: "text", text: "Error: tool name required" }],
    };
  }

  try {
    const { httpStatus, data } = await callDispatch(toolName, args);

    if (data?.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }],
      };
    }

    // Errores estructurados — Vera reacciona según el tipo
    let errorText = data?.error || `HTTP ${httpStatus}`;
    if (data?.requiresConsent) {
      errorText = `[CONSENT_REQUIRED] Esta acción requiere aprobación humana. ` +
                  `Pide al usuario: APPROVE_ACTION:${data.consentKey}. ` +
                  `Mensaje original: ${data.error}`;
    } else if (data?.phaseBlocked) {
      errorText = `[PHASE_BLOCKED] Esta tool no está habilitada en el nivel de autonomía actual. ` +
                  `Mensaje: ${data.error}`;
    } else if (data?.policyDenied) {
      errorText = `[POLICY_DENIED] ${data.error}`;
    }

    return {
      isError: true,
      content: [{ type: "text", text: errorText }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP transport error: ${e.message}` }],
    };
  }
});

// ── Arranque ──────────────────────────────────────────────────────────────────

async function main() {
  // Health check al startup — falla rápido si el control plane no responde
  try {
    const res = await fetch(`${AI_ENGINE_URL}/mcp/health`, {
      method: "GET",
      headers: { "X-Org-Token": ORG_TOKEN },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(`[mcp] control plane health check falló: ${res.status}`);
      process.exit(2);
    }
    const body = await res.json();
    console.error(`[mcp] iniciado — org=${body.organization_id} aiEngine=${AI_ENGINE_URL}`);
  } catch (e) {
    console.error(`[mcp] no se pudo conectar a ${AI_ENGINE_URL}: ${e.message}`);
    process.exit(2);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(`[mcp] fatal: ${e.message}`);
  process.exit(1);
});
