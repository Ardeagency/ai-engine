/**
 * Tool Dispatcher — punto único de ejecución de herramientas para OpenClaw.
 *
 * Capas de seguridad (en orden estricto):
 *   1. Phase check    — la tool debe estar habilitada en la fase actual de la org
 *   2. Allowlist      — solo tools registradas pueden ejecutarse
 *   3. Validación     — schema de parámetros + injection check
 *   4. Policy         — plan, rol y créditos
 *   5. Consent gate   — tools de escritura requieren APPROVE_ACTION:<key>
 *   6. Timeout duro   — cada tool tiene un timeout máximo
 *   7. Org-scope      — organizationId/userId inyectados siempre
 *
 * OpenClaw NUNCA llama directamente a la DB — todo pasa por aquí.
 */
import * as brandTools from "../tools/brand.tools.js";
import * as brandWriteTools from "../tools/brand-write.tools.js";
import * as intelligenceTools from "../tools/intelligence.tools.js";
import * as campaignTools from "../tools/campaign.tools.js";
import * as flowTools from "../tools/flow.tools.js";
import * as actionTools from "../tools/action.tools.js";
import * as socialTools from "../tools/social.tools.js";
import * as scraperTools from "../tools/scraper.tools.js";
import * as dashboardTools from "../tools/dashboard.tools.js";
import * as strategyTools from "../tools/strategy.tools.js";
import { validateToolCall } from "../lib/tool-call.validator.js";
import { checkPolicy, getActionCreditCost } from "../lib/policy.engine.js";
import { audit } from "../lib/audit-logger.js";
import { emitToolActivity } from "../lib/activity-emitter.js";

const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS) || 8_000;

// ── Timeout wrapper ───────────────────────────────────────────────────────────

function withTimeout(promise, ms, toolName) {
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error(`Tool "${toolName}" timeout (${ms}ms)`), { isTimeout: true })),
      ms
    )
  );
  return Promise.race([promise, timeout]);
}

// ── Registro de herramientas ──────────────────────────────────────────────────

const TOOL_REGISTRY = {
  // ── Brand read ────────────────────────────────────────────────────────────
  // brandContainerId se pasa como null — brand-resolver.js lo auto-descubre por org.
  // OpenClaw NUNCA necesita conocer ni pasar un brandContainerId.
  getOrgOverview: {
    fn: ({ organizationId }) => brandTools.getOrgOverview(organizationId),
    requiresConsent: false,
  },
  getBrandContainers: {
    fn: ({ organizationId }) => brandTools.getBrandContainers(organizationId),
    requiresConsent: false,
  },
  getBrandProfile: {
    fn: ({ organizationId }) => brandTools.getBrandProfile(null, organizationId),
    requiresConsent: false,
  },
  getAudiences: {
    fn: ({ organizationId }) => brandTools.getAudiences(null, organizationId),
    requiresConsent: false,
  },
  getBrandEntities: {
    fn: ({ organizationId }) => brandTools.getBrandEntities(null, organizationId),
    requiresConsent: false,
  },
  getProducts: {
    fn: ({ organizationId }) => brandTools.getProducts(null, organizationId),
    requiresConsent: false,
  },
  getIntegrations: {
    fn: ({ organizationId }) => brandTools.getIntegrations(null, organizationId),
    requiresConsent: false,
  },

  // ── Intelligence read ─────────────────────────────────────────────────────
  getIntelligenceEntities: {
    fn: ({ organizationId }) =>
      intelligenceTools.getIntelligenceEntities(null, organizationId),
    requiresConsent: false,
  },
  getIntelligenceSignals: {
    fn: ({ entityId, organizationId }) =>
      intelligenceTools.getIntelligenceSignals(entityId, null, organizationId),
    requiresConsent: false,
  },
  getBrandPosts: {
    fn: ({ organizationId, isCompetitor }) =>
      intelligenceTools.getBrandPosts(null, organizationId, isCompetitor),
    requiresConsent: false,
  },
  getTrendTopics: {
    fn: ({ organizationId }) =>
      intelligenceTools.getTrendTopics(null, organizationId),
    requiresConsent: false,
  },
  getRetailPrices: {
    fn: ({ organizationId }) =>
      intelligenceTools.getRetailPrices(null, organizationId),
    requiresConsent: false,
  },

  // ── Campaign read ─────────────────────────────────────────────────────────
  getCampaigns: {
    fn: ({ organizationId }) =>
      campaignTools.getCampaigns(null, organizationId),
    requiresConsent: false,
  },
  getCampaignDetail: {
    fn: ({ campaignId, organizationId }) =>
      campaignTools.getCampaignDetail(campaignId, null, organizationId),
    requiresConsent: false,
  },

  // ── Flow read ─────────────────────────────────────────────────────────────
  getAvailableFlows: {
    fn: ({ filters }) => flowTools.getAvailableFlows(filters || {}),
    requiresConsent: false,
  },
  getFlowSchedules: {
    fn: ({ organizationId }) =>
      flowTools.getFlowSchedules(null, organizationId),
    requiresConsent: false,
  },
  getFlowRuns: {
    fn: ({ organizationId }) =>
      flowTools.getFlowRuns(null, organizationId),
    requiresConsent: false,
  },
  getFlowRunOutputs: {
    fn: ({ runId, organizationId }) =>
      flowTools.getFlowRunOutputs(runId, null, organizationId),
    requiresConsent: false,
  },

  // ── Social Analytics (APIs externas) ─────────────────────────────────────
  // brandContainerId se ignora intencionalmente — el sistema lo auto-descubre
  // por organizationId. OpenClaw no conoce los UUIDs internos y no debe pasarlos.
  getSocialSummary: {
    fn: ({ organizationId }) =>
      socialTools.getSocialSummary({ brandContainerId: null, organizationId }),
    requiresConsent: false,
  },
  getMetaPageInsights: {
    fn: ({ organizationId, range }) =>
      socialTools.getMetaPageInsights({ brandContainerId: null, organizationId, range }),
    requiresConsent: false,
  },
  getMetaPosts: {
    fn: ({ organizationId, limit }) =>
      socialTools.getMetaPosts({ brandContainerId: null, organizationId, limit }),
    requiresConsent: false,
  },
  getInstagramInsights: {
    fn: ({ organizationId, range }) =>
      socialTools.getInstagramInsights({ brandContainerId: null, organizationId, range }),
    requiresConsent: false,
  },
  getInstagramPosts: {
    fn: ({ organizationId, limit }) =>
      socialTools.getInstagramPosts({ brandContainerId: null, organizationId, limit }),
    requiresConsent: false,
  },
  getGoogleAnalytics: {
    fn: ({ organizationId, range, propertyId }) =>
      socialTools.getGoogleAnalytics({ brandContainerId: null, organizationId, range, propertyId }),
    requiresConsent: false,
  },
  getAudienceAlignment: {
    fn: ({ organizationId, brandContainerId }) =>
      socialTools.getAudienceAlignment({ brandContainerId: brandContainerId || null, organizationId }),
    requiresConsent: false,
  },
  getBrandContent: {
    fn: ({ organizationId, brandContainerId, daysWindow }) =>
      socialTools.getBrandContent({ brandContainerId: brandContainerId || null, organizationId, daysWindow: daysWindow || 90 }),
    requiresConsent: false,
  },

  // ── Brand write ───────────────────────────────────────────────────────────
  // Disponible en fase B (parcial) y C (total).
  // requiresConsent: true en operaciones que modifican identidad de marca.
  updateBrandProfile: {
    fn: (params) => brandWriteTools.updateBrandProfile(params),
    requiresConsent: true,
    consentKey: "UPDATE_BRAND_PROFILE",
  },
  updateBrandContainer: {
    fn: (params) => brandWriteTools.updateBrandContainer(params),
    requiresConsent: true,
    consentKey: "UPDATE_BRAND_CONTAINER",
  },
  upsertAudience: {
    fn: (params) => brandWriteTools.upsertAudience(params),
    requiresConsent: true,
    consentKey: "UPSERT_AUDIENCE",
  },
  deleteAudience: {
    fn: (params) => brandWriteTools.deleteAudience(params),
    requiresConsent: true,
    consentKey: "DELETE_AUDIENCE",
  },
  upsertProduct: {
    fn: (params) => brandWriteTools.upsertProduct(params),
    requiresConsent: true,
    consentKey: "UPSERT_PRODUCT",
  },
  deleteProduct: {
    fn: (params) => brandWriteTools.deleteProduct(params),
    requiresConsent: true,
    consentKey: "DELETE_PRODUCT",
  },
  upsertBrandColor: {
    fn: (params) => brandWriteTools.upsertBrandColor(params),
    requiresConsent: false,
  },
  deleteBrandColor: {
    fn: (params) => brandWriteTools.deleteBrandColor(params),
    requiresConsent: true,
    consentKey: "DELETE_BRAND_COLOR",
  },
  upsertBrandFont: {
    fn: (params) => brandWriteTools.upsertBrandFont(params),
    requiresConsent: false,
  },
  upsertBrandRule: {
    fn: (params) => brandWriteTools.upsertBrandRule(params),
    requiresConsent: false,
  },
  deleteBrandRule: {
    fn: (params) => brandWriteTools.deleteBrandRule(params),
    requiresConsent: true,
    consentKey: "DELETE_BRAND_RULE",
  },

  // ── Scraper tools — sistema de monitoreo de Vera ─────────────────────────
  // READ (Phase B) — Vera inspecciona su sistema de monitoreo sin gastar tokens en acción
  getScraperSessions: {
    fn: ({ organizationId }) =>
      scraperTools.getScraperSessions(),
    requiresConsent: false,
  },
  getScraperDashboard: {
    fn: ({ organizationId }) =>
      scraperTools.getScraperDashboard(null, organizationId),
    requiresConsent: false,
  },
  getScraperHealth: {
    fn: ({ organizationId }) =>
      scraperTools.getScraperHealth(null, organizationId),
    requiresConsent: false,
  },
  getCompetitorAnalysis: {
    fn: ({ entityName, organizationId }) =>
      scraperTools.getCompetitorAnalysis(entityName, null, organizationId),
    requiresConsent: false,
  },
  getContentAnalysisSummary: {
    fn: ({ organizationId }) =>
      scraperTools.getContentAnalysisSummary(null, organizationId),
    requiresConsent: false,
  },
  // WRITE (Phase B) — Vera ajusta su monitoreo (sin consent: son herramientas internas, no afectan datos de cliente)
  updateMonitoringTrigger: {
    fn: (params) =>
      scraperTools.updateMonitoringTrigger(params, null, params.organizationId),
    requiresConsent: false, // Vera ajusta su propio sistema — no requiere aprobación del usuario
  },
  addIntelligenceEntity: {
    fn: (params) =>
      scraperTools.addIntelligenceEntity(params, null, params.organizationId),
    requiresConsent: false,
  },
  updateIntelligenceEntity: {
    fn: (params) =>
      scraperTools.updateIntelligenceEntity(params, null, params.organizationId),
    requiresConsent: false,
  },
  upsertUrlWatcher: {
    fn: (params) =>
      scraperTools.upsertUrlWatcher(params, null, params.organizationId),
    requiresConsent: false,
  },
  toggleUrlWatcher: {
    fn: (params) =>
      scraperTools.toggleUrlWatcher(params, null, params.organizationId),
    requiresConsent: false,
  },
  // TEST — Vera valida que sus cambios no rompieron nada (timeout extendido: 60s)
  runScraperTest: {
    fn: (params) =>
      scraperTools.runScraperTest(params, null, params.organizationId),
    requiresConsent: false,
    timeout: 60_000, // scraping real puede tardar hasta 60s
  },

  // ── Strategy / self-awareness (Phase B+) ──────────────────────────────────
  // Vera lee su backlog de misiones y la cola de pending_actions que ella misma propuso.
  // Solo lectura — aprobar/rechazar es responsabilidad del usuario via /internal/vera-actions/*.
  getBodyMissions: {
    fn: ({ organizationId, status, limit }) =>
      strategyTools.getBodyMissions({ organizationId, status, limit }),
    requiresConsent: false,
  },
  getBriefingHoy: {
    fn: ({ organizationId }) =>
      strategyTools.getBriefingHoy({ organizationId }),
    requiresConsent: false,
  },
  getPendingActions: {
    fn: ({ organizationId, status, limit }) =>
      strategyTools.getPendingActions({ organizationId, status, limit }),
    requiresConsent: false,
  },
  getPendingActionDetail: {
    fn: ({ organizationId, action_id }) =>
      strategyTools.getPendingActionDetail({ organizationId, action_id }),
    requiresConsent: false,
  },
  getStrategyOpportunityScore: {
    fn: ({ organizationId, limit }) =>
      strategyTools.getStrategyOpportunityScore({ organizationId, limit }),
    requiresConsent: false,
    timeout: 15_000, // hace varias queries en paralelo, dejar margen
  },

  // ── Actions (write) ───────────────────────────────────────────────────────
  likeFlow: {
    fn: ({ flowId, userId }) => actionTools.likeFlow(flowId, userId),
    requiresConsent: false,
    policyAction: null,
  },
  createFlowSchedule: {
    fn: ({ params, brandContainerId, organizationId, userId }) =>
      actionTools.createFlowSchedule(params, brandContainerId, organizationId, userId),
    requiresConsent: true,
    consentKey: "SCHEDULE_FLOW",
    policyAction: "createFlowSchedule",
  },
  triggerFlowRun: {
    fn: ({ params, brandContainerId, organizationId, userId }) =>
      actionTools.triggerFlowRun(params, brandContainerId, organizationId, userId),
    requiresConsent: true,
    consentKey: "TRIGGER_FLOW_RUN",
    policyAction: "triggerFlowRun",
  },

  // ── Dashboard tools (read-only, sin consent) ──────────────────────────────
  // Wrappers de las RPCs de Mi Marca / Competencia / Estrategia.
  // Vera invoca estas para responder "cómo voy", "quién me amenaza", etc.

  // Mi Marca
  getBrandKpisStrip:        { fn: ({ params, organizationId }) => dashboardTools.getBrandKpisStrip({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandActivityHistory:  { fn: ({ params, organizationId }) => dashboardTools.getBrandActivityHistory({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandEngagementTrend:  { fn: ({ params, organizationId }) => dashboardTools.getBrandEngagementTrend({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandSentimentActivity:{ fn: ({ params, organizationId }) => dashboardTools.getBrandSentimentActivity({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandPostingHours:     { fn: ({ params, organizationId }) => dashboardTools.getBrandPostingHours({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedProfile:       { fn: ({ params, organizationId }) => dashboardTools.getFeaturedProfile({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedProfileDetails:{ fn: ({ params, organizationId }) => dashboardTools.getFeaturedProfileDetails({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedTopic:         { fn: ({ params, organizationId }) => dashboardTools.getFeaturedTopic({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedHashtag:       { fn: ({ params, organizationId }) => dashboardTools.getFeaturedHashtag({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedHour:          { fn: ({ params, organizationId }) => dashboardTools.getFeaturedHour({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedPlatform:      { fn: ({ params, organizationId }) => dashboardTools.getFeaturedPlatform({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedGrowth:        { fn: ({ params, organizationId }) => dashboardTools.getFeaturedGrowth({ ...(params || {}), organizationId }), requiresConsent: false },
  getAlertScore:            { fn: ({ params, organizationId }) => dashboardTools.getAlertScore({ ...(params || {}), organizationId }), requiresConsent: false },
  getTopHighlightedPosts:   { fn: ({ params, organizationId }) => dashboardTools.getTopHighlightedPosts({ ...(params || {}), organizationId }), requiresConsent: false },

  // Competencia
  getCompetenciaKpis:       { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaKpis({ ...(params || {}), organizationId }), requiresConsent: false },
  getCompetenciaTop:        { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaTop({ ...(params || {}), organizationId }), requiresConsent: false },
  getCompetenciaFeatured:   { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaFeatured({ ...(params || {}), organizationId }), requiresConsent: false },
  getCompetenciaTopPosts:   { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaTopPosts({ ...(params || {}), organizationId }), requiresConsent: false },
  getCompetenciaActorDetails:{ fn: ({ params, organizationId }) => dashboardTools.getCompetenciaActorDetails({ ...(params || {}), organizationId }), requiresConsent: false },
  getCompetenciaRisk:       { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaRisk({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandVsCompetencia:    { fn: ({ params, organizationId }) => dashboardTools.getBrandVsCompetencia({ ...(params || {}), organizationId }), requiresConsent: false },
  searchCompetidor:         { fn: ({ params, organizationId }) => dashboardTools.searchCompetidor({ ...(params || {}), organizationId }), requiresConsent: false },

  // Estrategia
  getEstrategiaTopics:           { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaTopics({ ...(params || {}), organizationId }), requiresConsent: false },
  getEstrategiaHashtags:         { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaHashtags({ ...(params || {}), organizationId }), requiresConsent: false },
  getEstrategiaTones:            { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaTones({ ...(params || {}), organizationId }), requiresConsent: false },
  getEstrategiaPlatforms:        { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaPlatforms({ ...(params || {}), organizationId }), requiresConsent: false },
  getEstrategiaSentimentsByBrand:{ fn: ({ params, organizationId }) => dashboardTools.getEstrategiaSentimentsByBrand({ ...(params || {}), organizationId }), requiresConsent: false },
};

export const AVAILABLE_TOOL_NAMES = Object.keys(TOOL_REGISTRY);

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Despacha una herramienta con todas las capas de seguridad.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {object} secCtx
 * @param {string}                         secCtx.organizationId
 * @param {string}                         secCtx.userId
 * @param {Set<string>}                    secCtx.approvedIntents
 * @param {string[]}                       secCtx.allowedTools   — tools habilitadas según autonomy.phase
 * @param {CostController}                 [secCtx.costController]
 * @param {"block_all"|"require"|"auto"}   [secCtx.consentMode]  — derivado de level_of_autonomy
 * @param {string}                         [secCtx.orgName]      — nombre de la org para mensajes
 */
export async function dispatchTool(toolName, params, secCtx) {
  const {
    organizationId, userId, approvedIntents, allowedTools = [],
    costController, consentMode = "require", orgName = "la organización",
  } = secCtx;
  const auditCtx = { organizationId, userId, conversationId: secCtx.conversationId };

  audit.toolRequested(auditCtx, toolName, params);

  // ── Capa 1: Phase check — valida contra autonomy.phase (fuente: DB) ────
  // allowedTools viene de TOOLS_BY_PHASE[autonomy.phase] en ai.service.js,
  // garantizando que la fase refleja level_of_autonomy de la org, no env vars.
  if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    audit.phaseBlocked(auditCtx, toolName, "current", "higher");
    throw Object.assign(
      new Error(
        `Tool "${toolName}" no está habilitada en el nivel de autonomía actual de ${orgName}. ` +
        `Consulta al usuario si desea cambiar el nivel de autonomía.`
      ),
      { statusCode: 403, phaseBlocked: true }
    );
  }

  // ── Capa 2: Allowlist ───────────────────────────────────────────────────
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    audit.toolDenied(auditCtx, toolName, "not in registry", 400);
    throw Object.assign(
      new Error(`Tool "${toolName}" no está en la lista de herramientas permitidas`),
      { statusCode: 400 }
    );
  }

  // ── Capa 3: Validación de parámetros ────────────────────────────────────
  const validation = validateToolCall({ name: toolName, params });
  if (!validation.valid) {
    audit.toolDenied(auditCtx, toolName, `schema: ${validation.reason}`, 400);
    throw Object.assign(
      new Error(`Parámetros inválidos para "${toolName}": ${validation.reason}`),
      { statusCode: 400 }
    );
  }

  // ── Capa 4: Policy ──────────────────────────────────────────────────────
  if (tool.policyAction) {
    const policy = await checkPolicy(tool.policyAction, organizationId, userId);
    if (!policy.allowed) {
      audit.policyDenied(auditCtx, tool.policyAction, policy.reason);
      throw Object.assign(new Error(policy.reason), { statusCode: 403, policyDenied: true });
    }
  }

  // ── Capa 5: Consent gate — respeta el nivel de autonomía de la org ──────
  if (tool.requiresConsent) {
    if (consentMode === "block_all") {
      // restringido: ninguna acción de escritura puede ejecutarse
      audit.consentGate(auditCtx, `BLOCKED_${tool.consentKey}`);
      throw Object.assign(
        new Error(
          `[AUTONOMY_BLOCK] ${orgName} no te ha dado accesos totales para ejecutar "${toolName}" de forma autónoma. ` +
          `Indícale al usuario que para darte autonomía completa debe ir a ` +
          `Configuración → Organización → Nivel de autonomía y cambiarlo a "total". ` +
          `Mientras tanto, ofrécele el contenido listo para que lo publique manualmente.`
        ),
        { statusCode: 403, requiresConsent: false, policyDenied: true }
      );
    }

    if (consentMode === "auto") {
      // total: auto-aprueba — solo deducir créditos y continuar
      if (costController) {
        const creditCost = getActionCreditCost(tool.policyAction || toolName);
        await costController.deductCredits(creditCost);
      }
    } else {
      // require (parcial): comportamiento estándar — necesita APPROVE_ACTION
      const hasConsent = approvedIntents instanceof Set
        ? approvedIntents.has(tool.consentKey)
        : false;

      if (!hasConsent) {
        audit.consentGate(auditCtx, tool.consentKey);
        throw Object.assign(
          new Error(
            `La acción "${toolName}" requiere confirmación humana. ` +
            `Aprueba: APPROVE_ACTION:${tool.consentKey}`
          ),
          { statusCode: 403, requiresConsent: true, consentKey: tool.consentKey }
        );
      }

      if (costController) {
        const creditCost = getActionCreditCost(tool.policyAction || toolName);
        await costController.deductCredits(creditCost);
      }
    }
  }

  // ── Capa 6: Timeout duro + ejecución ────────────────────────────────────
  // emitToolActivity se llama AQUÍ — solo cuando la herramienta REALMENTE ejecuta,
  // no cuando OpenClaw "promete" que lo hará. Esto le da al usuario evidencia
  // verificable de las acciones tomadas vs las declaradas por el agente.
  if (secCtx.conversationId) {
    emitToolActivity(secCtx.conversationId, toolName).catch(() => {});
  }

  const safeParams = { ...params, organizationId, userId };
  const t0 = Date.now();

  // Algunas tools (ej: runScraperTest) declaran timeout propio más largo
  const effectiveTimeout = tool.timeout || TOOL_TIMEOUT_MS;

  try {
    const result = await withTimeout(tool.fn(safeParams), effectiveTimeout, toolName);
    audit.toolExecuted(auditCtx, toolName, Date.now() - t0);
    return result;
  } catch (e) {
    if (e.isTimeout) {
      audit.toolTimeout(auditCtx, toolName, TOOL_TIMEOUT_MS);
    } else {
      audit.toolDenied(auditCtx, toolName, e.message, e.statusCode || 500);
    }
    throw e;
  }
}
