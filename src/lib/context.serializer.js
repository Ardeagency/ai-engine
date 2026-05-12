/**
 * Context Serializer — convierte datos de la organización a markdown legible.
 *
 * Este texto es lo que Vera recibe directamente en su contexto por mensaje.
 * Nunca expone: tokens, credenciales, IDs internos de infraestructura.
 *
 * Regla de tamaño: máximo ~6000 caracteres para no exceder el presupuesto de tokens.
 */

const MAX_ITEMS     = 15;  // items por sección
const MAX_ARRAY_LEN = 5;   // items de un array dentro de un registro
const MAX_CHARS     = 6000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function arr(val, limit = MAX_ARRAY_LEN) {
  if (!Array.isArray(val) || !val.length) return null;
  const items = val.slice(0, limit).filter(Boolean);
  return items.length ? items.join(", ") : null;
}

function price(val, currency = "USD") {
  if (val == null) return null;
  return `$${Number(val).toLocaleString("es")} ${currency}`;
}

function truncate(str, len = 120) {
  if (!str) return null;
  str = String(str).trim();
  return str.length > len ? str.slice(0, len) + "…" : str;
}

// ── Secciones ─────────────────────────────────────────────────────────────────

function serializeProducts(products) {
  if (!products?.length) return null;
  const lines = [`## PRODUCTOS (${products.length})`];
  for (const p of products.slice(0, MAX_ITEMS)) {
    lines.push(`\n### ${p.nombre_producto}`);
    if (p.tipo_producto)         lines.push(`- Tipo: ${p.tipo_producto}`);
    if (p.precio_producto != null) lines.push(`- Precio: ${price(p.precio_producto, p.moneda)}`);
    if (p.descripcion_producto)  lines.push(`- Descripción: ${truncate(p.descripcion_producto)}`);
    const beneficios = arr(p.beneficios_principales);
    if (beneficios) lines.push(`- Beneficios: ${beneficios}`);
    const diferenciadores = arr(p.diferenciadores);
    if (diferenciadores) lines.push(`- Diferenciadores: ${diferenciadores}`);
    const usos = arr(p.casos_de_uso);
    if (usos) lines.push(`- Casos de uso: ${usos}`);
    const variantes = arr(p.variantes);
    if (variantes) lines.push(`- Variantes: ${variantes}`);
    if (p.url_producto) lines.push(`- URL: ${p.url_producto}`);
  }
  return lines.join("\n");
}

function serializeServices(services) {
  if (!services?.length) return null;
  const lines = [`## SERVICIOS (${services.length})`];
  for (const s of services.slice(0, MAX_ITEMS)) {
    lines.push(`\n### ${s.nombre_servicio}`);
    if (s.descripcion_servicio)  lines.push(`- Descripción: ${truncate(s.descripcion_servicio)}`);
    if (s.precio_base != null)   lines.push(`- Precio base: ${price(s.precio_base, s.moneda)}`);
    if (s.duracion_estimada)     lines.push(`- Duración: ${s.duracion_estimada}`);
    const beneficios = arr(s.beneficios_principales);
    if (beneficios) lines.push(`- Beneficios: ${beneficios}`);
    const entregables = arr(s.entregables);
    if (entregables) lines.push(`- Entregables: ${entregables}`);
    const metodologia = arr(s.metodologia_pasos);
    if (metodologia) lines.push(`- Metodología: ${metodologia}`);
    if (s.url_servicio) lines.push(`- URL: ${s.url_servicio}`);
  }
  return lines.join("\n");
}

function serializeAudiences(audiences) {
  if (!audiences?.length) return null;
  const lines = [`## AUDIENCIAS (${audiences.length})`];
  for (const a of audiences.slice(0, MAX_ITEMS)) {
    lines.push(`\n### ${a.name}`);
    if (a.awareness_level)       lines.push(`- Nivel de consciencia: ${a.awareness_level}`);
    if (a.description)           lines.push(`- Descripción: ${truncate(a.description)}`);
    const demograficos = arr(a.datos_demograficos);
    if (demograficos) lines.push(`- Datos demográficos: ${demograficos}`);
    const psicograficos = arr(a.datos_psicograficos);
    if (psicograficos) lines.push(`- Datos psicográficos: ${psicograficos}`);
    const dolores = arr(a.dolores);
    if (dolores) lines.push(`- Dolores: ${dolores}`);
    const deseos = arr(a.deseos);
    if (deseos) lines.push(`- Deseos: ${deseos}`);
    const objeciones = arr(a.objeciones);
    if (objeciones) lines.push(`- Objeciones: ${objeciones}`);
    const gatillos = arr(a.gatillos_compra);
    if (gatillos) lines.push(`- Gatillos de compra: ${gatillos}`);
    const lenguaje = arr(a.estilo_lenguaje);
    if (lenguaje) lines.push(`- Estilo de lenguaje: ${lenguaje}`);
  }
  return lines.join("\n");
}

function serializeCampaigns(campaigns) {
  if (!campaigns?.length) return null;
  const lines = [`## CAMPAÑAS (${campaigns.length})`];
  for (const c of campaigns.slice(0, MAX_ITEMS)) {
    const nombre = c.nombre_campana || "Campaña sin nombre";
    lines.push(`\n### ${nombre}`);
    if (c.descripcion_interna)   lines.push(`- Brief: ${truncate(c.descripcion_interna)}`);
    if (c.cta)                   lines.push(`- CTA: ${c.cta}`);
    if (c.cta_url)               lines.push(`- URL CTA: ${c.cta_url}`);
    const objetivos = arr(c.objetivos_estrategicos);
    if (objetivos) lines.push(`- Objetivos: ${objetivos}`);
    const angulos = arr(c.angulos_venta);
    if (angulos) lines.push(`- Ángulos de venta: ${angulos}`);
    const oferta = arr(c.oferta_principal);
    if (oferta) lines.push(`- Oferta principal: ${oferta}`);
    const contexto = arr(c.contexto_temporal);
    if (contexto) lines.push(`- Contexto temporal: ${contexto}`);
    const tono = arr(c.tono_modificador);
    if (tono) lines.push(`- Modificador de tono: ${tono}`);
  }
  return lines.join("\n");
}

function serializeBrandEntities(entities) {
  if (!entities?.length) return null;
  const byType = {};
  for (const e of entities.slice(0, MAX_ITEMS * 2)) {
    const t = e.entity_type || "otro";
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }
  const lines = [`## ENTIDADES DE MARCA`];
  for (const [type, items] of Object.entries(byType)) {
    lines.push(`\n### Tipo: ${type} (${items.length})`);
    for (const e of items.slice(0, MAX_ITEMS)) {
      lines.push(`- **${e.name}**${e.description ? `: ${truncate(e.description, 80)}` : ""}${e.price != null ? ` — ${price(e.price, e.currency)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function serializeIntelligenceEntities(entities) {
  if (!entities?.length) return null;
  const lines = [`## COMPETIDORES / ENTIDADES MONITOREADAS (${entities.length})`];
  for (const e of entities.slice(0, MAX_ITEMS)) {
    lines.push(`- **${e.name}** | ${e.domain} | ${e.target_identifier}${e.is_active ? " ✓ activo" : " — inactivo"}`);
  }
  return lines.join("\n");
}

function serializeTrendTopics(topics) {
  if (!topics?.length) return null;
  const sorted = [...topics].sort((a, b) => (b.velocity_score || 0) - (a.velocity_score || 0));
  const lines = [`## TENDENCIAS DETECTADAS (${topics.length})`];
  for (const t of sorted.slice(0, MAX_ITEMS)) {
    const vel = t.velocity_score != null ? ` | velocidad: ${t.velocity_score}` : "";
    const rel = t.relevance_score != null ? ` | relevancia: ${t.relevance_score}` : "";
    const src = t.source ? ` | fuente: ${t.source}` : "";
    lines.push(`- **${t.keyword}**${vel}${rel}${src}`);
  }
  return lines.join("\n");
}

function serializeFlowRuns(runs) {
  if (!runs?.length) return null;
  const lines = [`## EJECUCIONES RECIENTES DE FLUJOS (últimas ${runs.length})`];
  for (const r of runs.slice(0, MAX_ITEMS)) {
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString("es") : "";
    lines.push(`- ${r.status?.toUpperCase()} | ${date} | tokens: ${r.tokens_consumed ?? 0}`);
  }
  return lines.join("\n");
}

function serializeSchedules(schedules) {
  if (!schedules?.length) return null;
  const lines = [`## FLUJOS PROGRAMADOS (${schedules.length} activos)`];
  for (const s of schedules.slice(0, MAX_ITEMS)) {
    lines.push(`- ${s.status?.toUpperCase()} | cron: ${s.cron_expression} | produce ${s.production_count ?? 1} contenido(s)`);
  }
  return lines.join("\n");
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Serializa el contexto completo de una organización/marca como markdown.
 * Este texto se inyecta directamente en el mensaje que recibe Vera.
 *
 * @param {object} fullContext  — resultado de buildFullBrandContext()
 * @returns {string|null}       — markdown o null si no hay datos
 */
export function serializeOrgContext(fullContext) {
  if (!fullContext) return null;

  const { brandName, products, services, audiences, campaigns,
          entities, intelligenceEntities, trendTopics,
          recentRuns, activeSchedules } = fullContext;

  const sections = [];

  if (brandName) {
    sections.push(`# DATOS ACTUALES DE LA MARCA: ${brandName}`);
    sections.push(`> Estos datos son reales y están actualizados. Úsalos para responder directamente.\n`);
  }

  const parts = [
    serializeProducts(products),
    serializeServices(services),
    serializeAudiences(audiences),
    serializeCampaigns(campaigns),
    serializeBrandEntities(entities),
    serializeIntelligenceEntities(intelligenceEntities),
    serializeTrendTopics(trendTopics),
    serializeFlowRuns(recentRuns),
    serializeSchedules(activeSchedules),
  ].filter(Boolean);

  if (!parts.length) return null;

  sections.push(...parts);

  let result = sections.join("\n\n");

  // Truncar si es demasiado largo
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS) +
      "\n\n> [contexto truncado por límite de tokens — hay más datos disponibles]";
  }

  return result;
}
