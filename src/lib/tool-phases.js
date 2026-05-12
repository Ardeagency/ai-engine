/**
 * Tool Phases — define las herramientas disponibles por nivel de autonomía.
 *
 * FASE A → restringido: lectura básica de marca, productos, campañas.
 * FASE B → parcial:     lectura ampliada + inteligencia + integraciones.
 * FASE C → total:       todo lo anterior + acciones de escritura.
 *
 * La fase activa de cada org la determina `autonomy.js` leyendo
 * `level_of_autonomy` de la tabla `organizations` (no variables de entorno).
 *
 * Este archivo solo exporta las listas de tools — no contiene lógica de org.
 */

export const PHASE_A_TOOLS = [
  // Resumen org — disponible en todos los niveles
  "getOrgOverview",
  // Brand read — perfil básico
  "getBrandContainers",
  "getBrandProfile",
  "getAudiences",
  "getProducts",
  "getCampaigns",
  "getAvailableFlows",
  // Dashboard tools (read-only, sin consent) — Vera puede responder cualquier
  // pregunta de "cómo voy", "quién me amenaza", "top tema", etc. desde Phase A.
  "getBrandKpisStrip",
  "getBrandActivityHistory",
  "getBrandEngagementTrend",
  "getBrandSentimentActivity",
  "getBrandPostingHours",
  "getFeaturedProfile",
  "getFeaturedProfileDetails",
  "getFeaturedTopic",
  "getFeaturedHashtag",
  "getFeaturedHour",
  "getFeaturedPlatform",
  "getFeaturedGrowth",
  "getAlertScore",
  "getTopHighlightedPosts",
  "getCompetenciaKpis",
  "getCompetenciaTop",
  "getCompetenciaFeatured",
  "getCompetenciaTopPosts",
  "getCompetenciaActorDetails",
  "getCompetenciaRisk",
  "getBrandVsCompetencia",
  "searchCompetidor",
  "getEstrategiaTopics",
  "getEstrategiaHashtags",
  "getEstrategiaTones",
  "getEstrategiaPlatforms",
  "getEstrategiaSentimentsByBrand",
];

export const PHASE_B_TOOLS = [
  ...PHASE_A_TOOLS,
  // Brand read — ampliado
  "getBrandEntities",
  "getIntegrations",
  // Intelligence read
  "getIntelligenceEntities",
  "getTrendTopics",
  "getBrandPosts",
  "getRetailPrices",
  // Monitoring & competitor intelligence (nuevas en Phase B)
  "getMonitoringTriggers",
  "getSensorRuns",
  "getBrandVulnerabilities",
  "getUrlWatchers",
  "getPendingAnalysisJobs",
  "getBodyMissions",
  "getBriefingHoy",
  "getPendingActions",
  "getPendingActionDetail",
  "getStrategyOpportunityScore",
  // Scraper tools — READ (Vera inspecciona su sistema de monitoreo sin gastar tokens en acción)
  "getScraperSessions",
  "getScraperDashboard",
  "getScraperHealth",
  "getCompetitorAnalysis",
  "getContentAnalysisSummary",
  // Scraper tools — WRITE (Vera ajusta y repara su monitoreo — herramientas internas)
  "updateMonitoringTrigger",
  "addIntelligenceEntity",
  "updateIntelligenceEntity",
  "upsertUrlWatcher",
  "toggleUrlWatcher",
  // Scraper tools — TEST (Vera valida que sus cambios no rompen nada)
  "runScraperTest",
  // Flow activity
  "getFlowRuns",
  "getFlowSchedules",
  "getFlowRunOutputs",
  "getIntelligenceSignals",
  // Social analytics (APIs externas — tokens solo para lectura en fase B)
  "getSocialSummary",
  "getMetaPageInsights",
  "getMetaPosts",
  "getInstagramInsights",
  "getInstagramPosts",
  "getGoogleAnalytics",
  // Brand write — editar identidad, audiencias, productos, colores, tipografías, reglas
  "updateBrandProfile",
  "updateBrandContainer",
  "upsertAudience",
  "deleteAudience",
  "upsertProduct",
  "deleteProduct",
  "upsertBrandColor",
  "deleteBrandColor",
  "upsertBrandFont",
  "upsertBrandRule",
  "deleteBrandRule",
];

export const PHASE_C_TOOLS = [
  ...PHASE_B_TOOLS,
  // Write actions — requieren consent + policy además de la fase
  "likeFlow",
  "createFlowSchedule",
  "triggerFlowRun",
  // Vulnerability management (write — requiere confirmación)
  "updateVulnerabilityStatus",
];

export const TOOLS_BY_PHASE = {
  A: PHASE_A_TOOLS,
  B: PHASE_B_TOOLS,
  C: PHASE_C_TOOLS,
};
