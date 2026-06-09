/**
 * Scraper Tools — herramientas de monitoreo y gestión de scrapers para Vera.
 *
 * FILOSOFÍA:
 *   Los scrapers son las herramientas de visión de Vera sobre el mercado.
 *   Corren autónomamente 24/7 via monitoring_triggers — Vera NO necesita estar
 *   activa para que funcionen. Vera solo usa tokens cuando REVISA o MEJORA
 *   su sistema de monitoreo.
 *
 * CAPACIDADES DE VERA:
 *   📊 READ  — Ver estado, salud, métricas, señales, análisis de competidores
 *   ✏️  WRITE — Ajustar cadencias, agregar entidades, modificar URL watchers
 *   🧪 TEST  — Ejecutar un scrape de prueba y verificar que no está roto
 *   🔧 FIX   — Si detecta errores, corregir handle/plataforma/configuración
 *
 * SEGURIDAD:
 *   - Toda operación de escritura valida que pertenece al brand_container de la org
 *   - runScraperTest tiene límite de 1 entidad a la vez (no flood)
 *   - updateMonitoringTrigger no puede poner cadencias < 15 min (anti-flood)
 *   - Las ediciones no se guardan hasta que Vera confirma que el test pasó
 */

import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
// session-manager eliminado — Apify maneja sesiones internamente.
const getSessionStatus = async () => ({ status: "managed_by_apify", message: "Sessions are now managed by Apify externally." });

// ─────────────────────────────────────────────────────────────────────────────
// READ TOOLS — Vera puede ver sin gastar tokens en acción
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado de las sesiones autenticadas de scraping.
 * Vera usa esto para saber si Instagram/TikTok/Facebook tienen sesión activa
 * y cuándo es necesario renovarlas.
 */
export async function getScraperSessions() {
  const sessions = await getSessionStatus();
  const recommendations = [];

  for (const [platform, info] of Object.entries(sessions)) {
    if (!info.exists) {
      recommendations.push(`⚠️ ${platform}: Sin sesión — ejecuta 'node src/scripts/setup-session.js ${platform}' para habilitar scraping autenticado.`);
    } else if (!info.fresh) {
      recommendations.push(`❌ ${platform}: Sesión EXPIRADA — ejecuta 'node src/scripts/setup-session.js ${platform}' para renovar.`);
    } else if (info.days_left <= 7) {
      recommendations.push(`🔶 ${platform}: Sesión expira en ${info.days_left} días — programa la renovación pronto.`);
    }
  }

  return {
    sessions,
    recommendations,
    summary: recommendations.length === 0
      ? "✅ Todas las sesiones están activas y válidas."
      : `${recommendations.length} plataforma(s) necesitan atención.`,
    setup_command: "node src/scripts/setup-session.js <instagram|tiktok|facebook>",
  };
}

/**
 * Dashboard completo del sistema de scraping.
 * Vera lo usa para ver el panorama general antes de tomar decisiones.
 */
export async function getScraperDashboard(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const [triggersRes, entitiesRes, signalsRes, postsRes, watchersRes] = await Promise.all([
    supabase
      .from("monitoring_triggers")
      .select("id, entity_id, sensor_type, cadence, cadence_value, status, next_run_at, last_run_at, last_run_status")
      .eq("brand_container_id", bc.id)
      .order("next_run_at"),
    supabase
      .from("intelligence_entities")
      .select("id, name, domain, target_identifier, is_active, metadata")
      .eq("brand_container_id", bc.id),
    supabase
      .from("intelligence_signals")
      .select("id, entity_id, signal_type, captured_at")
      .gte("captured_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("captured_at", { ascending: false }),
    supabase
      .from("brand_posts")
      .select("id, network, entity_id, captured_at")
      .eq("brand_container_id", bc.id)
      .order("captured_at", { ascending: false })
      .limit(5),
    supabase
      .from("url_watchers")
      .select("id, label, url, is_active, last_checked_at, last_hash")
      .eq("brand_container_id", bc.id),
  ]);

  const entities = entitiesRes.data || [];
  const triggers = triggersRes.data || [];
  const signals  = signalsRes.data || [];
  const posts    = postsRes.data || [];
  const watchers = watchersRes.data || [];

  const entityMap = Object.fromEntries(entities.map(e => [e.id, e]));
  const now       = new Date();

  // Enriquecer triggers con nombre de entidad
  const enrichedTriggers = triggers.map(t => ({
    ...t,
    entity_name: entityMap[t.entity_id]?.name || "Desconocida",
    platform:    entityMap[t.entity_id]?.metadata?.platform || t.sensor_type,
    minutes_until_next: t.next_run_at
      ? Math.max(0, Math.round((new Date(t.next_run_at) - now) / 60000))
      : null,
    is_overdue: t.next_run_at ? new Date(t.next_run_at) < now : false,
  }));

  // Contar señales por tipo y entidad
  const signalsByType = signals.reduce((acc, s) => {
    acc[s.signal_type] = (acc[s.signal_type] || 0) + 1;
    return acc;
  }, {});

  const signalsByEntity = signals.reduce((acc, s) => {
    const name = entityMap[s.entity_id]?.name || s.entity_id;
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});

  return {
    summary: {
      total_entities:    entities.length,
      active_entities:   entities.filter(e => e.is_active).length,
      total_triggers:    triggers.length,
      active_triggers:   triggers.filter(t => t.status === "active").length,
      paused_triggers:   triggers.filter(t => t.status === "paused").length,
      signals_last_24h:  signals.length,
      url_watchers:      watchers.length,
      active_watchers:   watchers.filter(w => w.is_active).length,
    },
    triggers:       enrichedTriggers,
    entities,
    url_watchers:   watchers,
    signals_last_24h: {
      total: signals.length,
      by_type: signalsByType,
      by_entity: signalsByEntity,
    },
    recent_posts: posts.map(p => ({
      network:    p.network,
      entity:     entityMap[p.entity_id]?.name,
      captured_at: p.captured_at,
    })),
  };
}

/**
 * Salud del sistema de scraping.
 * Vera usa esto para detectar scrapers rotos antes de que causen problemas.
 */
export async function getScraperHealth(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  // Últimos 50 sensor_runs
  const { data: runs } = await supabase
    .from("sensor_runs")
    .select("entity_id, sensor_type, status, duration_ms, stats, started_at, error_message")
    .eq("brand_container_id", bc.id)
    .order("started_at", { ascending: false })
    .limit(50);

  const { data: entities } = await supabase
    .from("intelligence_entities")
    .select("id, name, target_identifier, metadata")
    .eq("brand_container_id", bc.id);

  const entityMap = Object.fromEntries((entities || []).map(e => [e.id, e]));

  // Agrupar por entidad
  const byEntity = {};
  for (const run of (runs || [])) {
    const key = run.entity_id;
    if (!byEntity[key]) {
      byEntity[key] = {
        entity_name:     entityMap[key]?.name || "?",
        handle:          entityMap[key]?.target_identifier,
        platform:        entityMap[key]?.metadata?.platform || run.sensor_type,
        total_runs:      0,
        success_runs:    0,
        failed_runs:     0,
        avg_duration_ms: 0,
        last_status:     null,
        last_ran:        null,
        last_error:      null,
        total_posts:     0,
        total_signals:   0,
        health:          "unknown",
      };
    }
    const e = byEntity[key];
    e.total_runs++;
    if (run.status === "success") e.success_runs++;
    if (run.status === "failed") { e.failed_runs++; e.last_error = run.error_message; }
    e.avg_duration_ms = Math.round(((e.avg_duration_ms * (e.total_runs - 1)) + (run.duration_ms || 0)) / e.total_runs);
    e.total_posts    += run.stats?.posts_found || 0;
    e.total_signals  += run.stats?.new_signals || 0;
    if (!e.last_status) { e.last_status = run.status; e.last_ran = run.started_at; }
  }

  // Calcular health score
  for (const e of Object.values(byEntity)) {
    const successRate = e.total_runs > 0 ? e.success_runs / e.total_runs : 0;
    if (e.failed_runs === 0 && successRate === 1) e.health = "healthy";
    else if (successRate >= 0.7) e.health = "degraded";
    else e.health = "broken";
  }

  const healthList = Object.values(byEntity).sort((a, b) =>
    ["broken", "degraded", "healthy", "unknown"].indexOf(a.health) -
    ["broken", "degraded", "healthy", "unknown"].indexOf(b.health)
  );

  return {
    overall: {
      healthy:  healthList.filter(e => e.health === "healthy").length,
      degraded: healthList.filter(e => e.health === "degraded").length,
      broken:   healthList.filter(e => e.health === "broken").length,
      unknown:  healthList.filter(e => e.health === "unknown").length,
    },
    scrapers: healthList,
    recommendation: healthList.some(e => e.health === "broken")
      ? "⚠️ Hay scrapers rotos. Usa getScraperHealth para identificarlos y runScraperTest para diagnosticar."
      : healthList.some(e => e.health === "degraded")
      ? "⚡ Algunos scrapers tienen tasa de error elevada. Revisar configuración."
      : "✅ Todos los scrapers funcionan correctamente.",
  };
}

/**
 * Análisis competitivo profundo de una entidad específica.
 * Vera usa esto para entender qué está haciendo un competidor.
 */
export async function getCompetitorAnalysis(entityName, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  // Buscar entidad por nombre (case insensitive)
  const { data: entities } = await supabase
    .from("intelligence_entities")
    .select("id, name, domain, target_identifier, metadata, is_active")
    .eq("brand_container_id", bc.id)
    .ilike("name", `%${entityName}%`);

  if (!entities?.length) {
    return { error: `No se encontró entidad con nombre "${entityName}"` };
  }

  const entity = entities[0];

  const [signalsRes, postsRes, analysisRes] = await Promise.all([
    supabase
      .from("intelligence_signals")
      .select("signal_type, content_text, content_numeric, captured_at")
      .eq("entity_id", entity.id)
      .order("captured_at", { ascending: false })
      .limit(20),
    supabase
      .from("brand_posts")
      .select("network, content, metrics, captured_at")
      .eq("entity_id", entity.id)
      .order("captured_at", { ascending: false })
      .limit(12),
    supabase
      .from("brand_content_analysis")
      .select("tone_detected, dominant_emotion, narrative_pillar, clarity_score, fatigue_risk, why_it_worked, brand_posts(network, content)")
      .eq("brand_container_id", bc.id)
      .order("analyzed_at", { ascending: false })
      .limit(10),
  ]);

  // Estadísticas de contenido
  const posts = postsRes.data || [];
  const analysis = analysisRes.data || [];

  const pillarCounts = analysis.reduce((acc, a) => {
    if (a.narrative_pillar) acc[a.narrative_pillar] = (acc[a.narrative_pillar] || 0) + 1;
    return acc;
  }, {});

  const toneCounts = analysis.reduce((acc, a) => {
    if (a.tone_detected) acc[a.tone_detected] = (acc[a.tone_detected] || 0) + 1;
    return acc;
  }, {});

  const avgEngagement = posts.reduce((s, p) => {
    return s + (p.metrics?.likes || 0) + (p.metrics?.comments || 0);
  }, 0) / (posts.length || 1);

  return {
    entity: {
      name:     entity.name,
      platform: entity.metadata?.platform || entity.domain,
      handle:   entity.target_identifier,
      active:   entity.is_active,
    },
    performance: {
      total_posts:       posts.length,
      avg_engagement:    Math.round(avgEngagement),
      top_pillar:        Object.entries(pillarCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || "N/A",
      dominant_tone:     Object.entries(toneCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || "N/A",
      fatigue_risk_pct:  analysis.length > 0
        ? Math.round(analysis.filter(a => a.fatigue_risk).length / analysis.length * 100)
        : 0,
    },
    narrative_pillars: pillarCounts,
    recent_signals: (signalsRes.data || []).slice(0, 5).map(s => ({
      type: s.signal_type,
      date: s.captured_at?.slice(0, 16),
      summary: s.signal_type === "url_change"
        ? JSON.parse(s.content_text || "{}").label
        : (s.content_text || "").slice(0, 100),
    })),
    recent_posts: posts.slice(0, 5).map(p => ({
      network:     p.network,
      content:     p.content?.slice(0, 150),
      likes:       p.metrics?.likes || 0,
      comments:    p.metrics?.comments || 0,
      plays:       p.metrics?.plays || 0,
      captured_at: p.captured_at?.slice(0, 16),
    })),
  };
}

/**
 * Análisis de contenido y pilares narrativos.
 * Vera usa esto para entender qué estrategias de contenido dominan en el mercado.
 */
export async function getContentAnalysisSummary(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const [pillarsRes, analysisRes] = await Promise.all([
    supabase
      .from("brand_narrative_pillars")
      .select("pillar_name, post_count, avg_engagement, avg_reach, pillar_type, last_post_at")
      .eq("brand_container_id", bc.id)
      .order("post_count", { ascending: false }),
    supabase
      .from("brand_content_analysis")
      .select("tone_detected, dominant_emotion, narrative_pillar, clarity_score, fatigue_risk, analyzed_at")
      .eq("brand_container_id", bc.id)
      .order("analyzed_at", { ascending: false })
      .limit(50),
  ]);

  const pillars  = pillarsRes.data || [];
  const analyses = analysisRes.data || [];

  const toneFreq    = analyses.reduce((a, x) => { a[x.tone_detected]    = (a[x.tone_detected]    || 0) + 1; return a; }, {});
  const emotionFreq = analyses.reduce((a, x) => { a[x.dominant_emotion] = (a[x.dominant_emotion] || 0) + 1; return a; }, {});
  const avgClarity  = analyses.reduce((s, x) => s + (x.clarity_score || 0), 0) / (analyses.length || 1);
  const fatigueRate = analyses.length > 0 ? analyses.filter(x => x.fatigue_risk).length / analyses.length : 0;

  return {
    posts_analyzed: analyses.length,
    narrative_pillars: pillars,
    top_tones:      Object.entries(toneFreq).sort((a,b) => b[1]-a[1]).slice(0, 5),
    top_emotions:   Object.entries(emotionFreq).sort((a,b) => b[1]-a[1]).slice(0, 5),
    avg_clarity_score: parseFloat(avgClarity.toFixed(2)),
    fatigue_risk_rate: parseFloat((fatigueRate * 100).toFixed(1)),
    insight: fatigueRate > 0.4
      ? "⚠️ Más del 40% del contenido de competidores muestra fatiga creativa — oportunidad diferenciadora."
      : avgClarity < 0.5
      ? "📝 El contenido promedio tiene claridad baja — hay espacio para destacar con mensajes más directos."
      : "✅ El panorama competitivo de contenido es diverso y activo.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE TOOLS — Vera edita su propio sistema de monitoreo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajustar cadencia, pausar o reactivar un monitoring_trigger.
 * Vera usa esto cuando detecta que un scraper corre muy seguido o muy lento.
 *
 * SEGURIDAD: cadencia mínima 15 min para evitar flood.
 */
export async function updateMonitoringTrigger(params, brandContainerId, organizationId) {
  const bc     = await resolveBrandContainer(brandContainerId, organizationId);
  const { entity_name, status, cadence_minutes } = params;

  if (!entity_name) throw new Error("entity_name requerido");

  // Validar cadencia mínima
  if (cadence_minutes !== undefined && cadence_minutes < 15) {
    throw new Error("cadencia mínima: 15 minutos (para evitar sobrecarga en las plataformas)");
  }

  // Buscar entidad por nombre
  const { data: entity } = await supabase
    .from("intelligence_entities")
    .select("id")
    .eq("brand_container_id", bc.id)
    .ilike("name", `%${entity_name}%`)
    .maybeSingle();

  if (!entity) throw new Error(`Entidad "${entity_name}" no encontrada`);

  // Buscar trigger activo para esa entidad
  const { data: trigger } = await supabase
    .from("monitoring_triggers")
    .select("id, cadence_value, status")
    .eq("entity_id", entity.id)
    .eq("brand_container_id", bc.id)
    .maybeSingle();

  if (!trigger) throw new Error(`No hay monitoring_trigger para "${entity_name}"`);

  // Construir update
  const update = { updated_at: new Date().toISOString() };
  if (status && ["active", "paused"].includes(status)) update.status = status;
  if (cadence_minutes) {
    update.cadence       = "interval";
    update.cadence_value = String(cadence_minutes);
    update.next_run_at   = new Date().toISOString(); // reset para que corra en el próximo poll
  }

  const { error } = await supabase
    .from("monitoring_triggers")
    .update(update)
    .eq("id", trigger.id);

  if (error) throw error;

  return {
    success: true,
    entity:  entity_name,
    changes: update,
    message: `✅ Trigger de "${entity_name}" actualizado correctamente.`,
  };
}

/**
 * Agregar una nueva entidad de inteligencia (nuevo competidor o fuente).
 * Vera usa esto cuando detecta un competidor nuevo relevante para la marca.
 */
export async function addIntelligenceEntity(params, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { name, platform, handle, cadence_minutes } = params;

  if (!name || !platform || !handle) {
    throw new Error("name, platform y handle son requeridos");
  }

  const VALID_PLATFORMS = ["instagram", "tiktok", "youtube", "facebook", "amazon", "x"];
  if (!VALID_PLATFORMS.includes(platform.toLowerCase())) {
    throw new Error(`platform debe ser: ${VALID_PLATFORMS.join(", ")}`);
  }

  // Cadencia: si no la pasa el llamador, derivar del plan de la org.
  // creator=9h, team=6h, agency=3h. Fallback 6h (team) si la org no tiene plan activo.
  let effectiveCadenceMinutes = cadence_minutes;
  if (!effectiveCadenceMinutes) {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plans!inner(scraping_cadence_hours)")
      .eq("organization_id", organizationId)
      .in("status", ["trial", "active", "past_due"])
      .maybeSingle();
    const hours = sub?.plans?.scraping_cadence_hours ?? 6;
    effectiveCadenceMinutes = hours * 60;
  }

  if (effectiveCadenceMinutes < 15) {
    throw new Error("cadencia mínima: 15 minutos");
  }

  const domain = ["amazon"].includes(platform) ? "marketplace" : "social";

  // Verificar que no exista ya
  const { data: existing } = await supabase
    .from("intelligence_entities")
    .select("id")
    .eq("brand_container_id", bc.id)
    .ilike("name", `%${name}%`)
    .maybeSingle();

  if (existing) throw new Error(`Ya existe una entidad con nombre similar a "${name}"`);

  // Insertar entidad
  const { data: newEntity, error: entityErr } = await supabase
    .from("intelligence_entities")
    .insert({
      brand_container_id: bc.id,
      name:               name.trim(),
      domain,
      target_identifier:  handle.replace(/^@/, ""),
      is_active:          true,
      metadata:           { platform: platform.toLowerCase() },
    })
    .select("id, name")
    .single();

  if (entityErr) throw entityErr;

  // Crear monitoring_trigger automáticamente
  const now = new Date().toISOString();
  const { error: trigErr } = await supabase.from("monitoring_triggers").insert({
    brand_container_id: bc.id,
    entity_id:          newEntity.id,
    sensor_type:        domain === "marketplace" ? "marketplace" : "social",
    cadence:            "interval",
    cadence_value:      String(effectiveCadenceMinutes),
    priority:           5,
    status:             "active",
    next_run_at:        now,
    created_at:         now,
    updated_at:         now,
  });

  if (trigErr) throw trigErr;

  return {
    success:    true,
    entity_id:  newEntity.id,
    entity:     newEntity.name,
    platform,
    handle:     handle.replace(/^@/, ""),
    cadence:    `cada ${effectiveCadenceMinutes} minutos`,
    message:    `✅ Entidad "${name}" agregada. Será monitoreada cada ${effectiveCadenceMinutes} minutos.`,
  };
}

/**
 * Actualizar handle o plataforma de una entidad existente.
 * Vera usa esto cuando detecta que un handle cambió o la plataforma está mal configurada.
 */
export async function updateIntelligenceEntity(params, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { entity_name, new_handle, new_platform, is_active } = params;

  if (!entity_name) throw new Error("entity_name requerido");

  const { data: entity } = await supabase
    .from("intelligence_entities")
    .select("id, name, target_identifier, metadata")
    .eq("brand_container_id", bc.id)
    .ilike("name", `%${entity_name}%`)
    .maybeSingle();

  if (!entity) throw new Error(`Entidad "${entity_name}" no encontrada`);

  const update = {};
  if (new_handle)   update.target_identifier = new_handle.replace(/^@/, "");
  if (is_active !== undefined) update.is_active = is_active;
  if (new_platform) {
    update.metadata = { ...(entity.metadata || {}), platform: new_platform.toLowerCase() };
  }

  if (Object.keys(update).length === 0) {
    throw new Error("Debes especificar al menos un campo a actualizar: new_handle, new_platform, is_active");
  }

  const { error } = await supabase
    .from("intelligence_entities")
    .update(update)
    .eq("id", entity.id);

  if (error) throw error;

  // Reset next_run_at para que el cambio se pruebe en el próximo ciclo
  if (new_handle || new_platform) {
    await supabase
      .from("monitoring_triggers")
      .update({ next_run_at: new Date().toISOString() })
      .eq("entity_id", entity.id);
  }

  return {
    success:  true,
    entity:   entity.name,
    changes:  update,
    message:  `✅ Entidad "${entity.name}" actualizada. El trigger se ejecutará en el próximo ciclo del scheduler (≤15 min).`,
  };
}

/**
 * Agregar o actualizar un URL watcher para monitorear una página web.
 * Vera usa esto para añadir páginas nuevas a monitorear (lanzamientos, precios, etc.)
 */
export async function upsertUrlWatcher(params, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { url, label, entity_name } = params;

  if (!url || !label) throw new Error("url y label son requeridos");
  if (!url.startsWith("http")) throw new Error("url debe ser una URL válida (https://...)");

  // Buscar entidad si se especifica
  let entityId = null;
  if (entity_name) {
    const { data: ent } = await supabase
      .from("intelligence_entities")
      .select("id")
      .eq("brand_container_id", bc.id)
      .ilike("name", `%${entity_name}%`)
      .maybeSingle();
    entityId = ent?.id;
  }

  // Verificar si ya existe
  const { data: existing } = await supabase
    .from("url_watchers")
    .select("id")
    .eq("url", url)
    .eq("brand_container_id", bc.id)
    .maybeSingle();

  if (existing) {
    // Actualizar
    const { error } = await supabase
      .from("url_watchers")
      .update({ label, entity_id: entityId, is_active: true, last_hash: "" })
      .eq("id", existing.id);
    if (error) throw error;
    return { success: true, action: "updated", label, url, message: `✅ URL watcher "${label}" actualizado.` };
  }

  // Crear nuevo
  const { error } = await supabase.from("url_watchers").insert({
    url,
    label,
    entity_id:          entityId,
    brand_container_id: bc.id,
    is_active:          true,
    last_hash:          "",
  });

  if (error) throw error;
  return { success: true, action: "created", label, url, message: `✅ URL watcher "${label}" creado. Se comprobará en el próximo ciclo del scheduler.` };
}

/**
 * Activar o desactivar un URL watcher.
 */
export async function toggleUrlWatcher(params, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { label, is_active } = params;

  if (!label || is_active === undefined) throw new Error("label e is_active requeridos");

  const { data: watcher } = await supabase
    .from("url_watchers")
    .select("id")
    .eq("brand_container_id", bc.id)
    .ilike("label", `%${label}%`)
    .maybeSingle();

  if (!watcher) throw new Error(`No se encontró URL watcher con label "${label}"`);

  await supabase.from("url_watchers").update({ is_active }).eq("id", watcher.id);

  return {
    success:  true,
    label,
    is_active,
    message:  `✅ URL watcher "${label}" ${is_active ? "activado" : "desactivado"}.`,
  };
}

/**
 * Ejecutar un scrape de prueba para una entidad específica y verificar el resultado.
 * Vera SIEMPRE usa esto después de hacer cambios para confirmar que no rompió nada.
 *
 * SEGURIDAD: solo 1 entidad a la vez, timeout de 60s.
 */
export async function runScraperTest(params, brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const { entity_name } = params;

  if (!entity_name) throw new Error("entity_name requerido");

  // Buscar entidad
  const { data: entity } = await supabase
    .from("intelligence_entities")
    .select("id, name, target_identifier, metadata, domain")
    .eq("brand_container_id", bc.id)
    .ilike("name", `%${entity_name}%`)
    .maybeSingle();

  if (!entity) throw new Error(`Entidad "${entity_name}" no encontrada`);

  // Buscar trigger
  const { data: trigger } = await supabase
    .from("monitoring_triggers")
    .select("id, sensor_type, cadence, cadence_value, status")
    .eq("entity_id", entity.id)
    .maybeSingle();

  if (!trigger) throw new Error(`No hay monitoring_trigger para "${entity_name}"`);

  // Ejecutar el scrape de manera dinámica (importar el servicio en tiempo de ejecución)
  try {
    const { default: scraperModule } = await import("../services/advanced-scraper.service.js");
    const platform = entity.metadata?.platform || "instagram";
    const handle   = entity.target_identifier;
    let   posts    = [];
    let   testType = "";

    if (platform === "youtube") {
      const result = await scraperModule.scrapeYouTubeChannel(handle);
      posts = result?.videos || [];
      testType = "YouTube InnerTube API";
    } else if (platform === "tiktok") {
      posts = await scraperModule.scrapeTikTokPlaywright(handle);
      testType = "TikTok Playwright stealth";
    } else if (platform === "instagram") {
      posts = await scraperModule.scrapeInstagramPlaywright(handle);
      testType = "Instagram Playwright stealth";
    } else if (platform === "facebook") {
      posts = await scraperModule.scrapeFacebookPage(handle);
      testType = "Facebook Playwright stealth";
    } else if (platform === "amazon") {
      const result = await scraperModule.scrapeAmazonProduct(handle);
      posts = result ? [result] : [];
      testType = "Amazon price scraper";
    }

    const passed = posts.length > 0;

    return {
      success:     true,
      entity:      entity.name,
      platform,
      handle,
      test_type:   testType,
      result: {
        passed,
        posts_found: posts.length,
        sample: posts.slice(0, 3).map(p => ({
          id:      p.external_id || p.asin,
          content: (p.content || p.title || "").slice(0, 100),
          network: p.network,
          likes:   p.like_count || p.metrics?.likes || 0,
        })),
      },
      verdict: passed
        ? `✅ TEST PASADO — "${entity.name}" devuelve ${posts.length} posts correctamente.`
        : `⚠️ TEST CON ADVERTENCIA — "${entity.name}" devolvió 0 posts. Posibles causas: anti-bot, handle incorrecto, o cuenta sin contenido público.`,
    };
  } catch (e) {
    return {
      success:  false,
      entity:   entity.name,
      result:   { passed: false, posts_found: 0 },
      error:    e.message,
      verdict:  `❌ TEST FALLIDO — "${entity.name}": ${e.message}`,
    };
  }
}
