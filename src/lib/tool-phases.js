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
  "getFlowInputs",
  "forgeProductionPrompt",
  "getRunsAwaitingApproval",
  // Dashboard tools (read-only, sin consent) — Vera puede responder cualquier
  // pregunta de "cómo voy", "quién me amenaza", "top tema", etc. desde Phase A.
  "getBrandKpisStrip",
  "getPlatformHealth",
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
  "getCatalogDiagnosis", "getLiveProducts", "getLivePosts", "getLiveAdsMetrics",
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
  // NOTA: getSensorRuns / getBrandVulnerabilities / getUrlWatchers /
  // getPendingAnalysisJobs se removieron aqui: estaban listados en la fase
  // pero NO tienen handler en TOOL_REGISTRY → Vera los veia "habilitados",
  // los invocaba, y la Capa 2 (allowlist) los rechazaba con un error que
  // contradecia el prompt. Re-agregar solo cuando exista su handler.
  "getBodyMissions",
  "getBriefingHoy",
  "getPendingActions",
  "getPendingActionDetail",
  "getStrategyOpportunityScore",
  // Outcomes — loop de retroalimentación (lectura de vera_action_outcomes)
  "getActionOutcomes",
  "getActionOutcomeDetail",
  "getOutcomeSummary",
  // Web research (Tavily) — internet abierto, read-only. Desde Phase B para
  // gatear costo por API externa (igual que searchIntelligence).
  "webSearch",
  "webFetch",
  // Generación de archivos de marca (PDF/PNG/XLSX/DOCX). Riesgo BAJO; desde Phase B.
  "createArtifact",
  "listArtifacts",
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
  "runContentFlow",
  "approveRunStage",
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
  // VERA Cycle Pulse — Vera puede notificar, proponer briefs y leer feeds
  // incluso en autonomy=parcial (todo lo de aquí es non-destructive)
  "createOrgNotification",
  "createNotification", // alias canonico v3 de createOrgNotification
  "proposeStrategicRecommendation",
  "proposePendingAction",
  "getBrainFeed",
  // Aliases canonicos v3 (read + write internos sin consent / con consent normal)
  "getBrandDNA",
  "getPendingBriefs",
  "getFlows",
  "getScraperStatus",
  "updateBrandDNA",
  "updateProduct",
  "updateAudienceConcept",
  "addCompetitorToMonitoring",
  "inspectRun",
  // Fase B bloque 1: tools MISSING v3 implementadas
  "getMonitoringTriggers",
  "getMonitoringTargets",
  "addKeywordToTrends",
  "removeKeywordFromTrends",
  "createDefensiveWatch",
  "triggerDeepScrape",
  // Fase B bloque 3: ultimas 2 tools MISSING v3 (cobertura 26/26)
  "getBrandHealthMetrics",
  "searchIntelligence",
  // Command Center / canvas de estrategia (Vera materializa estrategias)
  "placeNodeOnCanvas","moveNodeOnCanvas","removeNodeFromCanvas","connectNodes","disconnectNodes","setVeraState","createStrategy","listStrategies","createStickyNote","createGroup","buildStrategy","proposeExternalAction",
];

export const PHASE_C_TOOLS = [
  ...PHASE_B_TOOLS,
  // Write actions — requieren consent + policy además de la fase
  "likeFlow",
  "createFlowSchedule",
  "triggerFlowRun",
  // Alias canonico v3
  "triggerFlow",
  // Fase B bloque 1: writes con consent
  "pauseFlow",
  "updateCampaignConcept",
  // NOTA: updateVulnerabilityStatus removido — no tiene handler en
  // TOOL_REGISTRY (tool fantasma). Re-agregar cuando se implemente.
];

export const TOOLS_BY_PHASE = {
  A: PHASE_A_TOOLS,
  B: PHASE_B_TOOLS,
  C: PHASE_C_TOOLS,
};
