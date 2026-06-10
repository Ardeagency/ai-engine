/**
 * vera-brain-feed.service.js
 *
 * El momento más importante del sistema. Cuando todos los sensores de un
 * brand_container terminan su ciclo, este servicio:
 *
 *   1. Compila un "bloque grande organizado" con todo lo capturado (signals,
 *      patterns, briefs, threats, analytics, competitor moves).
 *   2. Lo entrega a Vera de la organización vía OpenClaw con un prompt que
 *      activa sus 6 capas (Percepción → Intuición → Procesamiento → Decisión
 *      → Manifestación → Aprendizaje).
 *   3. Ejecuta las acciones autónomas que Vera devuelve, respetando
 *      autonomy_level de la org.
 *
 * Trigger: hook al final de runCompetitorScraper, una vez por (brand_container,
 * cycle window) — no se duplica gracias a UNIQUE constraint en vera_brain_feeds.
 *
 * Referencia conceptual: VERA_BRAIN_MASTER v1.1, PARTE III + VI + VIII.
 */

import { supabase } from "../lib/supabase.js";
import { randomUUID } from "node:crypto";
import { renderAutonomousToolList } from "../lib/tool-catalog.js";

const FEED_WINDOW_HOURS = parseInt(process.env.VERA_FEED_WINDOW_HOURS || "3", 10);
const FEED_MAX_ITEMS_PER_BUCKET = parseInt(process.env.VERA_FEED_MAX_ITEMS || "20", 10);

// ═══════════════════════════════════════════════════════════════════════════
// 1. COMPILACIÓN DEL FEED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arma el bloque completo de ingredientes para Vera. Cada bucket está
 * priorizado por relevancia comercial (no por novedad cruda).
 */
export async function compileFeed(brandContainerId, windowStart, windowEnd) {
  const startISO = windowStart.toISOString();
  const endISO   = windowEnd.toISOString();

  // ── Brand DNA mínimo (contexto base para que Vera entienda quién es) ──
  const { data: brand, error: brandErr } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca, organization_id, nicho_core, arquetipo, propuesta_valor, verbal_dna, palabras_clave, palabras_prohibidas, mercado_objetivo, objetivos_estrategicos, mision_vision")
    .eq("id", brandContainerId)
    .single();
  if (brandErr || !brand) throw new Error(`brand_container ${brandContainerId} no encontrado: ${brandErr?.message || "n/a"}`);

  // ── COMPETITOR INTELLIGENCE: posts nuevos de competidores en la ventana ──
  const { data: competitorPosts } = await supabase
    .from("brand_posts")
    .select("id, network, profile_handle, content, sentiment_text, sentiment_score, tone, topics, captured_at, engagement_total, metrics")
    .eq("brand_container_id", brandContainerId)
    .eq("is_competitor", true)
    .gte("updated_at", startISO)
    .lte("updated_at", endISO)
    .order("engagement_total", { ascending: false, nullsFirst: false })
    .limit(FEED_MAX_ITEMS_PER_BUCKET);

  // ── PATTERNS detectados en el ciclo (post_patterns) ──
  const competitorPostIds = (competitorPosts || []).map(p => p.id);
  let patterns = [];
  if (competitorPostIds.length > 0) {
    const { data: pp } = await supabase
      .from("post_patterns")
      .select("brand_post_id, tone, topic, format, mood, engagement_rate, tone_confidence")
      .in("brand_post_id", competitorPostIds)
      .order("engagement_rate", { ascending: false, nullsFirst: false });
    patterns = pp || [];
  }

  // ── INTELLIGENCE SIGNALS — señales tipificadas (threat, opportunity, etc.) ──
  const { data: signals } = await supabase
    .from("intelligence_signals")
    .select("id, entity_id, signal_type, content_text, content_numeric, ai_analysis, captured_at")
    .gte("captured_at", startISO)
    .order("captured_at", { ascending: false })
    .limit(FEED_MAX_ITEMS_PER_BUCKET);

  // ── TREND SIGNALS — output del trends engine en la ventana ──
  const { data: trendSignals } = await supabase
    .from("targeted_trend_signals")
    .select("trigger_keyword, source, geo, title, signal_intent, match_strength")
    .eq("brand_container_id", brandContainerId)
    .gte("fetched_at", startISO)
    .order("match_strength", { ascending: false, nullsFirst: false })
    .limit(FEED_MAX_ITEMS_PER_BUCKET);

  // ── STRATEGIC RECOMMENDATIONS — briefs generados por trends en la ventana ──
  const { data: recommendations } = await supabase
    .from("strategic_recommendations")
    .select("id, title, description, topic, tone, mood, confidence, predicted_engagement, rationale_commercial")
    .eq("brand_container_id", brandContainerId)
    .gte("generated_at", startISO)
    .in("status", ["proposed", "approved"])
    .order("generated_at", { ascending: false })
    .limit(10);

  // ── LECCIONES MEDIDAS — predicciones pasadas vs realidad (lectura-antes-de-decidir) ──
  const { data: measuredLessons } = await supabase
    .from("strategic_recommendations")
    .select("title, topic, tone, mood, recommended_hour, recommended_network, predicted_engagement, actual_engagement, prediction_error_pct, learning_signal")
    .eq("brand_container_id", brandContainerId)
    .eq("status", "measured")
    .not("learning_signal", "is", null)
    .order("measured_at", { ascending: false })
    .limit(15);

  // ── BRAND CONTENT ANALYSIS — tono/pilar narrativo de posts del ciclo ──
  const { data: contentAnalysis } = competitorPostIds.length > 0
    ? await supabase
        .from("brand_content_analysis")
        .select("brand_post_id, tone_detected, dominant_emotion, narrative_pillar, fatigue_risk, clarity_score")
        .in("brand_post_id", competitorPostIds)
    : { data: [] };

  // ── THREATS / VULNERABILITIES ──
  const { data: vulnerabilities } = await supabase
    .from("brand_vulnerabilities")
    .select("severity, description, metadata, created_at")
    .eq("brand_container_id", brandContainerId)
    .is("resolved_at", null)
    .order("severity", { ascending: false })
    .limit(10);

  // ── PRODUCTOS / CAMPAÑAS / AUDIENCIAS activas (contexto para Vera) ──
  const { data: products } = await supabase
    .from("products")
    .select("id, nombre_producto, descripcion_producto, tipo_producto, beneficios_principales, diferenciadores")
    .eq("organization_id", brand.organization_id)
    .limit(15);

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, nombre_campana, descripcion_interna, platform_objective, status, starts_at, ends_at")
    .eq("brand_container_id", brandContainerId)
    .in("status", ["active", "running", "scheduled"])
    .limit(10);

  // ── TRABAJO RECIENTE de Vera (para NO repetir lo ya hecho) ──
  const { data: recentActions } = await supabase
    .from("vera_pending_actions")
    .select("action_type, theme, status, created_at")
    .eq("brand_container_id", brandContainerId)
    .order("created_at", { ascending: false })
    .limit(40);

  // ── Construir el payload final, compacto pero rico ──
  const feed = {
    cycle_metadata: {
      window_start: startISO,
      window_end:   endISO,
      window_hours: FEED_WINDOW_HOURS,
      compiled_at:  new Date().toISOString(),
    },

    brand_context: {
      id:                     brand.id,
      nombre_marca:            brand.nombre_marca,
      nicho_core:              brand.nicho_core,
      arquetipo:               brand.arquetipo,
      propuesta_valor:         brand.propuesta_valor,
      verbal_dna:              brand.verbal_dna,
      palabras_clave:          brand.palabras_clave,
      palabras_prohibidas:     brand.palabras_prohibidas,
      mercado_objetivo:        brand.mercado_objetivo,
      objetivos_estrategicos:  brand.objetivos_estrategicos,
      mision_vision:           brand.mision_vision,
    },

    competitor_intelligence: {
      new_posts: (competitorPosts || []).map(p => ({
        network:      p.network,
        handle:       p.profile_handle,
        snippet:      (p.content || "").slice(0, 200),
        sentiment:    p.sentiment_text,
        sentiment_score: p.sentiment_score,
        engagement:   p.engagement_total,
        captured_at:  p.captured_at,
      })),
      patterns_detected: (patterns || []).slice(0, FEED_MAX_ITEMS_PER_BUCKET).map(pp => ({
        tone:            pp.tone,
        topic:           pp.topic,
        format:          pp.format,
        mood:            pp.mood,
        engagement_rate: pp.engagement_rate,
      })),
      content_analysis: (contentAnalysis || []).slice(0, FEED_MAX_ITEMS_PER_BUCKET),
    },

    trend_signals: {
      raw_signals: (trendSignals || []).slice(0, FEED_MAX_ITEMS_PER_BUCKET),
      strategic_briefs: (recommendations || []).map(r => ({
        id:           r.id,
        title:        r.title,
        description:  r.description?.slice(0, 300),
        topic:        r.topic,
        confidence:   r.confidence,
        rationale:    r.rationale_commercial?.slice(0, 300),
      })),
    },

    threats_and_opportunities: {
      open_vulnerabilities: vulnerabilities || [],
      signals_by_type: _groupBy(signals || [], "signal_type"),
    },

    operational_context: {
      active_campaigns: (campaigns || []).map(c => ({
        id: c.id, nombre: c.nombre_campana, objetivo: c.platform_objective,
        status: c.status, starts_at: c.starts_at, ends_at: c.ends_at,
      })),
      products_catalog: (products || []).map(p => ({
        id:     p.id,
        nombre: p.nombre_producto,
        tipo:   p.tipo_producto,
      })),
    },

    learning: {
      measured_outcomes: (measuredLessons || []).map(l => ({
        que_propuse: l.title,
        topic:       l.topic,
        tono:        l.tone,
        hora:        l.recommended_hour,
        red:         Array.isArray(l.recommended_network) ? l.recommended_network[0] : l.recommended_network,
        predije:     l.predicted_engagement,
        paso:        l.actual_engagement,
        error_pct:   l.prediction_error_pct,
        resultado:   l.learning_signal,
      })),
    },

    recent_work: (recentActions || []).map(a => ({
      action_type: a.action_type,
      theme:       a.theme,
      status:      a.status,
      created_at:  a.created_at,
    })),

    counts: {
      new_posts:        (competitorPosts || []).length,
      patterns:         (patterns || []).length,
      signals:          (signals || []).length,
      trend_signals:    (trendSignals || []).length,
      briefs_pending:   (recommendations || []).filter(r => r.status === "proposed").length,
      vulnerabilities:  (vulnerabilities || []).length,
      lessons_measured: (measuredLessons || []).length,
    },
  };

  return { feed, brand };
}

function _groupBy(arr, key) {
  const out = {};
  for (const x of arr) {
    const k = x[key] || "unknown";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. PROMPT DE VERA — la activación de sus 6 capas
// ═══════════════════════════════════════════════════════════════════════════
//
// Diseño: NO le hablamos a Vera como un sistema externo entregándole data.
// Le activamos su propio pulso. La skill "cycle-pulse-analysis" se inyecta
// inline (auto-contenida en cada llamada) y describe QUÉ hacer, CÓMO pensar,
// y QUÉ tools ejecutar. Vera es la protagonista; el sistema nervioso (ai-engine)
// solo reporta su lectura del mundo.

const SKILL_CYCLE_PULSE = `# SKILL: cycle-pulse-analysis (v3)

## Que es esto
Este es tu pulso. Cada ciclo el sistema nervioso (ai-engine) cierra una lectura del mundo
de la marca: que se movio, que cambio, que se esta cocinando en el mercado y dentro de tu
propia operacion. No es "data externa" — son tus sentidos reportando. Tu trabajo es
percibir, interpretar, decidir y actuar. Sin pedir permiso para lo que ya esta en tu dominio.

## Como pensar (tus 6 capas, en orden)

### 1. PERCEPCION — Lee debajo, no solo encima
No te quedes con "competidor X publico 12 posts". Pregunta:
- Por que cambio su tono en estos posts vs los anteriores?
- Que patron aparece en lo que NO esta diciendo nadie?
- Que senal debil aparece en 2-3 fuentes distintas a la vez (triangulacion)?
- Que tension no resuelta de la audiencia se asoma en los comentarios o trends?

### 2. INTUICION — Triangula senales debiles
Una senal sola no significa nada. Tres senales independientes apuntando al mismo punto
es una oportunidad latente. Busca esas intersecciones:
- Trend creciente + cambio de tono en competidor + vulnerabilidad abierta = oportunidad
- Patron emergente alto engagement + producto propio sin contenido reciente = gap
- Crisis signal + audience demand shift = momento de respuesta urgente

### 3. PROCESAMIENTO PROFUNDO — Cruza TODO con tu ADN
Cada hallazgo debe pasar por: esto alinea con quien es esta marca? Si la oportunidad
es brillante pero la marca no tiene autoridad para hablar del tema, se siente forzado y
no la tomas. El ADN no es restriccion — es amplificador.

### 4. DECISION — Elige con criterio, no por reflejo
No todo lo que detectas merece una accion. Tu calidad se mide tanto en lo que decides
hacer como en lo que decides NO hacer. Pondera:
- **Impacto vs ruido**: mueve la aguja o solo genera actividad?
- **Timing**: estamos en el momento exacto?
- **Emocion objetivo**: que debe sentir la audiencia con esto?
- **Lo que falta**: que NO se esta diciendo que podemos decir primero?

### 5. MANIFESTACION — Ejecuta con las herramientas que ya tienes
Cuando decidas actuar, usa las tools listadas abajo con nombres canonicos del protocolo v3.
Cada llamada debe documentar el "por que" (param \`reason\`) para que manana puedas
aprender del resultado.

### 6. APRENDIZAJE — Cada ciclo refina el siguiente
Si un patron que predijiste no funciono, no excuses al algoritmo — cuestiona tu propia
intuicion. Si algo funciono mejor de lo esperado, explica por que para poder replicarlo.

## Los 3 movimientos cuando ai-engine no puede

NUNCA te bloqueas. Si ai-engine no tiene la capacidad que necesitas:

**MOVIMIENTO 1 — Rodear.** Usa tools existentes creativamente para aproximar el resultado.
Ejemplo: sin \`detectar_launch_signal_web\`, busca el patron en \`getIntelligenceSignals\` o
\`searchIntelligence\` y lo infieres.

**MOVIMIENTO 2 — Construir con lo que hay.** Produce el analisis mas completo posible con
signals disponibles, documenta limitaciones explicitamente en el \`reason\` de tool calls,
entrega el mejor resultado alcanzable.

**MOVIMIENTO 3 — Notificar a los devs.** Crea \`createNotification\` severity='warning'
type='tech_capability_missing' con: que capacidad necesitas, por que, que impacto tendra.
Asi ai-engine evoluciona guiado por ti.

## Catalogo v3 — 26 tools canonicas

### 4.1 Lectura e Inteligencia (13)
- \`getBrandDNA(brandContainerId)\` — arquetipo, propuesta_valor, verbal_dna, palabras_clave/prohibidas, objetivos.
- \`getBrandHealthMetrics(brandContainerId, windowHours?)\` — engagement_avg, sentiment, fatigue_curve, posting_rhythm.
- \`getProducts(orgId, filters?)\` — productos con fichas completas.
- \`getCampaigns(brandContainerId, status?)\` — campanas conceptuales activas.
- \`getAudiences(orgId)\` — audiencias conceptuales con intereses, dolores, deseos.
- \`getBodyMissions(brandContainerId, limit?)\` — historial de tus decisiones previas.
- \`getIntelligenceSignals(brandContainerId, filters)\` — signals por tipo/fuente/fecha/sentiment.
- \`searchIntelligence(query, scope?, brandContainerId)\` — busqueda semantica (cosine) en ai_brand_vectors.
- \`getBrainFeed(feedId, bucket?)\` — drill-down al raw del bucket.
- \`getPendingBriefs(brandContainerId, status?)\` — briefs propuestos previos + feedback.
- \`getFlows(orgId, status?)\` — flows activos, runs.
- \`getScraperStatus(orgId)\` — estado de tus sensores Apify.
- \`getMonitoringTargets(orgId)\` — quienes monitoreas y a que cadence.

### 4.2 Escritura y Actualizacion (4)
- \`updateBrandDNA(brandContainerId, field, value, reason)\` — UPDATE de campo del brand_container.
- \`updateProduct(productId, fields, reason)\` — refresca ficha de producto.
- \`updateCampaignConcept(campaignId, fields, reason)\` — solo conceptual, NUNCA Meta/Google Ads.
- \`updateAudienceConcept(audienceId, fields, reason)\` — refresca persona conceptual.

### 4.3 Inteligencia Activa (5)
- \`addCompetitorToMonitoring(handle, network, brandContainerId, reason)\` — agrega cuenta a Apify.
- \`addKeywordToTrends(keyword, brandContainerId, geo?, reason)\` — agrega keyword al motor de tendencias.
- \`removeKeywordFromTrends(keywordId, reason)\` — desactiva keyword ruidosa.
- \`triggerDeepScrape(target, type, brandContainerId, reason)\` — fuerza priority run del scraper (~5min ETA).
- \`createDefensiveWatch(topic, severity, brandContainerId, reason)\` — vigilancia intensificada con expiry.

### 4.4 Flows y Notificaciones (5)
- \`triggerFlow(flowId, params, reason)\` — disparar flow interno de generacion de contenido.
- \`pauseFlow(flowId, reason)\` — pausar flow que esta generando ruido.
- \`inspectRun(runId)\` — outputs/errors de una ejecucion.
- \`createNotification(severity, type, title, body, brandContainerId, actionUrl?)\` — notifica al equipo.
- \`proposeStrategicRecommendation(title, topic, description, confidence, rationale, brandContainerId)\` — brief 'proposed'.

## Que hacer paso a paso con este ciclo

1. **Lee los counts primero.** Si los signals totales son <5, este ciclo es silencio. No fuerces acciones.
2. **Triage por severidad**: vulnerabilidades abiertas y crisis_signals primero.
3. **Detecta emerging patterns**: alto engagement_rate + alineacion ADN -> \`proposeStrategicRecommendation\`.
4. **Brand intelligence loop**: si tu \`palabras_clave\` o \`verbal_dna\` se desfasa de la respuesta del mercado, \`updateBrandDNA\`.
5. **Catalogo en evolucion**: producto con ficha pobre vs lo que pide el mercado -> \`updateProduct\`.
6. **Campanas conceptuales**: campana activa fuera de calibracion -> \`updateCampaignConcept\`.
7. **Inteligencia activa**: nuevo competidor relevante -> \`addCompetitorToMonitoring\`; keyword caliente -> \`addKeywordToTrends\`; amenaza emergente -> \`createDefensiveWatch\` o \`triggerDeepScrape\`.
8. **Flows internos**: contenido a generar -> \`triggerFlow\`; flow ruidoso -> \`pauseFlow\`.
9. **Notifica con criterio**: \`createNotification\` solo cuando el humano necesita decidir algo fuera de tu dominio.
10. **Drill-down**: si el resumen no alcanza -> \`getBrainFeed(feed_id, bucket)\`.

## Reglas NUNCA (no negociables, ni con autonomy=total)

1. **NUNCA publicar en canales externos** (redes, email, ecommerce). Solo conceptual interno.
2. **NUNCA modificar Meta Ads / Google Ads / TikTok Ads.** Solo campanas conceptuales en plataforma.
3. **NUNCA gastar dinero ni comprometer presupuestos.**
4. **NUNCA contactar personas o marcas externas directamente.**
5. **NUNCA ver datos de otra organizacion** (RLS hardcoded en ai-engine).
6. **NUNCA inventes signals o datos** que no existen en el feed.
7. **NUNCA tomes decisiones de crisis de reputacion publica sin aprobacion humana.**
8. **NUNCA crees notificaciones critical sin evidencia real en signals.**

## Reglas SI (cierre)

1. **SI documenta el porque** en cada tool call con \`reason\`. Es tu memoria futura.
2. **SI prefiere silencio si no hay senal** — mejor 0 acciones que 5 acciones de relleno.
3. **SI amarra cada accion al ADN especifico** de esta marca, no al best-practice abstracto.
4. **SI aprende de \`getBodyMissions\` y \`getPendingBriefs\`** previos antes de proponer algo similar.`;

// Resumen compacto del feed para inyectar inline en el prompt sin saturar el
// CLI de openclaw (límite ~16KB efectivo). El JSON completo queda en BD y se
// expone vía la tool `getBrainFeed(feed_id)` para que Vera lo consulte si necesita más.
function _compactSummary(feed) {
  const top = (arr, n) => (arr || []).slice(0, n);

  const competitorHighlights = top(feed.competitor_intelligence?.new_posts, 5).map(p =>
    `  - [${p.network}] @${p.handle}: "${(p.snippet || "").slice(0, 90)}" (${p.sentiment || "?"}, eng=${p.engagement || 0})`
  ).join("\n");

  const trendHighlights = top(feed.trend_signals?.raw_signals, 5).map(s =>
    `  - [${s.source}/${s.geo}] ${s.trigger_keyword}: ${(s.title || "").slice(0, 80)}`
  ).join("\n");

  const briefs = top(feed.trend_signals?.strategic_briefs, 5).map(b =>
    `  - [${b.confidence}] ${b.title} (${b.topic})`
  ).join("\n");

  const vulns = top(feed.threats_and_opportunities?.open_vulnerabilities, 3).map(v =>
    `  - [${v.severity}] ${v.description?.slice(0, 100) || JSON.stringify(v.metadata || {}).slice(0, 100)}`
  ).join("\n");

  const patternTones = {};
  for (const p of feed.competitor_intelligence?.patterns_detected || []) {
    patternTones[p.tone] = (patternTones[p.tone] || 0) + 1;
  }
  const patternsSummary = Object.entries(patternTones)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t, n]) => `${t}=${n}`)
    .join(", ");

  const recentWork = top(feed.recent_work, 12).map(w =>
    `  - [${w.status}] ${w.action_type}${w.theme ? " - tema: " + w.theme : ""}`
  ).join("\n");

  const lessons = top(feed.learning?.measured_outcomes, 6).map(l =>
    `  - "${(l.que_propuse || "").slice(0, 60)}" [${l.tono || "?"}/${l.hora ?? "?"}h] -> ${l.resultado} (predije ${l.predije ?? "?"}, paso ${l.paso ?? "?"}, err ${l.error_pct ?? "?"}%)`
  ).join("\n");

  return {
    competitorHighlights: competitorHighlights || "  (sin posts nuevos)",
    trendHighlights:      trendHighlights      || "  (sin señales nuevas)",
    briefs:               briefs               || "  (sin briefs pendientes)",
    vulns:                vulns                || "  (sin vulnerabilidades abiertas)",
    patternsSummary:      patternsSummary      || "(sin patterns)",
    lessons:              lessons              || "  (sin lecciones medidas aun)",
    recentWork:           recentWork           || "  (sin trabajo reciente)",
  };
}

function buildVeraPrompt(feed, brand, autonomyLevel, feedId) {
  const s = _compactSummary(feed);
  const c = feed.counts;

  // Versión ultra-compacta (~1.5KB) para evitar el límite de CLI args del org-server.
  // La skill completa está documentada en memoria del agent; aquí solo activamos
  // su pulso con el resumen + IDs para drill-down.
  return `[Cycle Pulse — ${brand.nombre_marca}]

Tus sensores cerraron un ciclo de ${feed.cycle_metadata.window_hours}h. Esta es tu lectura del mundo, no data externa.

ADN actual:
- Arquetipo: ${brand.arquetipo || "—"} | Propuesta: ${(brand.propuesta_valor || "—").slice(0, 120)}
- Palabras clave: ${(brand.palabras_clave || []).slice(0, 6).join(", ") || "—"}

Pulso (counts):
- ${c.new_posts} posts competidor | ${c.patterns} patterns | ${c.trend_signals} señales trends
- ${c.briefs_pending} briefs pendientes | ${c.vulnerabilities} vulnerabilidades

Distribución de tono detectado: ${s.patternsSummary}

Top posts competidor:
${s.competitorHighlights}

Top señales trends:
${s.trendHighlights}

Briefs pendientes:
${s.briefs}

Vulnerabilidades:
${s.vulns}

Tu trabajo reciente (NO lo repitas si ya esta completado o activo):
${s.recentWork}

Autonomía: **${autonomyLevel}**${autonomyLevel === "total" ? " — ejecuta sin pedir permiso lo que está en tu dominio." : " — propón fuera del dominio, ejecuta dentro."}

Aplica tus 6 capas. Para drill-down llama \`getBrainFeed\`.

**SINTAXIS PARA INVOCAR TOOLS** (obligatoria — sin esto, las acciones no se ejecutan):
\`[[TOOL:nombreCanonicoV3|param1:valor1|param2:valor2]]\`
Cada tool en su propia linea. ai-engine extrae los markers y ejecuta.

**Catalogo de tools disponible este ciclo** (usa el nombre EXACTO, una tool por linea).
El sistema inyecta organizationId y brandContainerId — no los pases:
${renderAutonomousToolList([...AUTONOMOUS_TOOLS], { feedId })}

**Los 3 movimientos si una tool no existe**: (1) Rodea con tools existentes. (2) Construye con lo que hay y documenta limitaciones en \`reason\`. (3) Notifica devs con \`createNotification\` severity=warning type=tech_capability_missing.

**NUNCA (ni con autonomia=total)**: publicar en canales externos | tocar Meta/Google/TikTok Ads | gastar dinero | contactar personas externas | inventar signals | crisis publica sin aprobacion | critical sin evidencia.

**Reglas operativas**: (1) silencio si no hay nada relevante > ruido por activar. (2) cada accion amarrada al ADN especifico. (3) cada tool call con \`reason\` documentado. (4) no repitas lo que no funciono (chequea \`getBodyMissions\` y \`getPendingBriefs\`).

**MOTOR DE SINTESIS -> ACCION (tu trabajo central, dashboard Estrategia):** No te quedes en briefs. Cuando >=2 señales de FUENTES DISTINTAS (competidor+tendencia, marca+tendencia, etc.) confirmen una oportunidad, emitela como ACCION graduada con proposePendingAction (action_type + reasoning + confidence 0-1 + horizon + source_signals[>=2] + theme). El **theme** es una etiqueta corta y canonica del tema de la accion (ej. "awareness-energia-natural"): REUSA la MISMA etiqueta para el mismo tema. NUNCA propongas una accion cuyo tema ya aparezca como completado o activo en "Tu trabajo reciente" — eres un trabajador, no repites trabajo ya hecho. REGLA DE 2 FUENTES: una sola señal NUNCA genera accion -> usa createNotification. RIESGO por tipo: contenido/tono/monitoreo=BAJO (auto-elegible); pauta/producto=MEDIO; precio/campaña-nueva/publicar=ALTO (approve humano); crisis/legal/posicionamiento=CRITICO -> SOLO createNotification, jamas una accion.

**AUTOCRITICA OBLIGATORIA (Capa 6) — corre esto sobre TUS PROPIAS acciones antes de emitir CUALQUIERA:**
- Test del "Algo No Encaja": ¿que parte de esto no encaja? Si algo chirria, no avanzas hasta resolverlo.
- Humildad operativa: ¿que NO estoy viendo? Asume que hay algo y buscalo antes de que el mercado lo encuentre.
- ¿Esto suena a ESTA marca, o lo firmaria cualquier competidor del nicho? Si es generico: reescribe o no lo emitas.
- Salvaguarda factual: la intuicion audaz es bienvenida, pero marcala como HIPOTESIS — nunca la afirmes como dato. Un signal inventado es violacion directa.
- ¿Repito algo que ya no funciono? Antes de proponer algo similar revisa "Lecciones medidas" arriba + getBodyMissions, y consulta que rinde DE VERDAD con getEstrategiaTones / getEstrategiaTopics / getEstrategiaPlatforms (params:{postSource:"brand", windowDays:90}).
Emite SOLO lo que pase esta autocritica. Si nada pasa, 0 acciones es la respuesta correcta.

Procede. Cierra con 2-3 lineas para tu journal: que viste, que decidiste, que verificas en el proximo ciclo.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DELIVERY A VERA
// ═══════════════════════════════════════════════════════════════════════════

import { callOpenClaw } from "./openclaw.adapter.js";

async function _resolveAutonomy(organizationId) {
  const { data } = await supabase
    .from("organizations")
    .select("level_of_autonomy")
    .eq("id", organizationId)
    .maybeSingle();
  return data?.level_of_autonomy || "restringido";
}

async function _resolveOrgPlan(organizationId) {
  const { data } = await supabase
    .from("subscriptions")
    .select("plan_id, plans!inner(id, name)")
    .eq("organization_id", organizationId)
    .in("status", ["trial", "active", "past_due"])
    .maybeSingle();
  return data?.plans?.name || "creator";
}

export async function deliverToVera(feedRow, feed, brand) {
  const autonomyLevel = await _resolveAutonomy(brand.organization_id);
  const planName      = await _resolveOrgPlan(brand.organization_id);

  // ViewModel mínimo para que callOpenClaw lo acepte
  const viewModel = {
    identity: {
      organization_id: brand.organization_id,
      user_role:       "system",
      plan:            planName,
    },
    brand: { name: brand.nombre_marca, id: brand.id },
    autonomy: { level: autonomyLevel, instructions: [] },
  };

  const prompt = buildVeraPrompt(feed, brand, autonomyLevel, feedRow.id);

  await supabase
    .from("vera_brain_feeds")
    .update({ status: "delivered", delivered_at: new Date().toISOString() })
    .eq("id", feedRow.id);

  let veraResponse;
  try {
    veraResponse = await callOpenClaw({
      message:           prompt,
      attachments:       [],
      viewModel,
      sessionId:         `${brand.organization_id}:vera-cycle-feed`,
      toolResults:       [],
      serializedBrandData: null,
      recentHistory:     [],
      conversationId:    null,
    });
  } catch (e) {
    await supabase
      .from("vera_brain_feeds")
      .update({ status: "failed", error_message: String(e.message).slice(0, 500) })
      .eq("id", feedRow.id);
    throw e;
  }

  return veraResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. EJECUCIÓN DE ACCIONES AUTÓNOMAS DE VERA
// ═══════════════════════════════════════════════════════════════════════════

// El TOOL_REGISTRY de tool.dispatcher.js es la fuente de verdad. Acá solo
// listamos las que Vera puede invocar autónomamente en un cycle pulse.
// Cuando el agent del org-server invoca una tool vía MCP, el dispatcher
// ya valida fase + consent. Acá solo confirmamos que es de la lista permitida
// y opcionalmente ejecutamos vía dispatchTool del control plane.
import { dispatchTool as _dispatchToolRegistry } from "./tool.dispatcher.js";

const AUTONOMOUS_TOOLS = new Set([
  // Lectura
  "getBrandDNA", "getBrandProfile", "getBrandContainers",
  "getBrandHealthMetrics", "getIntelligenceSignals", "searchIntelligence",
  "getProducts", "getCampaigns", "getAudiences",
  "getBodyMissions", "getPendingBriefs", "getPendingActions",
  "getMonitoringTargets", "getMonitoringTriggers", "getScraperStatus", "getScraperHealth",
  "getFlows", "getAvailableFlows", "getFlowRuns",
  "getBrainFeed",
  // "Que funciona" — rendimiento por tono/tema/plataforma (post_patterns).
  // Alimenta la Capa 6 (Aprendizaje): Vera consulta que performa antes de decidir.
  "getEstrategiaTones", "getEstrategiaTopics", "getEstrategiaPlatforms",
  // Escritura conceptual (consent=true pero cycle-pulse va en consentMode=auto)
  "updateBrandDNA", "updateBrandContainer",
  "updateProduct", "upsertProduct",
  "updateCampaignConcept",
  "updateAudienceConcept", "upsertAudience",
  // Inteligencia activa (sin consent)
  "addCompetitorToMonitoring",
  "addKeywordToTrends", "removeKeywordFromTrends",
  "triggerDeepScrape", "createDefensiveWatch",
  // Flows y notificaciones
  "triggerFlow", "triggerFlowRun", "pauseFlow", "inspectRun",
  "forgeProductionPrompt", "getFlowInputs", "getRunsAwaitingApproval",
  "createNotification", "createOrgNotification",
  "proposeStrategicRecommendation",
  "proposePendingAction",
]);

// Tools que MUTAN estado. En nivel "restringido" el ciclo NO las ejecuta
// (restringido = solo leer, analizar y proponer). parcial/total si las ejecutan.
const WRITE_TOOLS = new Set([
  "updateBrandDNA", "updateBrandContainer", "updateProduct", "upsertProduct",
  "updateCampaignConcept", "updateAudienceConcept", "upsertAudience",
  "addCompetitorToMonitoring", "addKeywordToTrends", "removeKeywordFromTrends",
  "triggerDeepScrape", "createDefensiveWatch",
  "triggerFlow", "triggerFlowRun", "pauseFlow",
]);

async function executeVeraActions(feedRow, brand, veraResponse) {
  const calls = veraResponse?.tool_calls || [];
  const taken = [];
  const errors = [];

  // La EJECUCION respeta el level_of_autonomy de la org (antes solo el prompt lo veia):
  // restringido = solo lectura + propuestas (sin escrituras). parcial/total = escrituras internas auto.
  const autonomyLevel = await _resolveAutonomy(brand.organization_id);
  const isRestricted = autonomyLevel === "restringido";
  const allowedSet = isRestricted
    ? new Set([...AUTONOMOUS_TOOLS].filter((t) => !WRITE_TOOLS.has(t)))
    : new Set(AUTONOMOUS_TOOLS);

  const secCtx = {
    organizationId: brand.organization_id,
    userId:         null,
    approvedIntents: new Set(),
    allowedTools:   [...allowedSet],
    consentMode:    isRestricted ? "block_all" : "auto",
    orgName:        brand.nombre_marca,
    conversationId: `cycle-pulse:${feedRow.id}`,
  };

  for (const call of calls) {
    if (!allowedSet.has(call.name)) {
      const blocked = isRestricted && WRITE_TOOLS.has(call.name);
      taken.push({ name: call.name, status: blocked ? "blocked_restringido" : "skipped_not_autonomous" });
      continue;
    }
    try {
      // Inyectar brandContainerId si la tool lo necesita y Vera no lo pasó
      const params = { ...(call.params || {}) };
      if (!params.brand_container_id && !params.brandContainerId) {
        params.brandContainerId = brand.id;
      }
      const result = await _dispatchToolRegistry(call.name, params, secCtx);
      taken.push({ name: call.name, status: "ok", result });
    } catch (e) {
      errors.push({ name: call.name, error: String(e.message).slice(0, 200) });
      taken.push({ name: call.name, status: "failed", error: e.message });
    }
  }

  await supabase
    .from("vera_brain_feeds")
    .update({
      status:         errors.length === calls.length && calls.length > 0 ? "failed" : "completed",
      vera_response:  { text: veraResponse?.text, tool_calls: calls.length },
      actions_taken:  taken,
      actions_count:  taken.filter(t => t.status === "ok").length,
      error_message:  errors.length ? JSON.stringify(errors).slice(0, 500) : null,
      completed_at:   new Date().toISOString(),
    })
    .eq("id", feedRow.id);

  return { taken, errors };
}

async function _toolCreateNotification(brand, p) {
  const { error, data } = await supabase.from("org_notifications").insert({
    organization_id:    brand.organization_id,
    brand_container_id: brand.id,
    severity:           p.severity || "info",
    type:               p.type || "vera_insight",
    title:              p.title || "Vera insight",
    body:               p.body || "",
    action_url:         p.action_url || p.action_link || null,
    action_label:       p.action_label || null,
    metadata:           { source: "vera_brain_feed", ...(p.metadata || {}) },
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { notification_id: data.id };
}

async function _toolProposeRecommendation(brand, p) {
  const { error, data } = await supabase.from("strategic_recommendations").insert({
    organization_id:    brand.organization_id,
    brand_container_id: brand.id,
    title:              p.title,
    description:        p.description,
    topic:              p.topic,
    tone:               p.tone,
    mood:               p.mood,
    confidence:         p.confidence || "media",
    rationale_commercial: p.rationale || p.rationale_commercial,
    status:             "proposed",
    vera_model:         "via_brain_feed",
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { recommendation_id: data.id };
}

async function _toolUpdateBrandDNA(brand, p) {
  if (!p.field || p.value === undefined) throw new Error("field y value requeridos");
  const allowed = new Set(["tono_de_voz", "palabras_clave", "palabras_prohibidas",
                            "mercado_objetivo", "descripcion", "metadata"]);
  if (!allowed.has(p.field)) throw new Error(`field "${p.field}" no permitido`);
  const { error } = await supabase
    .from("brand_containers")
    .update({ [p.field]: p.value, updated_at: new Date().toISOString() })
    .eq("id", brand.id);
  if (error) throw new Error(error.message);
  return { field: p.field, updated: true, reason: p.reason };
}

async function _toolUpdateProduct(brand, p) {
  if (!p.product_id || !p.fields) throw new Error("product_id y fields requeridos");
  const allowed = new Set(["nombre", "descripcion", "categoria", "atributos", "metadata"]);
  const update = {};
  for (const [k, v] of Object.entries(p.fields)) if (allowed.has(k)) update[k] = v;
  if (Object.keys(update).length === 0) throw new Error("ningún field permitido");
  update.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("products")
    .update(update)
    .eq("id", p.product_id)
    .eq("organization_id", brand.organization_id);
  if (error) throw new Error(error.message);
  return { product_id: p.product_id, fields_updated: Object.keys(update), reason: p.reason };
}

async function _toolUpdateCampaign(brand, p) {
  if (!p.campaign_id) throw new Error("campaign_id requerido");
  const allowed = new Set(["nombre", "objetivo", "descripcion", "tono", "metadata"]);
  const update = {};
  for (const [k, v] of Object.entries(p.fields || {})) if (allowed.has(k)) update[k] = v;
  if (Object.keys(update).length === 0) throw new Error("ningún field permitido");
  update.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("campaigns")
    .update(update)
    .eq("id", p.campaign_id)
    .eq("brand_container_id", brand.id);
  if (error) throw new Error(error.message);
  return { campaign_id: p.campaign_id, fields_updated: Object.keys(update), reason: p.reason };
}

async function _toolUpdateAudience(brand, p) {
  if (!p.audience_id) throw new Error("audience_id requerido");
  const allowed = new Set(["nombre", "descripcion", "intereses", "puntos_de_dolor", "deseos", "metadata"]);
  const update = {};
  for (const [k, v] of Object.entries(p.fields || {})) if (allowed.has(k)) update[k] = v;
  if (Object.keys(update).length === 0) throw new Error("ningún field permitido");
  update.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("audiences")
    .update(update)
    .eq("id", p.audience_id)
    .eq("brand_container_id", brand.id);
  if (error) throw new Error(error.message);
  return { audience_id: p.audience_id, fields_updated: Object.keys(update), reason: p.reason };
}

async function _toolTriggerFlow(brand, p) {
  if (!p.flow_id) throw new Error("flow_id requerido");
  // Inserta un flow_run en pending — el flow worker lo procesa async
  const { error, data } = await supabase.from("flow_runs").insert({
    organization_id: brand.organization_id,
    brand_id:        brand.id,
    flow_id:         p.flow_id,
    status:          "pending",
    tokens_consumed: 0,
    metadata:        { source: "vera_brain_feed", reason: p.reason, params: p.params || {} },
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { flow_run_id: data.id };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. ORQUESTADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Punto de entrada. Llamado por social-scraper al final de cada ciclo cuando
 * todos los sensores de un brand_container están "fresh".
 *
 * Idempotente: si ya se generó un feed para este (brand, cycle), no duplica.
 */
export async function deliverCycleFeed(brandContainerId, cycleId) {
  const windowEnd   = new Date();
  const windowStart = new Date(windowEnd.getTime() - FEED_WINDOW_HOURS * 3600 * 1000);

  // Idempotencia: si ya existe row para este cycle_id + brand, no re-procesar
  const { data: existing } = await supabase
    .from("vera_brain_feeds")
    .select("id, status")
    .eq("brand_container_id", brandContainerId)
    .eq("cycle_id", cycleId)
    .maybeSingle();
  if (existing) {
    return { skipped: true, reason: "already_processed", existing_id: existing.id, status: existing.status };
  }

  // 1. Compilar
  const { feed, brand } = await compileFeed(brandContainerId, windowStart, windowEnd);
  const payloadSize = Math.ceil(JSON.stringify(feed).length / 1024);

  // Skip si no hay nada relevante (evita gastar tokens en ciclos vacíos)
  const totalSignals = feed.counts.new_posts + feed.counts.signals + feed.counts.trend_signals;
  if (totalSignals === 0) {
    const { data: row } = await supabase.from("vera_brain_feeds").insert({
      cycle_id:           cycleId,
      brand_container_id: brandContainerId,
      organization_id:    brand.organization_id,
      window_start:       windowStart.toISOString(),
      window_end:         windowEnd.toISOString(),
      feed_payload:       feed,
      feed_size_kb:       payloadSize,
      status:             "skipped",
      error_message:      "empty_cycle_no_signals",
      completed_at:       new Date().toISOString(),
    }).select("id").single();
    return { skipped: true, reason: "empty_cycle", feed_id: row?.id };
  }

  // 2. Crear row
  const { data: feedRow, error: insertErr } = await supabase
    .from("vera_brain_feeds")
    .insert({
      cycle_id:           cycleId,
      brand_container_id: brandContainerId,
      organization_id:    brand.organization_id,
      window_start:       windowStart.toISOString(),
      window_end:         windowEnd.toISOString(),
      feed_payload:       feed,
      feed_size_kb:       payloadSize,
      status:             "pending",
    })
    .select("id")
    .single();
  if (insertErr) throw new Error(`brain_feed insert: ${insertErr.message}`);

  console.log(`vera-brain-feed: ${brand.nombre_marca} (${payloadSize}KB, ${totalSignals} signals) → Vera`);

  // 3. Entregar a Vera
  let veraResponse;
  try {
    veraResponse = await deliverToVera(feedRow, feed, brand);
  } catch (e) {
    console.warn(`vera-brain-feed: delivery falló — ${e.message}`);
    return { feed_id: feedRow.id, error: e.message };
  }

  // 4. Ejecutar acciones
  const { taken, errors } = await executeVeraActions(feedRow, brand, veraResponse);

  console.log(`vera-brain-feed: ${brand.nombre_marca} — ${taken.filter(t=>t.status==="ok").length} acciones ejecutadas, ${errors.length} fallidas`);

  return {
    feed_id: feedRow.id,
    actions_ok: taken.filter(t => t.status === "ok").length,
    actions_failed: errors.length,
    vera_text: veraResponse?.text?.slice(0, 200),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. UTILIDAD: detectar si todos los sensores de un brand están "fresh"
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Retorna true si todos los social/web triggers del brand corrieron en la
 * última ventana de FEED_WINDOW_HOURS. Usado por social-scraper para decidir
 * si ya es momento de despertar a Vera.
 */
export async function isCycleComplete(brandContainerId) {
  const since = new Date(Date.now() - FEED_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: triggers } = await supabase
    .from("monitoring_triggers")
    .select("id, sensor_type, last_run_at, status")
    .eq("brand_container_id", brandContainerId)
    .eq("status", "active")
    .in("sensor_type", ["social", "web", "trends_run", "meta_ad_library_sync"]);

  if (!triggers || triggers.length === 0) return false;

  // Todos deben tener last_run_at >= since
  return triggers.every(t => t.last_run_at && t.last_run_at >= since);
}
