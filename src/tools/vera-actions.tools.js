/**
 * vera-actions.tools.js — Tools MISSING criticas del catalogo v3 implementadas en Fase B.
 *
 * Cada tool valida org-scope antes de actuar y persiste `reason` en metadata para auditoria.
 * Convencion v3: las tools de escritura aceptan `reason: string` requerido.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

const SEVERITY_VALUES = new Set(["low", "medium", "high", "critical"]);
const SEVERITY_TTL_HOURS = { critical: 24, high: 48, medium: 72, low: 168 };

const CAMPAIGN_CONCEPTUAL_FIELDS = new Set([
  "nombre_campana", "descripcion_interna", "cta", "cta_url",
  "platform_objective", "starts_at", "ends_at", "persona_id",
  "brief_id", "status",
]);
const CAMPAIGN_BLOCKED_FIELDS = new Set([
  // Externos — nunca tocar desde VERA
  "external_campaign_id", "external_campaign_name", "external_adset_id",
  "external_account_id", "integration_id", "platform",
  // Cache de metricas — solo se actualizan via sync
  "cached_impressions", "cached_clicks", "cached_spend", "cached_conversions",
  "cached_roas", "cached_ctr", "metrics_cached_at", "last_synced_at",
  "real_demographics", "demographics_synced_at",
  // Budget — VERA nunca decide presupuestos
  "budget_daily", "budget_total", "budget_currency",
  // Identidad / FK
  "id", "organization_id", "brand_container_id", "created_by", "created_at",
]);

/**
 * pauseFlow(flowId, reason) — pausa todas las schedules activas de ese flow para la org.
 */
export async function pauseFlow(params, brandContainerId, organizationId, userId) {
  const { flow_id, flowId, reason } = params || {};
  const fid = flow_id || flowId;
  if (!fid) throw new Error("flow_id requerido");
  if (!reason) throw new Error("reason requerido para auditoria");

  const { data, error } = await supabase
    .from("flow_schedules")
    .update({
      status: "paused",
      metadata_config: {
        paused_by_vera: true,
        paused_at: new Date().toISOString(),
        paused_reason: reason,
        paused_by_user_id: userId || null,
      },
    })
    .eq("flow_id", fid)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .select("id");

  if (error) throw new Error(`pauseFlow: ${error.message}`);
  return {
    success: true,
    flow_id: fid,
    paused_schedules: (data || []).length,
    schedule_ids: (data || []).map((r) => r.id),
    message: `${(data || []).length} schedule(s) del flow ${fid} pausadas`,
  };
}

/**
 * updateCampaignConcept(campaignId, fields, reason) — solo conceptual interno.
 */
export async function updateCampaignConcept(params, brandContainerId, organizationId) {
  const { campaign_id, campaignId, fields, reason } = params || {};
  const cid = campaign_id || campaignId;
  if (!cid) throw new Error("campaign_id requerido");
  if (!fields || typeof fields !== "object") throw new Error("fields debe ser un objeto");
  if (!reason) throw new Error("reason requerido para auditoria");

  // Allowlist: solo campos conceptuales internos
  const update = {};
  const blocked = [];
  for (const [key, val] of Object.entries(fields)) {
    if (CAMPAIGN_BLOCKED_FIELDS.has(key)) { blocked.push(key); continue; }
    if (!CAMPAIGN_CONCEPTUAL_FIELDS.has(key)) { blocked.push(key); continue; }
    update[key] = val;
  }
  if (blocked.length) {
    throw new Error(`Campos no permitidos para VERA: ${blocked.join(", ")}. VERA solo toca campos conceptuales internos.`);
  }
  if (!Object.keys(update).length) throw new Error("Ningun campo permitido para actualizar");

  // Snapshot del valor previo para rollback
  const { data: prev } = await supabase
    .from("campaigns")
    .select(Object.keys(update).join(",") + ",metadata")
    .eq("id", cid)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!prev) throw new Error(`campaign ${cid} no pertenece a esta org`);

  const prevSnapshot = {};
  for (const k of Object.keys(update)) prevSnapshot[k] = prev[k];

  const newMetadata = {
    ...(prev.metadata || {}),
    vera_updates: [
      ...((prev.metadata || {}).vera_updates || []).slice(-9), // ultimos 10
      {
        at: new Date().toISOString(),
        fields_changed: Object.keys(update),
        prev_values: prevSnapshot,
        reason,
      },
    ],
  };

  const { error } = await supabase
    .from("campaigns")
    .update({ ...update, metadata: newMetadata })
    .eq("id", cid)
    .eq("organization_id", organizationId);

  if (error) throw new Error(`updateCampaignConcept: ${error.message}`);
  return {
    success: true,
    campaign_id: cid,
    updated_fields: Object.keys(update),
    prev_values: prevSnapshot,
    message: `Campana actualizada: ${Object.keys(update).join(", ")}`,
  };
}

/**
 * addKeywordToTrends(keyword, brandContainerId, geo?, reason) — push a brand_containers.palabras_clave.
 */
export async function addKeywordToTrends(params, brandContainerId, organizationId) {
  const { keyword, geo = null, reason, brand_container_id } = params || {};
  if (!keyword || typeof keyword !== "string") throw new Error("keyword requerido (string)");
  if (!reason) throw new Error("reason requerido para auditoria");
  const bcId = brand_container_id || brandContainerId;
  const bc = await resolveBrandContainer(bcId, organizationId);

  const { data: current } = await supabase
    .from("brand_containers")
    .select("palabras_clave")
    .eq("id", bc.id)
    .maybeSingle();
  const existing = current?.palabras_clave || [];
  const normalized = keyword.trim();
  if (existing.some((k) => String(k).toLowerCase() === normalized.toLowerCase())) {
    return {
      success: true,
      keyword: normalized,
      already_present: true,
      message: `Keyword "${normalized}" ya estaba en el watchlist`,
    };
  }

  const next = [...existing, normalized];
  const { error } = await supabase
    .from("brand_containers")
    .update({ palabras_clave: next, updated_at: new Date().toISOString() })
    .eq("id", bc.id)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`addKeywordToTrends: ${error.message}`);

  // Auditoria: registrar en defensive_watches como `vera_keyword_added` con TTL alto (90 dias)
  // para que el cycle pulse pueda recordar de donde vino.
  await supabase.from("defensive_watches").insert({
    organization_id: organizationId,
    brand_container_id: bc.id,
    topic: `keyword:${normalized}`,
    severity: "low",
    reason,
    metadata: { kind: "trend_keyword_add", geo },
    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  }).then(() => null).catch(() => null); // best-effort

  return {
    success: true,
    keyword: normalized,
    palabras_clave_count: next.length,
    geo,
    message: `Keyword "${normalized}" agregado al motor de trends`,
  };
}

/**
 * removeKeywordFromTrends(keyword, brandContainerId, reason) — remueve de palabras_clave.
 */
export async function removeKeywordFromTrends(params, brandContainerId, organizationId) {
  const { keyword, reason, brand_container_id } = params || {};
  if (!keyword || typeof keyword !== "string") throw new Error("keyword requerido");
  if (!reason) throw new Error("reason requerido para auditoria");
  const bcId = brand_container_id || brandContainerId;
  const bc = await resolveBrandContainer(bcId, organizationId);

  const { data: current } = await supabase
    .from("brand_containers")
    .select("palabras_clave")
    .eq("id", bc.id)
    .maybeSingle();
  const existing = current?.palabras_clave || [];
  const normalized = keyword.trim().toLowerCase();
  const next = existing.filter((k) => String(k).toLowerCase() !== normalized);
  if (next.length === existing.length) {
    return {
      success: true,
      keyword,
      not_found: true,
      message: `Keyword "${keyword}" no estaba en el watchlist`,
    };
  }

  const { error } = await supabase
    .from("brand_containers")
    .update({ palabras_clave: next, updated_at: new Date().toISOString() })
    .eq("id", bc.id)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`removeKeywordFromTrends: ${error.message}`);
  return {
    success: true,
    keyword,
    palabras_clave_count: next.length,
    message: `Keyword "${keyword}" removido del motor de trends. Reason: ${reason}`,
  };
}

/**
 * createDefensiveWatch(topic, severity, brandContainerId, reason) — INSERT en defensive_watches.
 *
 * NOTA: en Fase B esto NO intensifica cadence de monitoring_triggers automaticamente —
 * crea el watch como signal para el equipo. La intensificacion automatica queda como
 * deuda para Fase C / mas adelante.
 */
export async function createDefensiveWatch(params, brandContainerId, organizationId, userId) {
  const { topic, severity = "medium", reason, brand_container_id, metadata = {} } = params || {};
  if (!topic) throw new Error("topic requerido");
  if (!reason) throw new Error("reason requerido para auditoria");
  if (!SEVERITY_VALUES.has(severity)) {
    throw new Error(`severity debe ser uno de: ${[...SEVERITY_VALUES].join(", ")}`);
  }
  const bcId = brand_container_id || brandContainerId;
  const bc = bcId ? await resolveBrandContainer(bcId, organizationId) : null;

  const ttlHours = SEVERITY_TTL_HOURS[severity] || 72;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const { error, data } = await supabase
    .from("defensive_watches")
    .insert({
      organization_id: organizationId,
      brand_container_id: bc?.id || null,
      topic,
      severity,
      reason,
      metadata: { ...metadata, created_by_user_id: userId || null, ttl_hours: ttlHours },
      expires_at: expiresAt,
    })
    .select("id, created_at, expires_at")
    .single();
  if (error) throw new Error(`createDefensiveWatch: ${error.message}`);

  return {
    success: true,
    watch_id: data.id,
    topic,
    severity,
    expires_at: data.expires_at,
    check_interval_mins: severity === "critical" ? 15 : severity === "high" ? 30 : 60,
    message: `Defensive watch "${topic}" creado (severity=${severity}, expira en ${ttlHours}h)`,
  };
}

/**
 * triggerDeepScrape(target, type, brandContainerId, reason) — fuerza priority run.
 *
 * Modelo: encuentra el monitoring_trigger correspondiente (brand_container + entity + sensor_type)
 * y le baja next_run_at a now() + sube priority. El scheduler corre cada ~5min y lo agarra.
 *
 * target: string — entity_id (UUID) o handle/name de la entity. Si UUID, match directo.
 *                  Si no, busca en intelligence_entities por name/target_identifier.
 * type:   string — sensor_type ("social", "web", "meta_ad_library_sync", "trends_run", etc.).
 */
export async function triggerDeepScrape(params, brandContainerId, organizationId) {
  const { target, type, reason, brand_container_id, priority = 10 } = params || {};
  if (!target) throw new Error("target requerido (entity_id UUID o handle/name)");
  if (!type) throw new Error("type requerido (sensor_type)");
  if (!reason) throw new Error("reason requerido para auditoria");

  const bcId = brand_container_id || brandContainerId;
  const bc = await resolveBrandContainer(bcId, organizationId);

  // Resolver entity_id: UUID directo o lookup por handle/name
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let entityId = null;
  let entityName = target;
  if (UUID_RE.test(target)) {
    entityId = target;
  } else {
    // Buscar en intelligence_entities por name o target_identifier (handle)
    const norm = String(target).toLowerCase().replace(/^@/, "").trim();
    const { data: entities } = await supabase
      .from("intelligence_entities")
      .select("id, name, target_identifier")
      .eq("brand_container_id", bc.id)
      .or(`name.ilike.${norm},target_identifier.ilike.${norm}`)
      .limit(5);
    if (!entities?.length) {
      throw new Error(`No se encontro entity para target="${target}" en brand_container ${bc.id}`);
    }
    if (entities.length > 1) {
      throw new Error(`Multiples matches para target="${target}": ${entities.map(e => e.name).join(", ")}. Pasa entity_id UUID.`);
    }
    entityId = entities[0].id;
    entityName = entities[0].name;
  }

  // Buscar el trigger
  const { data: trigger } = await supabase
    .from("monitoring_triggers")
    .select("id, sensor_type, priority, next_run_at, status, config")
    .eq("brand_container_id", bc.id)
    .eq("entity_id", entityId)
    .eq("sensor_type", type)
    .maybeSingle();

  if (!trigger) {
    throw new Error(`No existe monitoring_trigger para entity=${entityName} sensor_type=${type}. ` +
                    `Crear el trigger con addIntelligenceEntity o updateMonitoringTrigger primero.`);
  }

  const now = new Date();
  const prevPriority = trigger.priority || 5;
  const newPriority = Math.max(prevPriority, priority);

  const newConfig = {
    ...(trigger.config || {}),
    vera_deep_scrape: {
      requested_at: now.toISOString(),
      requested_by_vera: true,
      reason,
      prev_priority: prevPriority,
    },
  };

  const { error } = await supabase
    .from("monitoring_triggers")
    .update({
      next_run_at: now.toISOString(),
      priority: newPriority,
      status: "active",
      config: newConfig,
    })
    .eq("id", trigger.id);

  if (error) throw new Error(`triggerDeepScrape: ${error.message}`);

  // ETA: el scheduler corre cada ~5min. Si ya estaba next_run_at en el pasado, sera el proximo tick.
  return {
    success: true,
    job_id: trigger.id,
    entity_id: entityId,
    entity_name: entityName,
    sensor_type: type,
    priority_bumped_from: prevPriority,
    priority_bumped_to: newPriority,
    status: "queued",
    eta_minutes: 5,
    message: `Deep scrape encolado para ${entityName} (${type}). ETA ~5min.`,
  };
}

/**
 * getMonitoringTriggers(brandContainerId?, organizationId) — lista triggers de monitoreo.
 */
export async function getMonitoringTriggers(brandContainerId, organizationId) {
  const bc = brandContainerId
    ? await resolveBrandContainer(brandContainerId, organizationId)
    : null;
  let query = supabase
    .from("monitoring_triggers")
    .select("id, brand_container_id, sensor_type, cadence, cadence_value, priority, status, " +
            "next_run_at, last_run_at, last_run_status, paused_reason, created_at")
    .eq("organization_id", organizationId)
    .order("priority", { ascending: false });
  if (bc) query = query.eq("brand_container_id", bc.id);
  const { data, error } = await query;
  if (error) throw new Error(`getMonitoringTriggers: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

/**
 * getBrandHealthMetrics(brandContainerId?, windowHours?) — salud de marca.
 *
 * Calcula sobre posts propios (is_competitor=false) en la ventana:
 *  - engagement_avg: promedio de engagement_total
 *  - sentiment_score: promedio de sentiment_score (-1..+1)
 *  - fatigue_curve: array [oldest..newest] con engagement promedio por cuarto de ventana
 *  - posting_rhythm: { posts, posts_per_day, gap_avg_hours }
 *
 * Si no hay posts en la ventana, retorna shape vacio con n=0 para que VERA pueda
 * razonar "no tengo datos" en lugar de tirar excepcion.
 *
 * windowHours default = 168 (7 dias). Acotado [24, 4380] para no abrir queries gigantes.
 */
export async function getBrandHealthMetrics(brandContainerId, organizationId, windowHours) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const w = Math.max(24, Math.min(Number(windowHours) || 168, 4380));
  const sinceIso = new Date(Date.now() - w * 3600 * 1000).toISOString();

  const { data, error } = await supabase
    .from("brand_posts")
    .select("captured_at, engagement_total, sentiment_score, followers_snapshot, network, is_competitor")
    .eq("brand_container_id", bc.id)
    .eq("is_competitor", false)
    .gte("captured_at", sinceIso)
    .order("captured_at", { ascending: true });

  if (error) throw new Error(`getBrandHealthMetrics: ${error.message}`);

  const rows = Array.isArray(data) ? data : [];
  const n = rows.length;

  if (n === 0) {
    return {
      brand_container_id: bc.id,
      brand_name: bc.nombre_marca,
      window_hours: w,
      n_posts: 0,
      engagement_avg: 0,
      sentiment_score: null,
      fatigue_curve: [],
      posting_rhythm: { posts: 0, posts_per_day: 0, gap_avg_hours: null },
      note: "No hay posts propios en la ventana solicitada",
    };
  }

  // engagement_avg + sentiment_score (ignora nulls en sentiment)
  let engSum = 0, sentSum = 0, sentN = 0;
  for (const r of rows) {
    engSum += Number(r.engagement_total) || 0;
    if (r.sentiment_score != null) { sentSum += Number(r.sentiment_score); sentN += 1; }
  }
  const engagement_avg = Math.round(engSum / n);
  const sentiment_score = sentN > 0 ? Number((sentSum / sentN).toFixed(3)) : null;

  // fatigue_curve: 4 buckets cronologicos, engagement promedio por bucket
  const buckets = [[], [], [], []];
  const startMs = new Date(rows[0].captured_at).getTime();
  const endMs   = new Date(rows[n - 1].captured_at).getTime();
  const span    = Math.max(1, endMs - startMs);
  for (const r of rows) {
    const offset = new Date(r.captured_at).getTime() - startMs;
    const idx = Math.min(3, Math.floor((offset / span) * 4));
    buckets[idx].push(Number(r.engagement_total) || 0);
  }
  const fatigue_curve = buckets.map((b, i) => ({
    bucket: i + 1, // 1=mas antiguo, 4=mas reciente
    n: b.length,
    engagement_avg: b.length ? Math.round(b.reduce((a, x) => a + x, 0) / b.length) : 0,
  }));

  // posting_rhythm: posts/dia + gap promedio entre posts
  const days = Math.max(1, w / 24);
  const posts_per_day = Number((n / days).toFixed(2));
  let gapSumHours = 0, gapN = 0;
  for (let i = 1; i < n; i++) {
    const dt = (new Date(rows[i].captured_at).getTime() - new Date(rows[i - 1].captured_at).getTime()) / 3600000;
    if (dt > 0) { gapSumHours += dt; gapN += 1; }
  }
  const gap_avg_hours = gapN > 0 ? Number((gapSumHours / gapN).toFixed(1)) : null;

  return {
    brand_container_id: bc.id,
    brand_name: bc.nombre_marca,
    window_hours: w,
    n_posts: n,
    engagement_avg,
    sentiment_score,
    fatigue_curve,
    posting_rhythm: { posts: n, posts_per_day, gap_avg_hours },
  };
}

/**
 * searchIntelligence(query, scope?, brandContainerId?) — busqueda semantica.
 *
 * scope:
 *  - "brand" (default): ai_brand_vectors filtrado por brand_container_id (cosine via match_ai_brand_vectors)
 *  - "global": ai_global_vectors (cosine via match_ai_global_vectors)
 *
 * Retorna top-K resultados rankeados. Si OpenAI falla, cae a un fallback ILIKE
 * sobre ai_brand_vectors.content para no dejar a VERA ciega.
 *
 * Limite duro: max_results clampado [1, 20]. Default 8.
 */
export async function searchIntelligence(params, brandContainerId, organizationId) {
  const query = (params?.query || "").toString().trim();
  if (!query) throw new Error("query requerido");
  const scope = params?.scope === "global" ? "global" : "brand";
  const matchCount = Math.max(1, Math.min(Number(params?.max_results) || 8, 20));

  const bc = scope === "brand"
    ? await resolveBrandContainer(brandContainerId, organizationId)
    : null;

  // 1. Embed query
  let embedding = null;
  let embedError = null;
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("OPENAI_API_KEY no configurada");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-large",
        input: query.slice(0, 8000),
        dimensions: 1536,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("respuesta sin embedding");
  } catch (e) {
    embedError = e.message;
  }

  // 2. Si tenemos embedding -> cosine search via RPC; si no -> fallback ILIKE
  if (embedding) {
    const rpcName = scope === "brand" ? "match_ai_brand_vectors" : "match_ai_global_vectors";
    const rpcArgs = scope === "brand"
      ? { query_embedding: embedding, brand_id: bc.id, match_count: matchCount }
      : { query_embedding: embedding, match_count: matchCount };
    const { data, error } = await supabase.rpc(rpcName, rpcArgs);
    if (error) {
      embedError = `RPC ${rpcName}: ${error.message}`;
    } else {
      return {
        scope,
        query,
        brand_container_id: bc?.id || null,
        method: "cosine",
        results: Array.isArray(data) ? data.map((r) => ({
          content: r.content,
          metadata: r.metadata || {},
          similarity: r.similarity ?? null,
        })) : [],
      };
    }
  }

  // 3. Fallback ILIKE — solo para scope=brand (ai_global_vectors es muy grande)
  if (scope === "brand") {
    const { data, error } = await supabase
      .from("ai_brand_vectors")
      .select("content, metadata")
      .eq("brand_container_id", bc.id)
      .ilike("content", `%${query.replace(/[%_]/g, " ")}%`)
      .limit(matchCount);
    if (error) throw new Error(`searchIntelligence fallback: ${error.message}`);
    return {
      scope,
      query,
      brand_container_id: bc.id,
      method: "ilike_fallback",
      embed_error: embedError,
      results: Array.isArray(data) ? data.map((r) => ({
        content: r.content,
        metadata: r.metadata || {},
        similarity: null,
      })) : [],
    };
  }

  throw new Error(`searchIntelligence: embedding fallo y scope=global no tiene fallback (${embedError})`);
}
