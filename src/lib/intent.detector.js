/**
 * Intent Detector — analiza el mensaje del usuario e identifica qué datos necesita.
 *
 * En lugar de esperar a que Vera pida herramientas (y falle con "Command not found"),
 * ai-engine detecta la intención y pre-carga los datos antes de llamarla.
 *
 * Devuelve un Set de tool names que deben pre-cargarse.
 */

const INTENT_RULES = [
  {
    tool: "getProducts",
    keywords: [
      "producto", "productos", "catálogo", "catalogo",
      "qué vendemos", "que vendemos", "qué tenemos", "que tenemos",
      "artículo", "articulo", "sku", "precio", "precios",
      "oferta", "ofertas", "venta", "ventas", "item", "items",
      "what products", "our products",
    ],
  },
  {
    tool: "getAudiences",
    keywords: [
      "audiencia", "audiencias", "cliente", "clientes",
      "a quién", "a quien", "público objetivo", "publico objetivo",
      "segmento", "segmentos", "buyer persona", "target",
      "a quién le vendemos", "a quien le vendemos",
      "quiénes son", "quienes son",
    ],
  },
  {
    tool: "getCampaigns",
    keywords: [
      "campaña", "campañas", "campaign", "campaigns",
      "promoción", "promociones", "promo", "promos",
      "estrategia de marketing", "marketing",
    ],
  },
  {
    tool: "getBrandProfile",
    keywords: [
      "tono de marca", "identidad de marca", "personalidad de marca",
      "arquetipo", "estilo de comunicación", "estilo de comunicacion",
      "palabras clave", "keywords", "palabras prohibidas",
      "voz de marca", "brand voice", "quiénes somos", "quienes somos",
      "nuestra marca", "sobre la marca",
    ],
  },
  {
    tool: "getBrandEntities",
    keywords: [
      "entidad", "entidades", "servicio", "servicios",
      "lugar", "lugares", "persona", "personas",
      "qué ofrecemos", "que ofrecemos", "portafolio",
    ],
  },
  {
    tool: "getIntelligenceEntities",
    keywords: [
      "competidor", "competidores", "competencia", "competitor",
      "monitoreo", "monitorear", "vigilancia", "surveillance",
      "rival", "rivales",
    ],
  },
  {
    tool: "getTrendTopics",
    keywords: [
      "tendencia", "tendencias", "trending", "trend", "trends",
      "viral", "de moda", "popular", "populares",
      "qué está pasando", "que esta pasando",
    ],
  },
  {
    tool: "getBrandPosts",
    keywords: [
      "publicaciones", "posts", "contenido publicado", "historial de posts",
      "qué publicamos", "que publicamos", "últimos posts", "ultimos posts",
      "redes sociales", "instagram", "facebook", "tiktok",
    ],
  },
  {
    tool: "getCampaigns",
    keywords: [
      "anuncio", "anuncios", "ads", "pauta", "pautas",
    ],
  },
  {
    tool: "getBrandContent",
    keywords: [
      "cómo voy", "como voy", "cómo me va", "como me va",
      "rendimiento", "performance", "salud de la marca", "brand health", "content health",
      "mejor pillar", "mejor pilar", "qué pillar", "que pillar",
      "mejor hora", "mejor día", "mejor dia",
      "cuándo publicar", "cuando publicar", "cuándo conviene", "cuando conviene",
      "tono de mi contenido", "qué tono", "que tono", "tonos dominantes",
      "fatiga", "fatigue", "fatigue risk",
      "cómo está mi marca", "como esta mi marca", "estado de la marca",
      "alineación", "alineacion", "alignment",
      "amenazas", "threats", "vulnerabilidades", "amenaza",
      "resumen de contenido", "estado del contenido",
    ],
  },
  {
    tool: "getAudienceAlignment",
    keywords: [
      "audiencia real", "público real", "publico real",
      "demografía", "demografia", "demographics",
      "match de audiencia", "alineación de audiencia",
      "mi público es", "mi publico es", "quién me sigue", "quien me sigue",
    ],
  },
  {
    tool: "getAvailableFlows",
    keywords: [
      "flow", "flows", "flujo", "flujos", "automatización", "automatizacion",
      "workflow", "qué puedo hacer", "que puedo hacer",
      "qué herramientas", "que herramientas", "qué automatizaciones", "que automatizaciones",
    ],
  },
  {
    tool: "getFlowSchedules",
    keywords: [
      "programado", "programados", "programación", "programacion",
      "schedule", "schedules", "horario", "automático", "automatico",
      "publicación automática", "publicacion automatica",
    ],
  },
  {
    tool: "getRetailPrices",
    keywords: [
      "precio de competencia", "precios competencia",
      "retail", "marketplace", "amazon", "mercado libre",
      "precio del mercado", "precios de mercado",
    ],
  },
];

/**
 * Analiza un mensaje y retorna los tool names que deben pre-cargarse.
 * @param {string} message
 * @returns {string[]} Array de tool names únicos
 */
export function detectDataIntents(message) {
  if (!message || typeof message !== "string") return [];

  const lower = message.toLowerCase();
  const detected = new Set();

  for (const rule of INTENT_RULES) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        detected.add(rule.tool);
        break; // Una keyword es suficiente para activar esta tool
      }
    }
  }

  return [...detected];
}
