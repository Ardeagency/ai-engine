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
import * as mediaAnalysis from "./media-analysis.service.js";
import * as scraperTools from "../tools/scraper.tools.js";
import * as dashboardTools from "../tools/dashboard.tools.js";
import * as dashboardWriteTools from "../tools/dashboard-write.tools.js";
import * as vera4WriteTools from "../tools/vera4-write.tools.js";
import * as destacadaTools from "../tools/destacada.tools.js";
import * as materialesTools from "../tools/materiales.tools.js";
import * as medicionTools from "../tools/medicion.tools.js";
import * as strategyTools from "../tools/strategy.tools.js";
import * as cmoTools from "../tools/cmo.tools.js";
import * as veraFeedTools from "../tools/vera-feed.tools.js";
import * as veraActionsTools from "../tools/vera-actions.tools.js";
import * as promptForgeTools from "../tools/prompt-forge.tools.js";
import * as directGen from "./direct-generator.service.js";
import * as decisionTools from "../tools/decision.tools.js";
import * as canvasTools from "../tools/canvas.tools.js";
import * as integrationDataTools from "../tools/integration-data.tools.js";
import * as webTools from "../tools/web.tools.js";
import * as missionTools from "../tools/missions.tools.js";
import * as artifactTools from "../tools/artifact.tools.js";
import { renderToolGroup } from "../lib/tool-catalog.js";
import { validateToolCall } from "../lib/tool-call.validator.js";
import { captureSynthError } from "../lib/synth-error-capture.js";
import { checkPolicy, getActionCreditCost } from "../lib/policy.engine.js";
import { audit } from "../lib/audit-logger.js";
import { emitToolActivity } from "../lib/activity-emitter.js";
import * as commentHarvest from "./comment-harvest.service.js";

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
  // Progressive tool disclosure: Vera descubre las tools de una categoria on-demand.
  listToolsFor: {
    fn: (sp) => {
      const p = sp || {};
      const group = (p.params && (p.params.group || p.params.category)) || p.group || p.category || "";
      return { text: renderToolGroup(String(group), p.allowedTools || []) };
    },
    requiresConsent: false,
  },
  getCatalogDiagnosis: { fn: ({ organizationId }) => integrationDataTools.getCatalogDiagnosis(null, organizationId), requiresConsent: false },
  getLiveProducts:    { fn: ({ organizationId, ...p }) => integrationDataTools.getLiveProducts(null, organizationId, p), requiresConsent: false },
  getLivePosts:       { fn: ({ organizationId, ...p }) => integrationDataTools.getLivePosts(null, organizationId, p), requiresConsent: false },
  getLiveAdsMetrics:  { fn: ({ organizationId, ...p }) => integrationDataTools.getLiveAdsMetrics(null, organizationId, p), requiresConsent: false },
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
  getSesionesVivas: {
    fn: () => import("./vera-dashboard-session.service.js").then((m) => m.getSesionesVivas()),
    requiresConsent: false,
  },
  getDataHorizon: {
    fn: ({ organizationId }) => brandTools.getDataHorizon(null, organizationId),
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
  getPaidIntelligence: {
    fn: ({ brandContainerId, organizationId }) => dashboardTools.getPaidIntelligence({ brandContainerId, organizationId }),
    requiresConsent: false,
  },
  getContentIntelligence: {
    fn: ({ brandContainerId, organizationId, source, limit }) => dashboardTools.getContentIntelligence({ brandContainerId, organizationId, source, limit }),
    requiresConsent: false,
  },
  getUpcomingDates: {
    fn: ({ organizationId, lookaheadDays, limit }) => dashboardTools.getUpcomingDates({ organizationId, lookaheadDays, limit }),
    requiresConsent: false,
  },
  getAdsBreakdown: {
    fn: ({ brandContainerId, organizationId, groupBy, days, limit }) =>
      campaignTools.getAdsBreakdown({ brandContainerId, organizationId, groupBy, days, limit }),
    requiresConsent: false,
  },
  getCampaignDetail: {
    fn: ({ campaignId, organizationId }) =>
      campaignTools.getCampaignDetail(campaignId, null, organizationId),
    requiresConsent: false,
  },

  // ── Flow write ────────────────────────────────────────────────────────────
  runContentFlow: {
    fn: ({ flowSlug, inputs, organizationId, brandContainerId }) =>
      flowTools.runContentFlow({ flowSlug, inputs, organizationId, brandContainerId }),
    requiresConsent: true,
  },

  // ── Flow read ─────────────────────────────────────────────────────────────
  getAvailableFlows: {
    fn: ({ filters, organizationId }) => flowTools.getAvailableFlows(filters || {}, organizationId),
    requiresConsent: false,
  },
  getFlowInputs: {
    fn: ({ flowId, params, organizationId, brandContainerId }) =>
      flowTools.getFlowInputs(flowId || params?.flowId, brandContainerId, organizationId),
    requiresConsent: false,
  },
  forgeProductionPrompt: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      promptForgeTools.forgeProductionPrompt({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  generateImageDirect: {
    // ...rest recoge las claves PLANAS: dispatchTool no manda un sobre `params`.
    // Sin esto el intent nunca llegaba y toda generacion moria en
    // "Falta la descripcion de que generar".
    fn: ({ params, brandContainerId, organizationId, conversationId, ...rest }) =>
      directGen.generateImageDirect({ ...(params || {}), ...rest }, brandContainerId, organizationId, conversationId),
    requiresConsent: false,
    timeout: 30_000,
  },
  generateVideoDirect: {
    // ...rest recoge las claves PLANAS: dispatchTool no manda un sobre `params`.
    // Sin esto el intent nunca llegaba y toda generacion moria en
    // "Falta la descripcion de que generar".
    fn: ({ params, brandContainerId, organizationId, conversationId, ...rest }) =>
      directGen.generateVideoDirect({ ...(params || {}), ...rest }, brandContainerId, organizationId, conversationId),
    requiresConsent: false,
    timeout: 30_000,
  },
  getRunsAwaitingApproval: {
    fn: ({ brandContainerId, organizationId }) =>
      flowTools.getRunsAwaitingApproval(brandContainerId, organizationId),
    requiresConsent: false,
  },
  approveRunStage: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      flowTools.approveRunStage({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: true,
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
  // Existía en social.tools.js desde hacía meses pero no estaba registrada en
  // ningún lado: 0 apariciones en dispatcher, catálogo, fases y MCP. Es la
  // fuente en vivo de la card "audiencia" (mapa + pirámide).
  // "Voy a verlo": describe la media de un post AHORA y devuelve lo que se ve.
  // Sin esto solo se puede juzgar por el copy — la mitad de la pieza.
  // Ya NO describe por ella: le entrega la media y Vera mira. Probado que ve
  // una imagen desde su URL en 28s. `force` desaparecio — no hay nada que
  // recalcular, solo se pasan los enlaces.
  // Lo que VIO queda pegado a la pieza y alimenta `que_se_ve` de getBrandPosts:
  // una publicacion mirada una vez queda mirada para todas las lecturas.
  describirPublicacion: {
    fn: (params) => mediaAnalysis.describirPublicacion(params),
    requiresConsent: false,
  },
  verPublicacion: {
    fn: ({ postId, post_id }) => mediaAnalysis.verPublicacion(postId || post_id),
    requiresConsent: false,
    // Describir una imagen con un modelo de vision no cabe en los 8s por defecto:
    // sin este timeout propio la tool moriria siempre en el primer analisis y solo
    // funcionaria cuando la descripcion ya estuviera cacheada.
    timeout: Number(process.env.VER_PUBLICACION_TIMEOUT_MS || 120_000),
  },
  getMetaAudienceDemographics: {
    fn: ({ organizationId }) =>
      socialTools.getMetaAudienceDemographics({ brandContainerId: null, organizationId }),
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

  // ── Medicion: ella mide, aqui se anota ───────────────────────────────────
  // Lo que queda de audit-distinctive-assets, con la topologia al derecho. El
  // blink test lo hace ella (getMaterialDeCodigos + su doctrina); ai-engine
  // guarda la serie, que es lo unico que dice si la marca MEJORA y no solo como
  // esta hoy.
  registrarMedicionDeCodigos: {
    fn: (params) => medicionTools.registrarMedicionDeCodigos(params),
    requiresConsent: false,
  },
  getSerieDeCodigos: {
    fn: (params) => medicionTools.getSerieDeCodigos(params),
    requiresConsent: false,
  },

  // ── Material para que ella juzgue ────────────────────────────────────────
  // Reemplazan a getDistinctiveAssetsAudit y getPackagingAnalysis, que llamaban
  // a gpt-4o con VISION desde ai-engine y devolvian el veredicto ya masticado.
  // Vera tiene la doctrina en skills; lo que le faltaba era el material.
  getMaterialDeCodigos: {
    fn: (params) => materialesTools.getMaterialDeCodigos(params),
    requiresConsent: false,
  },
  getMaterialDeEmpaque: {
    fn: (params) => materialesTools.getMaterialDeEmpaque(params),
    requiresConsent: false,
  },

  // ── Publicacion destacada ──────────────────────────────────
  // getTopHighlightedPosts no sirve para juzgar una pieza: content_preview sale
  // VACIO, no trae comentarios ni descripcion visual, y rankea por
  // engagement_total mientras el tablero re-rankea desde metrics — podia
  // analizar un post DISTINTO al que el cliente tiene en pantalla.
  getPublicacionDestacada: {
    fn: (params) => destacadaTools.getPublicacionDestacada(params),
    requiresConsent: false,
  },
  explainPublicacionDestacada: {
    fn: (params) => destacadaTools.explainPublicacionDestacada(params),
    requiresConsent: false,
  },

  // ── Dashboard write ───────────────────────────────────────────────────────
  // Las UNICAS tools que escriben el tablero. Existen para que sea VERA quien
  // publique: antes ai-engine era el unico escritor y por eso tenia que sostener
  // 30 rondas de conversacion por HTTP. Sin consentimiento: son datos que ella
  // misma produjo, no una modificacion de la identidad de la marca.
  publishMiMarcaCard: {
    fn: (params) => dashboardWriteTools.publishMiMarcaCard(params),
    requiresConsent: false,
  },
  getMiMarcaProgress: {
    fn: (params) => dashboardWriteTools.getMiMarcaProgress(params),
    requiresConsent: false,
  },
  // Editar una card de lista por item, en vez de rehacerla: quitar la
  // observacion que ya no aplica y sumar la nueva sin tocar las que siguen
  // siendo ciertas. Sin consentimiento, como sus hermanas: es contenido que
  // ella misma produjo, no la identidad de la marca.
  updateMiMarcaCardItems: {
    fn: (params) => dashboardWriteTools.updateMiMarcaCardItems(params),
    requiresConsent: false,
  },
  // Los otros tres tabs (Competencia, Tendencias, Estrategia). Hasta hoy solo los
  // escribia runDashboardSession, que lanzaba el scheduler apagado en .env: tres
  // cuartas partes del tablero fuera del alcance de Vera. Sin consentimiento,
  // como sus hermanas: es su lectura, no la identidad de la marca.
  publishDashboardReading: {
    fn: (params) => dashboardWriteTools.publishDashboardReading(params),
    requiresConsent: false,
  },

  // ── Cards del cerebro (cards.vera4) ───────────────────────────────────────
  // Las 30 tarjetas del Ciclo de Relevancia repartidas en los 4 tabs. Conviven
  // con la lectura de siempre de cada tab: el schema forma parte de la identidad
  // de una lectura desde 2026-07-30 (indice unico + get_vera_reading).
  // Sin consentimiento, como sus hermanas: es su lectura, no la identidad de la marca.
  getVera4Encargo: {
    fn: (params) => vera4WriteTools.getVera4Encargo(params),
    requiresConsent: false,
  },
  publishVera4Card: {
    fn: (params) => vera4WriteTools.publishVera4Card(params),
    requiresConsent: false,
  },
  getVera4Progress: {
    fn: (params) => vera4WriteTools.getVera4Progress(params),
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
  // Misiones = pasos de una estrategia. VERA los registra, avanza y RETOMA entre sesiones.
  logMission: {
    fn: ({ organizationId, brandContainerId, strategyId, seq, missionType, description, pendingActionId }) =>
      missionTools.logMission({ organizationId, brandContainerId, strategyId, seq, missionType, description, pendingActionId }),
    requiresConsent: false,
  },
  completeMission: {
    fn: ({ missionId, status, summary, resultReference, pendingActionId }) =>
      missionTools.completeMission({ missionId, status, summary, resultReference, pendingActionId }),
    requiresConsent: false,
  },
  getOpenMissions: {
    fn: ({ organizationId, strategyId, limit }) =>
      missionTools.getOpenMissions({ organizationId, strategyId, limit }),
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

  // ── Outcomes — loop de retroalimentación (Phase B+, solo lectura) ─────────
  // Vera lee cómo le fue a sus acciones ejecutadas (medidas por
  // outcome-measurement.service.js) para calibrar confianza y replicar patrones.
  getActionOutcomes: {
    fn: ({ organizationId, verdict, since, limit }) =>
      strategyTools.getActionOutcomes({ organizationId, verdict, since, limit }),
    requiresConsent: false,
  },
  getActionOutcomeDetail: {
    fn: ({ organizationId, action_id }) =>
      strategyTools.getActionOutcomeDetail({ organizationId, action_id }),
    requiresConsent: false,
  },
  getOutcomeSummary: {
    fn: ({ organizationId, window_days }) =>
      strategyTools.getOutcomeSummary({ organizationId, window_days }),
    requiresConsent: false,
  },

  // ── Actions (write) ───────────────────────────────────────────────────────
  likeFlow: {
    fn: ({ flowId, userId }) => actionTools.likeFlow(flowId, userId),
    requiresConsent: false,
    policyAction: null,
  },
  createFlowSchedule: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      actionTools.createFlowSchedule({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId),
    requiresConsent: true,
    consentKey: "SCHEDULE_FLOW",
    policyAction: "createFlowSchedule",
  },
  triggerFlowRun: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      actionTools.triggerFlowRun({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId),
    requiresConsent: true,
    consentKey: "TRIGGER_FLOW_RUN",
    policyAction: "triggerFlowRun",
  },

  // ── Dashboard tools (read-only, sin consent) ──────────────────────────────
  // Wrappers de las RPCs de Mi Marca / Competencia / Estrategia.
  // Vera invoca estas para responder "cómo voy", "quién me amenaza", etc.

  // Mi Marca
  getBrandKpisStrip:        { fn: ({ params, organizationId }) => dashboardTools.getBrandKpisStrip({ ...(params || {}), organizationId }), requiresConsent: false },
  getPlatformHealth:        { fn: ({ params, organizationId }) => dashboardTools.getPlatformHealth({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandActivityHistory:  { fn: ({ params, organizationId }) => dashboardTools.getBrandActivityHistory({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandEngagementTrend:  { fn: ({ params, organizationId }) => dashboardTools.getBrandEngagementTrend({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandPostingHours:     { fn: ({ params, organizationId }) => dashboardTools.getBrandPostingHours({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedProfile:       { fn: ({ params, organizationId }) => dashboardTools.getFeaturedProfile({ ...(params || {}), organizationId }), requiresConsent: false },
  getFeaturedProfileDetails:{ fn: ({ params, organizationId, brandContainerId }) => dashboardTools.getFeaturedProfileDetails({ ...(params || {}), organizationId, brandContainerId }), requiresConsent: false },
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

  // ── Cosecha de comentarios BAJO DEMANDA ──────────────────────────────────
  // Los scrapers de perfil solo traen la primera tanda de comentarios (en la DB:
  // 6% de cobertura en Instagram, 0% en el resto de redes). Estos actores cobran
  // POR COMENTARIO, asi que no tienen cron: los dispara Vera cuando el hilo
  // completo de un post concreto vale lo que cuesta.
  harvestPostComments: {
    // ...rest: las claves llegan planas, no dentro de un sobre `params`.
    fn: async ({ params, ...rest }) => {
      const p = { ...(params || {}), ...rest };
      const started = await commentHarvest.requestHarvest({
        brandPostId: p.brand_post_id,
        cap: p.cap,
        reason: p.reason || null,
      });
      if (started.reused && started.status !== "running") {
        return { ...started, ...(await commentHarvest.getHarvest({ jobId: started.job_id })) };
      }
      // Espera activa acotada: el actor suele tardar 30-90s y la ventana de una
      // tool no da para mucho mas. Si no llega, el job_id es la continuacion.
      const espera = Math.max(0, Math.min(180, Number(p.wait_seconds ?? 120)));
      const hasta = Date.now() + espera * 1000;
      while (Date.now() < hasta) {
        await new Promise((r) => setTimeout(r, 5000));
        const estado = await commentHarvest.getHarvest({ jobId: started.job_id });
        if (estado.listo) return { ...started, ...estado, esperado_s: Math.round((Date.now() - (hasta - espera * 1000)) / 1000) };
      }
      return {
        ...started, listo: false,
        note: "la cosecha sigue en curso; recogela con getHarvestedComments(job_id) en tu siguiente paso",
      };
    },
    // NO es escritura: no toca el mundo, solo LEE comentarios publicos. Estuvo
    // marcada requiresConsent porque cuesta dinero, y eso la barria junto a las
    // escrituras en consentMode "block_all" — el modo del productor del tablero.
    // Resultado: Vera pedia el hilo, se lo negaban en silencio y opinaba del tono
    // sin haberlo leido. La gobierna el presupuesto (Capa 5a), no la autonomia.
    requiresConsent: false,
    costsMoney: true,
  },
  getHarvestedComments: {
    fn: ({ params, ...rest }) => {
      const p = { ...(params || {}), ...rest };   // claves planas, no un sobre
      return commentHarvest.getHarvest({ jobId: p.job_id, limit: p.limit });
    },
    requiresConsent: false,
  },
  getCompetenciaRisk:       { fn: ({ params, organizationId }) => dashboardTools.getCompetenciaRisk({ ...(params || {}), organizationId }), requiresConsent: false },
  getBrandVsCompetencia:    { fn: ({ params, organizationId }) => dashboardTools.getBrandVsCompetencia({ ...(params || {}), organizationId }), requiresConsent: false },
  searchCompetidor:         { fn: ({ params, organizationId }) => dashboardTools.searchCompetidor({ ...(params || {}), organizationId }), requiresConsent: false },

  // Estrategia — SOLO métricas reales (hashtags/plataformas). Tonos/temas/
  // sentimientos de la vieja lógica de clasificación ELIMINADOS (JC 2026-07-16).
  getEstrategiaHashtags:         { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaHashtags({ ...(params || {}), organizationId }), requiresConsent: false },
  getEstrategiaPlatforms:        { fn: ({ params, organizationId }) => dashboardTools.getEstrategiaPlatforms({ ...(params || {}), organizationId }), requiresConsent: false },

  // ── VERA Cycle Pulse — tools que Vera usa al recibir un brain feed ────────
  // NOTA: estos wrappers aceptan params PLANOS o ANIDADOS indistintamente
  // ({...(params||{}), ...rest}). Antes solo aceptaban `params` anidado, pero
  // tanto el prompt de chat como los ejemplos del cycle-pulse a veces emiten
  // los campos planos (title:..|body:..) → params quedaba undefined y la tool
  // tiraba "title y body requeridos". Ahora funciona en ambas formas.
  createOrgNotification: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => veraFeedTools.createOrgNotification({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  // Alias canonico v3 — el doc y el prompt nombran `createNotification`,
  // el handler interno es createOrgNotification. Antes faltaba el registro
  // → llamarlo fallaba en la Capa 2 (allowlist) pese a estar en el prompt.
  createNotification: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => veraFeedTools.createOrgNotification({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  proposeStrategicRecommendation: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => veraFeedTools.proposeStrategicRecommendation({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  proposePendingAction: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => decisionTools.proposePendingAction({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  // ── Command Center / Canvas de estrategia (Vera materializa estrategias visuales) ──
  placeNodeOnCanvas: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.placeNodeOnCanvas({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  moveNodeOnCanvas: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.moveNodeOnCanvas({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  removeNodeFromCanvas: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.removeNodeFromCanvas({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  connectNodes: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.connectNodes({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  disconnectNodes: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.disconnectNodes({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  setVeraState: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.setVeraState({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  createStrategy: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.createStrategy({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  listStrategies: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.listStrategies({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  createStickyNote: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.createStickyNote({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  createGroup: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.createGroup({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  buildStrategy: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.buildStrategy({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  proposeExternalAction: { fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => canvasTools.proposeExternalAction({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId), requiresConsent: false },
  getBrainFeed: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => veraFeedTools.getBrainFeed({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  // Vera inicia el dialogo con un humano de la org (ejecutar-e-informar)
  initiateConversation: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) => veraFeedTools.initiateConversation({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },

  // ── Aliases canonicos v3 (protocolo VERA <-> ai-engine v3) ────────────────
  // Mismos handlers que los canonical, solo cambia el naming para que VERA
  // pueda invocarlos con los nombres del doc v3 sin aprender los internos.
  // Pendiente Fase B: getMonitoringTargets (canonical getMonitoringTriggers no existe).
  getBrandDNA: {
    fn: ({ organizationId }) => brandTools.getBrandProfile(null, organizationId),
    requiresConsent: false,
  },
  getPendingBriefs: {
    fn: ({ organizationId, status, limit }) =>
      strategyTools.getPendingActions({ organizationId, status, limit }),
    requiresConsent: false,
  },
  getFlows: {
    fn: ({ filters }) => flowTools.getAvailableFlows(filters || {}),
    requiresConsent: false,
  },
  getScraperStatus: {
    fn: ({ organizationId }) => scraperTools.getScraperHealth(null, organizationId),
    requiresConsent: false,
  },
  updateBrandDNA: {
    fn: (params) => brandWriteTools.updateBrandContainer(params),
    requiresConsent: true,
    consentKey: "UPDATE_BRAND_CONTAINER",
  },
  updateProduct: {
    fn: (params) => brandWriteTools.upsertProduct(params),
    requiresConsent: true,
    consentKey: "UPSERT_PRODUCT",
  },
  updateAudienceConcept: {
    fn: (params) => brandWriteTools.upsertAudience(params),
    requiresConsent: true,
    consentKey: "UPSERT_AUDIENCE",
  },
  addCompetitorToMonitoring: {
    fn: (safeParams) => {
      const network = safeParams.network || safeParams.platform;
      const handle = safeParams.handle;
      return scraperTools.addIntelligenceEntity({
        name: safeParams.name || handle,
        platform: network ? String(network).toLowerCase() : undefined,
        handle,
        cadence_minutes: safeParams.cadence_minutes,
      }, null, safeParams.organizationId);
    },
    requiresConsent: false,
  },
  triggerFlow: {
    fn: ({ params, brandContainerId, organizationId, userId, flowId }) => {
      const effectiveParams = {
        ...(params || {}),
        flow_id: params?.flow_id || params?.flowId || flowId,
      };
      return actionTools.triggerFlowRun(effectiveParams, brandContainerId, organizationId, userId);
    },
    requiresConsent: true,
    consentKey: "TRIGGER_FLOW_RUN",
    policyAction: "triggerFlowRun",
  },
  inspectRun: {
    fn: ({ runId, organizationId }) =>
      flowTools.getFlowRunOutputs(runId, null, organizationId),
    requiresConsent: false,
  },

  // ── Tools MISSING criticas v3 (Fase B bloque 1) ───────────────────────────
  getMonitoringTriggers: {
    fn: ({ brandContainerId, organizationId }) =>
      veraActionsTools.getMonitoringTriggers(brandContainerId, organizationId),
    requiresConsent: false,
  },
  getMonitoringTargets: {
    fn: ({ brandContainerId, organizationId }) =>
      veraActionsTools.getMonitoringTriggers(brandContainerId, organizationId),
    requiresConsent: false,
  },
  pauseFlow: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      veraActionsTools.pauseFlow({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId),
    requiresConsent: true,
    consentKey: "PAUSE_FLOW",
  },
  updateCampaignConcept: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.updateCampaignConcept({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: true,
    consentKey: "UPDATE_CAMPAIGN_CONCEPT",
  },
  addKeywordToTrends: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.addKeywordToTrends({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  generateTrendBrief: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.generateTrendBrief({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  removeKeywordFromTrends: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.removeKeywordFromTrends({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  createDefensiveWatch: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      veraActionsTools.createDefensiveWatch({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId),
    requiresConsent: false,
  },
  getBrandHealthMetrics: {
    fn: ({ brandContainerId, organizationId, windowHours }) =>
      veraActionsTools.getBrandHealthMetrics(brandContainerId, organizationId, windowHours),
    requiresConsent: false,
  },
  getPenetrationDiagnosis: {
    fn: ({ brandContainerId, organizationId, windowDays }) =>
      cmoTools.getPenetrationDiagnosis(brandContainerId, organizationId, windowDays),
    requiresConsent: false,
  },
  getCEPGaps: {
    fn: ({ brandContainerId, organizationId, windowDays }) =>
      cmoTools.getCEPGaps(brandContainerId, organizationId, windowDays),
    requiresConsent: false,
  },
  getDemandDiagnosis: {
    fn: ({ brandContainerId, organizationId, windowDays }) =>
      cmoTools.getDemandDiagnosis(brandContainerId, organizationId, windowDays),
    requiresConsent: false,
  },
  getConversionOutcomes: {
    fn: ({ brandContainerId, organizationId, windowDays }) =>
      cmoTools.getConversionOutcomes(brandContainerId, organizationId, windowDays),
    requiresConsent: false,
  },
  getUseCaseExpansion: {
    fn: ({ brandContainerId, organizationId, ...p }) => cmoTools.getUseCaseExpansion(brandContainerId, organizationId, p),
    requiresConsent: false,
  },
  searchIntelligence: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.searchIntelligence({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
    timeout: 20000,
  },
  triggerDeepScrape: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      veraActionsTools.triggerDeepScrape({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },

  // ── Web research (Tavily) — lectura de internet abierto, read-only ─────────
  // NO se expone a Vera: OpenClaw trae web_search y web_fetch integrados con 14+
  // proveedores (Tavily incluido) y ya tiene duckduckgo encendido en su config.
  // Mandarle los nuestros era darle una version mas pobre de algo que el motor
  // hace mejor. Los handlers se quedan por si un proceso de ai-engine los
  // necesita; simplemente no estan en ninguna fase.
  webSearch: {
    fn: ({ params, ...rest }) => webTools.webSearch({ ...(params || {}), ...rest }),
    requiresConsent: false,
    timeout: 25000,
  },
  webFetch: {
    fn: ({ params, ...rest }) => webTools.webFetch({ ...(params || {}), ...rest }),
    requiresConsent: false,
    timeout: 25000,
  },

  // ── Artefactos de marca — Vera genera archivos (PDF/PNG/XLSX/DOCX) ──────────
  getBrandKit: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      artifactTools.getBrandKit({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
  createArtifact: {
    fn: ({ params, brandContainerId, organizationId, userId, ...rest }) =>
      artifactTools.createArtifact({ ...(params || {}), ...rest }, brandContainerId, organizationId, userId),
    requiresConsent: false, // riesgo BAJO (genera un entregable, no publica ni gasta pauta)
    timeout: 60000,         // render con Playwright + upload puede tardar
  },
  listArtifacts: {
    fn: ({ params, brandContainerId, organizationId, ...rest }) =>
      artifactTools.listArtifacts({ ...(params || {}), ...rest }, brandContainerId, organizationId),
    requiresConsent: false,
  },
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
 * @param {{perCycle:number, used:number}} [secCtx.spendBudget]  — tope de llamadas de PAGO por sesion
 */
export async function dispatchTool(toolName, params, secCtx) {
  const {
    organizationId, userId, approvedIntents, allowedTools = [],
    costController, consentMode = "require", orgName = "la organización",
    brandContainerId = null, spendBudget = null,
  } = secCtx;
  const auditCtx = { organizationId, userId, conversationId: secCtx.conversationId };

  audit.toolRequested(auditCtx, toolName, params);

  // ── Capa 1: Phase check — valida contra autonomy.phase (fuente: DB) ────
  // allowedTools viene de TOOLS_BY_PHASE[autonomy.phase] en ai.service.js y
  // mcp.controller.js (ambos usan `?? TOOLS_BY_PHASE.A`), así que SIEMPRE llega
  // poblado (A=38 tools). FAIL-CLOSED (2026-07-02): antes `allowedTools.length > 0 &&`
  // hacía que una lista VACÍA (bug de resolución de fase o caller que la omita)
  // saltara el gate y habilitara TODA tool, incluidas las de escritura de fase C.
  // Ahora lista vacía = ninguna tool permitida (deny).
  if (!allowedTools.length || !allowedTools.includes(toolName)) {
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
    // El sintetizador rechazó un formato de Vera → capturar para auto-reparación.
    captureSynthError({
      organizationId, conversationId: secCtx.conversationId, userId,
      toolName, params, reason: validation.reason,
    });
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

  // ── Capa 5a: gasto SIN escritura ────────────────────────────────────────
  // Una tool que solo LEE pero cuesta dinero no es una escritura, y meterla en
  // el gate de consentimiento fue un error de categoría con consecuencias: en
  // "block_all" (el modo del productor del tablero) la cosecha de comentarios
  // quedaba muda, y Vera terminaba deduciendo el tono de hilos que nunca abrió.
  // Bloquear una LECTURA no protege a nadie — la empuja a opinar sin mirar, que
  // sale más caro que los centavos que ahorra. Lo que gobierna estas tools es un
  // PRESUPUESTO: tope por ciclo y techo mensual, ambos fail-closed.
  if (tool.costsMoney) {
    const techo = Number(process.env.HARVEST_MAX_USD_MES || 15);
    if (techo > 0) {
      let gasto;
      try {
        gasto = await commentHarvest.gastoDelMes({ organizationId });
      } catch (e) {
        // Un contador roto no autoriza gasto: fail-closed, igual que Capa 1.
        throw Object.assign(new Error(
          `[PRESUPUESTO] no se pudo verificar el gasto del mes (${e.message}); no se cosecha a ciegas`
        ), { statusCode: 429, budgetDenied: true });
      }
      if (gasto.usd >= techo) {
        audit.consentGate(auditCtx, `BUDGET_MONTH_${toolName}`);
        throw Object.assign(new Error(
          `[PRESUPUESTO] la cosecha ya lleva $${gasto.usd} este mes (techo $${techo}). ` +
          `NO inventes lo que no pudiste leer: baja la confianza y di en la card que no leíste ese hilo.`
        ), { statusCode: 429, budgetDenied: true });
      }
    }
    if (spendBudget && Number.isFinite(spendBudget.perCycle)) {
      if ((spendBudget.used || 0) >= spendBudget.perCycle) {
        audit.consentGate(auditCtx, `BUDGET_CYCLE_${toolName}`);
        throw Object.assign(new Error(
          `[PRESUPUESTO] ya usaste las ${spendBudget.perCycle} llamadas de pago de este ciclo. ` +
          `NO inventes lo que no pudiste leer: baja la confianza y di en la card que no leíste ese hilo.`
        ), { statusCode: 429, budgetDenied: true });
      }
      spendBudget.used = (spendBudget.used || 0) + 1;
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
      // require (parcial): comportamiento estándar — necesita APPROVE_ACTION.
      // Deriva la consentKey del nombre del tool si no está definida en el registry
      // (evita APPROVE_ACTION:undefined y mantiene el check consistente end-to-end).
      const consentKey = tool.consentKey || toolName.toUpperCase();
      const hasConsent = approvedIntents instanceof Set
        ? approvedIntents.has(consentKey)
        : false;

      if (!hasConsent) {
        audit.consentGate(auditCtx, consentKey);
        throw Object.assign(
          new Error(
            `La acción "${toolName}" requiere confirmación humana. ` +
            `Aprueba: APPROVE_ACTION:${consentKey}`
          ),
          { statusCode: 403, requiresConsent: true, consentKey }
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

  // Inyectamos organizationId/userId siempre, y brandContainerId de la
  // conversacion (si lo hay y Vera no lo paso explicito). Antes brandContainerId
  // NO se inyectaba en el chat → las tools caian a resolveBrandContainer = la
  // marca mas antigua, operando sobre la marca equivocada en orgs multi-marca.
  // El cycle-pulse ya lo inyectaba; ahora ambos caminos son consistentes.
  const safeParams = { ...params, organizationId, userId, allowedTools };
  if (brandContainerId && !safeParams.brandContainerId && !safeParams.brand_container_id) {
    safeParams.brandContainerId = brandContainerId;
  }
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
