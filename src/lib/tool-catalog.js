/**
 * Tool Catalog — fuente UNICA de firmas/ejemplos de invocacion de tools.
 *
 * La usan los DOS caminos de Vera:
 *   - chat        → openclaw.adapter.js (renderEnabledToolsBlock)
 *   - autonomo    → vera-brain-feed.service.js (renderAutonomousToolList)
 *
 * Antes cada camino tenia su propia copia de las firmas (chat: solo nombres;
 * cycle-pulse: hardcoded en buildVeraPrompt) → derivaban y producian errores.
 * Ahora ambos renderizan desde TOOL_EXAMPLES. Una sola verdad.
 *
 * Convencion de los ejemplos:
 *   - NUNCA incluir organizationId ni brandContainerId: el dispatcher los
 *     inyecta solo (en ambos caminos). Vera no pasa IDs internos de marca/org.
 *   - uuids que Vera obtuvo de otra tool (product_id, campaign_id, flow_id,
 *     runId, feed_id) si van explicitos.
 *   - tools de escritura aceptan params planos o anidados (el dispatcher
 *     normaliza); el ejemplo muestra la forma anidada canonica + "reason".
 *   - `<feed_id>` se sustituye por el feed real en el render autonomo.
 */

// nombre → { ex, group } — solo las tools que necesitan guia de params.
// Las que no aparecen aqui se listan por nombre ("sin params").
const TOOL_EXAMPLES = {
  getCatalogDiagnosis: { group: "Lectura e inteligencia", ex: `[[TOOL:getCatalogDiagnosis]]  -> diagnostico de catalogo: score de fichas, %optimizable, gaps, top a mejorar` },
  getLiveProducts:     { group: "Lectura e inteligencia", ex: `[[TOOL:getLiveProducts]]  -> productos EN VIVO del marketplace (Mercado Libre)` },
  getLivePosts:        { group: "Lectura e inteligencia", ex: `[[TOOL:getLivePosts]]  -> posts recientes EN VIVO de X` },
  getLiveAdsMetrics:   { group: "Lectura e inteligencia", ex: `[[TOOL:getLiveAdsMetrics]]  -> campanas de Google Ads EN VIVO (ultimos 7d)` },
  // ── Lectura e inteligencia ──────────────────────────────────────────────
  getBrandHealthMetrics: { group: "Lectura e inteligencia", ex: `[[TOOL:getBrandHealthMetrics|windowHours:168]]  → engagement/sentiment/fatiga/ritmo` },
  getPenetrationDiagnosis: { group: "Lectura e inteligencia", ex: `[[TOOL:getPenetrationDiagnosis|windowDays:30]]  → ¿creces por PENETRACION (compradores nuevos, alcance fuera de tu base) o exprimes a los fieles? indice + veredicto (doctrina Ehrenberg-Bass)` },
  getCEPGaps: { group: "Lectura e inteligencia", ex: `[[TOOL:getCEPGaps|windowDays:90]]  → ocasiones de compra de la categoria (Category Entry Points) donde la marca NO esta presente: donde plantar la marca para ampliar mercado` },
  getDemandDiagnosis: { group: "Lectura e inteligencia", ex: `[[TOOL:getDemandDiagnosis|windowDays:30]]  → ¿la pauta CREA demanda nueva o solo COSECHA la que ya existia? Por marca: ROAS actual vs previo + penetracion. ROAS alto/subiendo con penetracion plana = drenaje (cosecha). USALA antes de recomendar pausar un "burner": puede estar construyendo marca.` },
  getConversionOutcomes: { group: "Lectura e inteligencia", ex: `[[TOOL:getConversionOutcomes|windowDays:90]]  → atribuye cada jugada a resultado de NEGOCIO (leads reales), no a engagement. Cierra el sesgo de vanidad: que jugadas traen leads. Requiere meta_leads poblada (gate Meta leads_retrieval).` },
  scoreContentCitability: { group: "Visibilidad y contenido (CMO)", ex: `[[TOOL:scoreContentCitability|params:{"text":"...el texto/borrador a evaluar..."}]]  → ¿este texto es CITABLE por una IA (ChatGPT/Perplexity/Google AI)? Score 0-100 + que falta (TL;DR, cifras+fuente, tablas, cita de experto, definiciones, Q&A). Rubrica GEO, sin creditos. USALA para revisar un borrador ANTES de publicar y subir citas 30-40%.` },
  getUseCaseExpansion: { group: "Visibilidad y contenido (CMO)", ex: `[[TOOL:getUseCaseExpansion]]  → casos de uso NUEVOS: ocasiones de compra de la categoria (CEPs) que el catalogo aun NO comunica, con el producto que mejor calza y la ancla. Subir frecuencia sin robar share. Reglado, sin creditos.` },
  getDistinctiveAssetsAudit: { group: "Visibilidad y contenido (CMO)", ex: `[[TOOL:getDistinctiveAssetsAudit|params:{"maxImages":6}]]  → BLINK TEST con vision: ¿se reconoce la marca en 0,5s? Mide consistencia/reconocimiento de color/logo/tipografia en tus outputs vs los activos definidos + alerta inconsistencias. CUESTA creditos (vision) — usala on-demand, no en loop.` },
  getPackagingAnalysis: { group: "Visibilidad y contenido (CMO)", ex: `[[TOOL:getPackagingAnalysis|params:{"maxImages":5}]]  → el PACKAGING como palanca: medio (activo distintivo), producto (formato=ocasion nueva) y disponibilidad (legibilidad en anaquel/feed). Diagnostico + oportunidades de formato. CUESTA creditos (vision).` },
  getAuthorityClusterPlan: { group: "Visibilidad y contenido (CMO)", ex: `[[TOOL:getAuthorityClusterPlan|params:{"articles":6}]]  → PLAN de cluster de autoridad (pilar + articulos citables enlazados) desde tu universo de keywords + CEPs. Lo que mas correlaciona con SEO+GEO. CUESTA creditos (LLM). El texto se produce aparte.` },
  getPlatformHealth:     { group: "Lectura e inteligencia", ex: `[[TOOL:getPlatformHealth|params:{"windowDays":30}]]  → salud POR red (IG/FB/X/TikTok/YouTube): conexion, dias sin publicar, engagement_rate real, reach, sentimiento, score 0-100 + señales` },
  searchIntelligence:    { group: "Lectura e inteligencia", ex: `[[TOOL:searchIntelligence|params:{"query":"tu hipotesis","scope":"brand","max_results":8}]]  → busqueda semantica (cosine) DENTRO de tu propia inteligencia/corpus` },
  webSearch:             { group: "Lectura e inteligencia", ex: `[[TOOL:webSearch|params:{"query":"tu busqueda","max_results":5,"topic":"news"}]]  → busqueda en INTERNET en vivo (Tavily): respuesta + fuentes citables. Usala para hechos actuales, tendencias, precios, noticias, datos que NO estan en tu corpus. SIEMPRE cita las url de las fuentes.` },
  webFetch:              { group: "Lectura e inteligencia", ex: `[[TOOL:webFetch|params:{"urls":["https://..."]}]]  → lee el contenido limpio de 1-5 URLs concretas (extraccion, no scraping social). Usala para profundizar en una fuente que encontraste con webSearch.` },
  getBrandKit:           { group: "Generacion de archivos", ex: `[[TOOL:getBrandKit]]  → identidad visual de la marca (colores, fuentes, logo, tono, tagline). Util para decidir paleta o explicar la marca. El render de createArtifact YA aplica estos colores/fuentes/logo automaticamente.` },
  createArtifact:        { group: "Generacion de archivos", ex: `[[TOOL:createArtifact|params:{"type":"report","title":"Analisis de X","content":"# Resumen\\n...markdown...","reason":"informe pedido"}]]  → GENERA UN ARCHIVO descargable con la identidad REAL de la marca (colores/tipografia/logo aplicados automaticamente). type: report|analysis|presentation|infographic|document|table. content=markdown (en presentation separa slides con una linea ---). Para table: data:{sheets:[{name,rows:[[...]]}]}. Para infographic: data:{stats:[{value,label}]}. Devuelve una URL de descarga: SIEMPRE compartela con el usuario.` },
  listArtifacts:         { group: "Generacion de archivos", ex: `[[TOOL:listArtifacts|params:{"limit":10}]]  → historial de archivos que has generado (titulo, formato, url).` },
  getIntelligenceSignals:{ group: "Lectura e inteligencia", ex: `[[TOOL:getIntelligenceSignals]]  (opcional entityId:<uuid>)` },
  getCompetitorAnalysis: { group: "Lectura e inteligencia", ex: `[[TOOL:getCompetitorAnalysis|entityName:<nombre del competidor>]]` },
  getBodyMissions:       { group: "Lectura e inteligencia", ex: `[[TOOL:getBodyMissions|limit:10]]  → tus decisiones previas (no repitas lo que no funciono)` },
  getPendingBriefs:      { group: "Lectura e inteligencia", ex: `[[TOOL:getPendingBriefs|status:proposed]]` },
  getPendingActionDetail:{ group: "Lectura e inteligencia", ex: `[[TOOL:getPendingActionDetail|action_id:<uuid>]]` },
  getBrainFeed:          { group: "Lectura e inteligencia", ex: `[[TOOL:getBrainFeed|feed_id:<feed_id>|bucket:all]]  (buckets: brand_context, competitor_intelligence, trend_signals, threats_and_opportunities, operational_context, counts, all)` },

  // ── Que contenido funciona (rendimiento por tono/tema/formato) ─────────
  // La data viene de post_patterns (615+ posts clasificados). postSource:
  // "brand" = tus posts | "competitor" = competidores | null = ambos.
  getEstrategiaTones:    { group: "Que funciona (rendimiento)", ex: `[[TOOL:getEstrategiaTones|params:{"postSource":"brand","windowDays":90}]]  → tonos que mas performan` },
  getEstrategiaTopics:   { group: "Que funciona (rendimiento)", ex: `[[TOOL:getEstrategiaTopics|params:{"postSource":"brand","windowDays":90}]]  → temas que mas performan` },
  getEstrategiaPlatforms:{ group: "Que funciona (rendimiento)", ex: `[[TOOL:getEstrategiaPlatforms|params:{"postSource":"brand","windowDays":90}]]` },

  // ── Flows ───────────────────────────────────────────────────────────────
  getFlows:          { group: "Flows", ex: `[[TOOL:getFlows]]  → tarjetas de flows (banner, nombre, descripcion, creditos, #producciones, guardado-en-org). SIN inputs aqui — para los inputs de uno elegido usa getFlowInputs.` },
  inspectRun:        { group: "Flows", ex: `[[TOOL:inspectRun|runId:<uuid>]]` },
  getFlowInputs:     { group: "Flows", ex: `[[TOOL:getFlowInputs|flowId:<uuid de getFlows>]]  -> los inputs que ese flow pide (key/required/input_type). Llenalos y ejecuta con runContentFlow.` },
  forgeProductionPrompt:{ group: "Flows", ex: `[[TOOL:forgeProductionPrompt|params:{"intent":"hero shot en cocina de marmol, luz natural","productName":"<opcional>","productionType":"image"}]]  -> prompt PRO (ChatGPT+PLAYBOOK ARDE) para revisar/usar` },
  generateImageDirect:{ group: "Generacion de archivos", ex: `[[TOOL:generateImageDirect|params:{"intent":"descripcion clara de la imagen","aspect_ratio":"1:1"}]]  -> ARRANCA una generacion de imagen REAL (KIE nano-banana + prompt profesional ARDE via ai_global_vectors). ES ASINCRONA: el tool devuelve rapido con status:"generating" y un task_id REAL; NO trae la imagen. El SISTEMA la ENTREGA solo en la conversacion cuando el archivo REAL existe (~60-90s). Tu unica respuesta tras llamarlo: UNA linea diciendo que la estas generando y que aparecera aqui en un momento (es honesto: hay un job real). PROHIBIDO: inventar/adivinar un media_url, decir que "ya esta lista", o pegar una URL — si no la entrego yo, no existe. ANTES de generar una imagen normal SIEMPRE PREGUNTA: "quieres que la genere yo directo, o que use un flujo de la biblioteca (getFlows)?". aspect_ratio 1:1|16:9|9:16|4:5|3:2 (default 1:1). Opcional image_input:[url] para partir de una referencia.` },
  generateVideoDirect:{ group: "Generacion de archivos", ex: `[[TOOL:generateVideoDirect|params:{"intent":"descripcion clara del video","aspect_ratio":"16:9"}]]  -> ARRANCA una generacion de video REAL (KIE Seedance + prompt profesional ARDE). ASINCRONA: devuelve rapido con status:"generating" + task_id real; el SISTEMA entrega el video en la conversacion cuando exista. Tu respuesta: 1 linea de que lo estas generando y que aparecera aqui. PROHIBIDO inventar URL o decir que ya esta. ANTES SIEMPRE PREGUNTA "yo directo o un flujo de la biblioteca?". aspect_ratio 16:9|9:16|1:1.` },
  getRunsAwaitingApproval:{ group: "Flows", ex: `[[TOOL:getRunsAwaitingApproval]]  -> runs secuenciales pausados esperando TU aprobacion + el output de la etapa (revisalo)` },
  approveRunStage:   { group: "Flows", ex: `[[TOOL:approveRunStage|params:{"runId":"<uuid>","approvedOutputId":"<output_id de getRunsAwaitingApproval>","edits":{}}]]  -> apruebas la etapa y el run avanza a la siguiente (como el humano en Studio)` },
  triggerFlow:       { group: "Flows", ex: `[[TOOL:triggerFlow|params:{"flow_id":"<uuid de getFlows>","reason":"por que lo disparas"}]]` },
  runContentFlow:    { group: "Flows", ex: `[[TOOL:runContentFlow|flowSlug:<slug>|inputs:{"campo":"valor"}]]` },
  createFlowSchedule:{ group: "Flows", ex: `[[TOOL:createFlowSchedule|params:{"flow_id":"<uuid>","cron_expression":"0 9 * * *"}]]` },
  pauseFlow:         { group: "Flows", ex: `[[TOOL:pauseFlow|params:{"flow_id":"<uuid>","reason":"genera ruido"}]]` },

  // ── Escritura conceptual (interna a la plataforma) ─────────────────────
  updateBrandDNA:         { group: "Escritura conceptual", ex: `[[TOOL:updateBrandDNA|params:{"propuesta_valor":"...","reason":"que cambio en el mercado"}]]` },
  updateBrandProfile:     { group: "Escritura conceptual", ex: `[[TOOL:updateBrandProfile|params:{"tono_comunicacion":["..."],"reason":"..."}]]` },
  updateProduct:          { group: "Escritura conceptual", ex: `[[TOOL:updateProduct|params:{"product_id":"<uuid>","beneficios_principales":["..."],"reason":"..."}]]` },
  updateAudienceConcept:  { group: "Escritura conceptual", ex: `[[TOOL:updateAudienceConcept|params:{"audience_id":"<uuid>","intereses":["..."],"reason":"..."}]]` },
  updateCampaignConcept:  { group: "Escritura conceptual", ex: `[[TOOL:updateCampaignConcept|params:{"campaign_id":"<uuid>","fields":{"nombre_campana":"..."},"reason":"..."}]]  (solo conceptual, NUNCA Meta/Google Ads)` },

  // ── Inteligencia activa ────────────────────────────────────────────────
  addCompetitorToMonitoring:{ group: "Inteligencia activa", ex: `[[TOOL:addCompetitorToMonitoring|handle:@cuenta|network:instagram|reason:"crece rapido en el nicho"]]` },
  addKeywordToTrends:       { group: "Inteligencia activa", ex: `[[TOOL:addKeywordToTrends|params:{"keyword":"...","geo":"CO","reason":"acelera"}]]` },
  removeKeywordFromTrends:  { group: "Inteligencia activa", ex: `[[TOOL:removeKeywordFromTrends|params:{"keyword":"...","reason":"solo genera ruido"}]]` },
  triggerDeepScrape:        { group: "Inteligencia activa", ex: `[[TOOL:triggerDeepScrape|params:{"target":"@cuenta o uuid","type":"social","reason":"necesito data fresca ya"}]]` },
  createDefensiveWatch:     { group: "Inteligencia activa", ex: `[[TOOL:createDefensiveWatch|params:{"topic":"...","severity":"high","reason":"amenaza emergente"}]]` },

  // ── Notificaciones y briefs ────────────────────────────────────────────
  generateTrendBrief:            { group: "Notificaciones", ex: `[[TOOL:generateTrendBrief|params:{"reason":"competidor X + tendencia Y frescas confirman oportunidad; genero brief estrategico"}]]  -> corre el motor de tendencias ON-DEMAND (colecta+rankea+genera briefs). SOLO cuando hay señales frescas relevantes (nunca en vacio, nunca si ya hay briefs pendientes). Execute-and-inform, ~$0.12.` },
  createNotification:            { group: "Notificaciones", ex: `[[TOOL:createNotification|params:{"title":"...","body":"...","severity":"info"}]]  (severity: info | warning | critical — solo si el humano va a accionar)` },
  proposeStrategicRecommendation:{ group: "Notificaciones", ex: `[[TOOL:proposeStrategicRecommendation|params:{"title":"...","topic":"...","description":"...","confidence":"media"}]]  (confidence: baja | media | alta)` },
  proposePendingAction:          { group: "Notificaciones", ex: `[[TOOL:proposePendingAction|params:{"action_type":"create_brief","reasoning":"por que, cruzando 2 señales","confidence":0.8,"horizon":"hoy","source_signals":["competidor agotado","trend creciente"]}]]  -> ACCION graduada al plan de Estrategia. REGLA 2 FUENTES (>=2 source_signals). action_type: create_brief=CONTENIDO, update_campaign=PAUTA, launch_campaign, update_brand_container=TONO/ADN. CRITICO (crisis/legal) -> usa createNotification, no esto.` },
  initiateConversation:          { group: "Notificaciones", ex: `[[TOOL:initiateConversation|params:{"topic":"tema corto","opening_message":"lo que le quieres decir al humano, en primera persona","reason":"por que abres el hilo","audience_role":"owner"}]]  -> ABRE un hilo de chat con un humano de la org sin esperar a que te escriban. audience_role opcional (owner|admin|member; por defecto owner). Para dialogo/rendir cuentas, no para cada micro-accion.` },
};

// Aliases funcionales: SIGUEN siendo invocables (estan en el registry), pero NO
// se anuncian — se muestra solo el nombre canonico para no duplicar y no marear
// a Vera con dos nombres que hacen lo mismo. Hidden → canonico mostrado:
//   getBrandProfile→getBrandDNA, getAvailableFlows→getFlows,
//   getMonitoringTriggers→getMonitoringTargets, getScraperHealth→getScraperStatus,
//   upsertProduct→updateProduct, updateBrandContainer→updateBrandDNA,
//   upsertAudience→updateAudienceConcept, triggerFlowRun→triggerFlow,
//   createOrgNotification→createNotification, getPendingActions→getPendingBriefs.
const HIDDEN_ALIASES = new Set([
  "getBrandProfile", "getAvailableFlows", "getMonitoringTriggers", "getScraperHealth",
  "upsertProduct", "updateBrandContainer", "upsertAudience", "triggerFlowRun",
  "createOrgNotification", "getPendingActions",
]);

// Todos los nombres que el catalogo referencia (con ejemplo o como alias oculto).
// El guard scripts/check-tool-registry.mjs verifica que TODOS existan en el
// TOOL_REGISTRY, para que el catalogo no anuncie/oculte tools inexistentes.
export const CATALOG_TOOL_NAMES = [...Object.keys(TOOL_EXAMPLES), ...HIDDEN_ALIASES];

const GROUP_ORDER = [
  "Lectura e inteligencia",
  "Visibilidad y contenido (CMO)",
  "Que funciona (rendimiento)",
  "Flows",
  "Escritura conceptual",
  "Inteligencia activa",
  "Notificaciones",
];

/**
 * Arma el cuerpo agrupado del catalogo (sin header) para una lista de tools.
 * @param {string[]} enabledNames
 * @param {object}   [opts]
 * @param {string}   [opts.feedId] — sustituye <feed_id> en getBrainFeed.
 * @returns {string}
 */
function _buildGroupedBody(enabledNames, { feedId = null } = {}) {
  const enabled = (Array.isArray(enabledNames) ? enabledNames : [])
    .filter((n) => !HIDDEN_ALIASES.has(n));
  const seen = new Set();

  const byGroup = new Map();
  const simple = [];
  for (const name of enabled) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = TOOL_EXAMPLES[name];
    if (entry) {
      let ex = entry.ex;
      if (feedId) ex = ex.replace(/<feed_id>/g, feedId);
      if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
      byGroup.get(entry.group).push(`  • ${name}\n    ${ex}`);
    } else {
      simple.push(name);
    }
  }

  const lines = [];
  const keys = [...byGroup.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const g of keys) {
    lines.push(`\n${g.toUpperCase()} (forma exacta de sus params):`);
    lines.push(byGroup.get(g).join("\n"));
  }
  if (simple.length) {
    lines.push(
      `\nOTRAS TOOLS DE LECTURA (sin params, el sistema resuelve todo):\n  ` +
      simple.sort().join(", ")
    );
  }
  return lines.join("\n");
}

/**
 * Bloque [HERRAMIENTAS DISPONIBLES] para el prompt del CHAT.
 * @param {string[]} enabledNames — tools de la fase actual.
 * @param {string}   level        — nivel de autonomia (para el mensaje de "no habilitada").
 */
export function renderEnabledToolsBlock(enabledNames, level = "actual") {
  const header = [
    `[HERRAMIENTAS DISPONIBLES EN ESTE TURNO]`,
    `Sintaxis: [[TOOL:nombre|param:valor|param2:valor2]]. Para params estructurados ` +
    `usa JSON anidado: [[TOOL:nombre|params:{"campo":"valor","reason":"..."}]].`,
    `El sistema resuelve organizationId y brandContainerId automaticamente — NUNCA ` +
    `los pases. Las tools de escritura/accion requieren un campo "reason".`,
    `REGLA CRITICA: si el usuario pide algo y la tool necesaria NO aparece abajo, NO ` +
    `digas "no se hacerlo". Di: "Esa capacidad no esta habilitada en mi nivel de ` +
    `autonomia actual (**${level}**). El usuario puede ajustarlo en Configuracion → ` +
    `Organizacion → Nivel de autonomia."`,
  ].join("\n");
  return header + "\n" + _buildGroupedBody(enabledNames);
}

/**
 * Cuerpo del catalogo para el prompt AUTONOMO (cycle-pulse). Sin header propio
 * (buildVeraPrompt aporta su marco: sintaxis, 3 movimientos, reglas NUNCA).
 * @param {string[]} enabledNames — AUTONOMOUS_TOOLS.
 * @param {object}   [opts] — { feedId } para el drill-down de getBrainFeed.
 */
export function renderAutonomousToolList(enabledNames, { feedId = null } = {}) {
  return _buildGroupedBody(enabledNames, { feedId });
}
