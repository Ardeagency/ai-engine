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
// Un campo de texto libre puede ser un OBJETO entero, no solo un string: la card
// de Mi Marca y la lectura de un tab son prosa dentro de una estructura. Antes
// aqui solo cabian strings, asi que esas dos viajaban por el escaneo SQL completo
// y un simple "--" en un titular las tumbaba con "patrones no permitidos" — un
// error que no dice nada sobre lo que de verdad paso. Se les exime igual del
// escaneo SQL y se les sigue aplicando el ESTRICTO sobre su contenido serializado.
const FREETEXT_PARAMS = {
  createArtifact: ["content", "html"],
  webSearch: ["query"],
  initiateConversation: ["opening_message", "topic", "reason"],
  scoreContentCitability: ["text"],
  publishMiMarcaCard: ["card"],
  updateMiMarcaCardItems: ["agregar"],
  publishDashboardReading: ["reading"],
  publishVera4Card: ["card"],
};
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
  // Los otros tres tabs. El contrato narrative v1 va DECLARADO, no insinuado: es
  // una lectura entera de bloques encadenados y sin ver su forma Vera la falla en
  // el primer intento y aprende a base de rechazos caros.
  publishDashboardReading: {
    brandContainerId: "uuid",
    scope: {
      __required: true,
      type: "string",
      enum: ["monitoreo", "tendencias", "estrategia"],
      description: "Que tab escribes: monitoreo=Competencia, tendencias=Tendencias, estrategia=Estrategia. Mi Marca NO se escribe aqui (es tarjeta a tarjeta con publishMiMarcaCard).",
    },
    reading: {
      __required: true,
      type: "object",
      description: "La lectura COMPLETA del tab (contrato narrative v1). Reemplaza entera la anterior: media lectura no es la mitad, es otra cosa.",
      properties: {
        headline: {
          type: "string",
          description: "OBLIGATORIO. El titular de la lectura, maximo 220 caracteres. Lo que este tab dice hoy en una frase.",
        },
        narrative: {
          type: "array",
          description: "OBLIGATORIO. De 1 a 12 bloques tipados, en el orden en que se leen. Tipos: stat_tile {label,value,delta?,direction?,note?} (van PRIMERO, son la fila de KPIs) | insight {title,body,severity:opportunity|warning|threat|neutral,evidence:[evN]} | signal_triangulation {signals:[{observation,source_ref}],so_what} | hypothesis {statement,confidence:alta|media|exploratoria,how_to_verify,evidence:[evN]} | receipt {quote,author_handle?,platform?,engagement?,source_ref} | recommended_move {action,rationale,urgency:hoy|esta_semana|este_mes,evidence:[evN],brief?} | watchlist_item {what,why_watching,check_back?:YYYY-MM-DD} | delta {changed,direction:up|down|new|gone|flat}.",
          items: { type: "object" },
        },
        evidence: {
          type: "object",
          description: "OBLIGATORIO. Mapa de evidencia: clave que empieza por 'ev' (ev1, ev_tosh) -> {kind:post,post_id} | {kind:comment,post_id} | {kind:trend,trend_topic_id} | {kind:signal,signal_id} | {kind:web,url} | {kind:metric,tool,note}. TODA referencia evN usada en un bloque tiene que existir aqui o la lectura se rechaza entera. Maximo 24.",
        },
        meta: {
          type: "object",
          description: "Opcional: {tone_of_reading, data_confidence:alta|media|baja, silence_ok}. data_confidence baja es una respuesta honesta, no un fracaso.",
        },
      },
      required: ["headline", "narrative", "evidence"],
    },
  },
  // ── Cards del cerebro (cards.vera4) ─────────────────────────────────────
  // El contrato va DECLARADO, no insinuado: son 30 moldes con campos distintos
  // y sin verlos Vera los falla en el primer intento y aprende a base de
  // rechazos caros. Es la misma leccion que dejo 22 tools con properties vacio.
  getVera4Encargo:  { scope: { __required: true, type: "string", enum: ["mi_marca", "monitoreo", "tendencias", "estrategia"], description: "El tab cuyo encargo quieres leer. Pidelo ANTES de escribir: el schema dice donde va el texto, el encargo dice por que existe la card." } },
  getVera4Progress: { brandContainerId: "uuid" },
  publishVera4Card: {
    brandContainerId: "uuid",
    scope: {
      __required: true,
      type: "string",
      enum: ["mi_marca", "monitoreo", "tendencias", "estrategia"],
      description: "El tab donde vive la card. Cada type pertenece a UNO: publicarla en otro se rechaza. Las reglas de los tabs se contradicen entre si (Mi Marca tiene PROHIBIDO nombrar competencia), asi que una card fuera de sitio hace que el tablero diga lo que no debe.",
    },
    periodo: {
      type: "string",
      enum: ["week", "month", "year", "all"],
      description: "SOLO para scope 'mi_marca', que tiene filtro de periodo en pantalla (Semana/Mes/Ano/Todo). Por defecto 'month'. Una lectura que no sabe que ventana describe miente en tres de los cuatro botones. Los otros tres tabs lo ignoran.",
    },
    card: {
      __required: true,
      type: "object",
      description: "UNA card entera (se publica de a una: una card mala no puede tumbar a sus hermanas). CAMPOS POR TIPO — MI MARCA (scope 'mi_marca', lleva periodo) — silencio{items:[{clase:pieza_retirada|pregunta_sin_respuesta, que, lectura, quien?, desde?}]} | latencia{dias_promedio?, delta?, peor?:{ventana, se_abrio?, reaccion?, costo?}, mejor?:{ventana, dias?, que_se_hizo?}, markdown?} | impacto_vs_ruido{impacto:[{que, mecanismo}], ruido:[{que, por_que_no_mueve}], dejar_de_hacer?} | emocion_objetivo{emocion:urgencia|deseo|confianza|nostalgia|empoderamiento|pertenencia|asombro, para_quien, que_la_dispara, momento?, cita?} | viabilidad_comercial{gastado?, ventana?, kpi?:{nombre, valor, vara?, estado:sano|justo|malo}, ritmo?, veredicto?:cabe|cabe_moviendo|no_cabe, de_donde_sale?, markdown?} | ritmo{rafagas:[{cuando, piezas?, costo?}], silencios:[{desde, hasta?, ventana_perdida?}], instruccion?} | autopsia{pieza, culpable:mensaje|emocion|timing|formato|adn|mi_intuicion, por_que, leccion, que_estuvo_bien?, descartados?:[{sospechoso, por_que_no}]} | victoria_explicada{pieza, mecanismo, como_se_repite, condiciones?:[{condicion, repetible:bool}], prueba_contraria?} | causalidad{resultado, veredicto:causa_nuestra|mezcla|coincidencia, alternativas?:[{explicacion, descartada_porque?}], confianza?, prueba_propuesta?:{como, mide?, dura?}}. COMPETENCIA ('monitoreo') — anomalia{items:[{perfil, rol:competidor_directo|competidor_indirecto|referente|aliado|otro_sector, antes, ahora, veredicto:responder_hoy|vigilar|ignorar, hipotesis?, prioridad?}]} | error_ajeno{items:[{quien, rol, que_intento, evidencia_del_fallo, causa_raiz, me_puede_pasar:bool, que_ajusto}]}. TENDENCIAS ('tendencias') — pulso_nicho{estado:caliente|tibio|frio|girando, titular, numero?, delta?, markdown?} | senal_debil{items:[{titulo, que_vi, por_que_nadie_lo_ve?, si_es_real?, ventana?, fuerza?:fuerte|media|tenue}]} | triangulacion{nombre_oportunidad, senales:[{observacion, fuente?}] (MINIMO 2, idealmente 3 de fuentes distintas), conclusion, confianza?} | tension{items:[{tension, cita?, de_donde?, por_que_nadie_la_toca?, que_diria_la_marca?}]} | timing{abiertas:[{ventana, cierra?, fase?:antes|durante|despues, que_exige_ahora?}], demasiado_pronto:[{que, volver_a_mirar?, por_que?}]} | lo_que_falta{items:[{hueco, demanda_observada, angulo_de_la_marca, quien_no_lo_cubre?, intencion_comercial?:alta|media|baja}]}. ESTRATEGIA ('estrategia') — decision_del_dia{decision, por_que, costo_de_no_hacerla, horizonte:hoy|esta_semana|este_mes, quien?:vera|equipo_humano|ambos, confianza?} | autoridad_adn{items:[{senal, veredicto:tomar|adaptar|dejar_pasar, razon_desde_el_adn, puerta_de_entrada?}]} | puerta_aprobacion{items:[{que, puerta:publicacion|crisis|estrategia|gasto|contacto_externo, espera_desde?, costo_de_esperar?, estado?:vigente|vence_pronto|vencido}]} | produccion_viva{accion_actual, en_curso:[{pieza, formato?, sirve_a?, estado?:investigando|creando|verificando|lista}], bloqueado:[{que, por, desde?}], proximas:[texto]} | pieza_asombro{titulo, escena, formato, por_que_nadie_mas, por_que_este_formato?, copy_semilla?, emocion?, que_necesita?:[texto]} | formato{items:[{idea, formato, descartado?, por_que_moriria?, prueba?}]} | cadena_portafolio{eslabones:[{pieza, canal?, empuja_a?, estado?:existe|falta}], roto_en?, que_se_pierde?, como_se_arregla?} | verificacion{revisadas?, corregidas:[{pieza, que_estaba_mal, como_quedo?}], rechazadas:[{pieza, por_que}], markdown?} | brief_humano{items:[{que, sirve_a?, con_quien?, donde?, pasos:[texto], antes_de_grabar:[texto], tiempo?, no_hacer?, listo_cuando?}]} | bucle_outcome{tasa_acierto?, items:[{movida, estado:se_hizo|no_se_hizo|se_hizo_distinto, cuando?, resultado?, veredicto?:acerte|me_equivoque|sin_datos, por_que_no?}], markdown?}. TENDENCIAS · disciplina de futuros — crecimiento_categoria{efecto_categoria, efecto_cuota (pueden ser negativos), total_cambio?, cuota_antes?, cuota_ahora?, unidad?} | tendencia_o_moda{senales:[{tema, serie:[2-24], veredicto:tendencia|moda|pronto_para_saber, semanas_activa?, plataformas:[], consistencia?:alta|media|baja}]} — los TRES marcadores van juntos, nunca un puntaje unico | tres_horizontes{h1:[{senal,que_exige,cuando?}], h2:[{senal,que_preparar,revisar_el?}], h3:[{senal,por_que_importa}]} — meterlo todo en H1 se rechaza: si todo se siente urgente, no ordenaste | derecho_a_jugar{items:[{senal, autoridad:si|parcial|no, audiencia:si|parcial|no, momento:pronto|justo|tarde, territorio:libre|disputado|tomado, veredicto:tomar|adaptar|dejar_pasar, razon}]} | curva_adopcion{senales:[{tema, mezcla:[3 valores: innovadores, nicho, mainstream]}], nota_metodo}. MI MARCA · salud de marca (instrumentos: tu alimentas la serie, no eliges la forma) — cobertura_momentos{momentos:[2-14 x {cep, cobertura:0-100, cubierto:bool, piezas?}], ventana_dias?, nota_metodo?} | rejilla_codigos{activos:[2-12 x {tipo, nombre, fama:0-100, unicidad:0-100, veces_aplicado?, de_cuantas_piezas?}], umbral?(50), nota_metodo OBLIGATORIA} | deriva_codigos{fechas:[2-24], series:[{codigo, valores:[uno por fecha]}], destacado?} | construir_vs_cosechar{meses:[2-18], construir:[uno por mes], cosechar:[uno por mes], vara?(60), nota_metodo} | aplauso_vs_propagacion{piezas:[3-40 x {titulo, aplauso, propagacion, formato?}], medianas?:{aplauso,propagacion}, nota_limite? (di que NO mide memoria de marca)} | penetracion_vs_lealtad{meses:[3-24], series:[EXACTAMENTE 2 x {nombre, valores:[uno por mes]}] indexadas a 100, base?} | biblioteca_patrones{patrones:[{patron, confirmado:n, refutado:n, confianza, ultima_prueba?, que_decide}]}. COMPETENCIA · instrumentos (la forma la fija el tablero, tu solo alimentas la serie; escalas FIJAS o no se puede comparar entre meses) — territorio_tematico{temas:[2-8], perfiles:[1-6], celdas:[[0-100]] una fila por perfil y una columna por tema EN EL MISMO ORDEN, nota_metodo} | registro_de_voz{tonos:[3-6 fijos], perfiles:[{perfil, mezcla:[un valor por tono, mismo orden, reparten 100]}], nota_metodo} | emocion_competencia{escala:[3-7, TIENE que incluir un punto 'neutro': ahi se parte el eje], perfiles:[{perfil, valores:[uno por punto de la escala]}], nota_metodo} | busqueda_vs_voz{meses:[3-24], series:[2-3 x {nombre, valores:[uno por mes]}] INDEXADAS a 100 en el primer mes, base?} | supuesto_punto_ciego{items:[{perfil, rol, que_cree, en_que_se_equivoca, evidencia_de_la_grieta, como_se_explota, confianza}]} | proxima_movida{items:[{perfil, movida_probable, por_que_ahora, senal_que_la_confirma, senal_que_la_desmiente (OBLIGATORIA: sin ella no es hipotesis, es deseo), revisar_el, confianza, si_ocurre_que_hago}]}. Cualquier card admite 'evidence':[claves de lo que viste]. Los campos con ? son opcionales.",
      properties: {
        type: {
          type: "string",
          enum: ["cobertura_momentos", "rejilla_codigos", "deriva_codigos", "construir_vs_cosechar", "aplauso_vs_propagacion", "penetracion_vs_lealtad", "biblioteca_patrones", "silencio", "latencia", "impacto_vs_ruido", "emocion_objetivo", "viabilidad_comercial", "ritmo", "autopsia", "victoria_explicada", "causalidad", "anomalia", "error_ajeno", "territorio_tematico", "registro_de_voz", "emocion_competencia", "busqueda_vs_voz", "supuesto_punto_ciego", "proxima_movida", "crecimiento_categoria", "tendencia_o_moda", "tres_horizontes", "derecho_a_jugar", "curva_adopcion", "pulso_nicho", "senal_debil", "triangulacion", "tension", "timing", "lo_que_falta", "decision_del_dia", "autoridad_adn", "puerta_aprobacion", "produccion_viva", "pieza_asombro", "formato", "cadena_portafolio", "verificacion", "brief_humano", "bucle_outcome"],
          description: "Que card es. Determina sus campos y su tab.",
        },
      },
      required: ["type"],
    },
  },
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
      if (inner[f] === undefined) continue;
      // Serializado, no String(): un objeto daria "[object Object]" y el escaneo
      // estricto se quedaria ciego justo sobre el contenido que venia a mirar.
      freetextBlob += " " + (
        typeof inner[f] === "string" ? inner[f] : JSON.stringify(inner[f])
      );
      delete inner[f];
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
