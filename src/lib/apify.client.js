/**
 * apify.client.js — Wrapper único para todos los scrapes vía Apify.
 *
 * Responsabilidades:
 *   1. Auto-detección de plataforma desde URL/handle (lookup scraper_actors)
 *   2. Normalización de handle según el normalizer del actor
 *   3. Pre-flight: validar plan + créditos + cap diario + cache hit
 *   4. Ejecución de Apify run (POST /v2/acts/{actor}/runs + poll)
 *   5. Lectura del usageTotalUsd real al finalizar
 *   6. Cobro exacto en organization_credits (1 crédito = $1 USD por defecto, vive en USD_PER_CREDIT)
 *   7. Registro en credit_usage ledger
 *   8. Devuelve items normalizados al caller
 *
 * Variables de entorno:
 *   APIFY_API_TOKEN         — token de Apify (requerido)
 *   APIFY_RUN_TIMEOUT_SEC   — timeout por run (default 180)
 *   USD_PER_CREDIT          — conversión (default 1.0 = 1 crédito = $1 USD)
 */
import { supabase } from "./supabase.js";

const APIFY_BASE     = "https://api.apify.com/v2";
const TOKEN          = process.env.APIFY_API_TOKEN;
const TIMEOUT_S      = parseInt(process.env.APIFY_RUN_TIMEOUT_SEC       || "180", 10);
const TIMEOUT_BATCH_S = parseInt(process.env.APIFY_BATCH_TIMEOUT_SEC    || "420", 10);
// 1 crédito = $1 USD de gasto Apify (cambio 2026-05-21). Antes era 0.10.
const USD_PER_CR     = parseFloat(process.env.USD_PER_CREDIT            || "1.0");

if (!TOKEN) console.warn("apify.client: falta APIFY_API_TOKEN en env");

// ── 1. Detección de plataforma ──────────────────────────────────────────────
export async function detectPlatform(urlOrHandle) {
  const { data: actors, error } = await supabase
    .from("scraper_actors")
    .select("platform, url_patterns, handle_regex")
    .eq("is_active", true);
  if (error) throw new Error(`scraper_actors lookup: ${error.message}`);

  // Patrones catch-all (^https?://.+) van AL FINAL — sino matchean URLs sociales
  // antes que los actors específicos (instagram, x, tiktok, etc.).
  const CATCH_ALL = new Set(["website", "ecommerce"]);
  const sorted = [
    ...actors.filter(a => !CATCH_ALL.has(a.platform)),
    ...actors.filter(a => CATCH_ALL.has(a.platform)),
  ];

  for (const a of sorted) {
    for (const pat of a.url_patterns || []) {
      try {
        if (new RegExp(pat, "i").test(urlOrHandle)) return a.platform;
      } catch { /* invalid regex, skip */ }
    }
  }
  return null;
}

// ── 2. Normalización de handle ──────────────────────────────────────────────
export function normalizeHandle(raw, normalizer, urlPatterns = []) {
  if (!raw) return null;
  switch (normalizer) {
    case "strip_at":
      // Si es URL, extraer path; sino quitar @
      if (/^https?:\/\//i.test(raw)) {
        for (const pat of urlPatterns) {
          const m = raw.match(new RegExp(pat, "i"));
          if (m && m[1]) return m[1].replace(/^@/, "");
        }
        try { return new URL(raw).pathname.replace(/^\/+|\/+$/g, "").split("/")[0].replace(/^@/, ""); }
        catch { return raw; }
      }
      return raw.replace(/^@/, "").trim();
    case "extract_url_path":
      try {
        const u = new URL(raw);
        return u.pathname.replace(/^\/+|\/+$/g, "").replace(/^@/, "");
      } catch { return raw.replace(/^@/, ""); }
    case "full_url":
      return raw.startsWith("http") ? raw : `https://${raw}`;
    case "asin":
      const m = raw.match(/[A-Z0-9]{10}/);
      return m ? m[0] : raw;
    default:
      return raw;
  }
}

// ── 3. Lookup actor + plan + presupuesto ────────────────────────────────────
async function getActor(platform) {
  const { data, error } = await supabase
    .from("scraper_actors").select("*").eq("platform", platform).single();
  if (error) throw new Error(`actor ${platform}: ${error.message}`);
  return data;
}

async function getOrgPlan(organizationId) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan_id, status, plans!inner(id, name, max_handles, scraping_cadence_hours, scraping_daily_cap, cache_ttl_hours, apify_credit_markup)")
    .eq("organization_id", organizationId)
    .in("status", ["trial", "active", "past_due"])
    .maybeSingle();
  return sub?.plans || null;
}

async function getOrgCredits(organizationId) {
  const { data } = await supabase
    .from("organization_credits")
    .select("credits_available")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data?.credits_available ?? 0;
}

async function getDailySpend(organizationId) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await supabase
    .from("credit_usage")
    .select("credits_delta")
    .eq("organization_id", organizationId)
    .eq("kind", "apify_scrape")
    .gte("created_at", since);
  return (data || []).reduce((s, r) => s + Math.abs(Number(r.credits_delta) || 0), 0);
}

// ── 4. Cache TTL — comparte scrapes entre orgs ──────────────────────────────
async function findCacheHit(platform, handle, ttlHours) {
  if (!ttlHours) return null;
  const since = new Date(Date.now() - ttlHours * 3_600_000).toISOString();
  const { data } = await supabase
    .from("credit_usage")
    .select("source_id, metadata, created_at")
    .eq("kind", "apify_scrape")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  for (const row of data || []) {
    if (row.metadata?.platform === platform && row.metadata?.handle === handle) {
      return row.source_id; // run_id reutilizable
    }
  }
  return null;
}

// ── 5. Apify run + poll ─────────────────────────────────────────────────────
async function startRun(actorId, input) {
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${TOKEN}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`apify start failed (${r.status}): ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.data;
}

async function pollRun(runId, timeoutS = TIMEOUT_S) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutS) {
    const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`);
    const j = await r.json();
    const d = j.data;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(d.status)) return d;
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`apify run ${runId} timeout after ${timeoutS}s`);
}

async function fetchDatasetItems(datasetId, limit = 100) {
  const r = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&limit=${limit}&format=json`);
  if (!r.ok) throw new Error(`dataset fetch failed (${r.status})`);
  return r.json();
}

// ── 6. Cobro atómico + ledger ───────────────────────────────────────────────
async function chargeOrg({ organizationId, usdCost, runId, platform, handle, actorId, itemsCount, cacheHit = false, markup = 2.0 }) {
  const credits = +(usdCost * markup).toFixed(4);

  // Update atómico organization_credits con guard
  const { data: cur } = await supabase
    .from("organization_credits")
    .select("credits_available")
    .eq("organization_id", organizationId)
    .single();
  const newBal = (cur?.credits_available ?? 0) - credits;

  const { error: updErr } = await supabase
    .from("organization_credits")
    .update({ credits_available: newBal, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .gte("credits_available", credits);
  if (updErr) console.warn(`apify.client: charge update warn — ${updErr.message}`);

  // Ledger entry
  await supabase.from("credit_usage").insert({
    organization_id: organizationId,
    kind: "apify_scrape",
    credits_delta: -credits,
    usd_cost: usdCost,
    source_table: "apify_runs",
    source_id: runId,
    metadata: { platform, handle, actor_id: actorId, items_count: itemsCount, cache_hit: cacheHit, balance_after: newBal },
  });

  return { credits, balance_after: newBal };
}


// ── Audit log: apify_runs (registra cada run para detectar orphans) ──────────
async function _auditRunStart({ runId, organizationId, brandContainerId, platform, handle, actorId }) {
  try {
    await supabase.from("apify_runs").insert({
      run_id: runId, organization_id: organizationId, brand_container_id: brandContainerId,
      platform, handle, apify_actor_id: actorId, status: "RUNNING",
    });
  } catch (e) {
    console.warn(`apify_runs audit start: ${e.message}`);
  }
}

async function _auditRunFinish({ runId, status, usageUsd, itemsCount, chargedCredits, error }) {
  try {
    await supabase.from("apify_runs").update({
      status, finished_at: new Date().toISOString(),
      usage_usd: usageUsd, items_count: itemsCount, charged_credits: chargedCredits,
      error: error ? String(error).slice(0, 500) : null,
    }).eq("run_id", runId);
  } catch (e) {
    console.warn(`apify_runs audit finish: ${e.message}`);
  }
}

// ── 7. API pública: runActor ────────────────────────────────────────────────
/**
 * Ejecuta un scraper Apify para un handle, cobra exacto a la organización.
 *
 * @param {object} opts
 * @param {string} opts.organizationId — UUID de la org
 * @param {string} opts.urlOrHandle    — URL completa o handle (auto-detecta plataforma)
 * @param {string} [opts.platform]     — opcional, si ya conoces la plataforma
 * @param {number} [opts.cap]          — override de resultsPerRun (default: actor.default_results_per_run)
 * @returns {Promise<{items, runId, usdCost, credits, balanceAfter, cacheHit, platform, handle}>}
 */
export async function runActor({ organizationId, urlOrHandle, platform, cap }) {
  // 1. Detectar plataforma
  const plat = platform || await detectPlatform(urlOrHandle);
  if (!plat) throw new Error(`apify.client: plataforma no detectada para "${urlOrHandle}"`);

  const actor = await getActor(plat);
  if (!actor.is_active) throw new Error(`actor ${plat} desactivado`);

  // 2. Normalizar handle
  const handle = normalizeHandle(urlOrHandle, actor.handle_normalizer, actor.url_patterns);
  if (!handle) throw new Error(`apify.client: handle vacío tras normalizar`);
  if (!new RegExp(actor.handle_regex).test(handle)) {
    throw new Error(`apify.client: handle "${handle}" no matchea regex ${actor.handle_regex}`);
  }

  // 3. Plan + presupuesto pre-flight
  const plan = await getOrgPlan(organizationId);
  if (!plan) throw new Error(`apify.client: org ${organizationId} sin plan activo`);
  if (actor.min_plan_id) { /* TODO check plan tier */ }

  const balance     = await getOrgCredits(organizationId);
  const dailySpent  = await getDailySpend(organizationId);
  const dailyRemain = plan.scraping_daily_cap - dailySpent;
  const markup      = Number(plan.apify_credit_markup) || 2.0;
  const effectiveCap = Math.min(cap || actor.default_results_per_run, actor.default_results_per_run);

  // Estimación max (cap × cost_per_result + actor_start)
  const estimateUsd = (actor.cost_per_result_usd || 0) * effectiveCap + (actor.actor_start_cost_usd || 0);
  const estimateCredits = +(estimateUsd * markup).toFixed(4);

  if (balance < estimateCredits)  { const err = new Error(`créditos insuficientes (${balance} < ${estimateCredits})`); err.code = "INSUFFICIENT_CREDITS"; throw err; }
  if (dailyRemain < estimateCredits) { const err = new Error(`cap diario alcanzado (${dailySpent}/${plan.scraping_daily_cap})`); err.code = "DAILY_CAP_REACHED"; throw err; }

  // 4. Cache hit?
  const cachedRunId = await findCacheHit(plat, handle, plan.cache_ttl_hours);
  if (cachedRunId) {
    // Sin cobro adicional — pero registramos lectura para auditoría (delta 0)
    await supabase.from("credit_usage").insert({
      organization_id: organizationId, kind: "apify_scrape",
      credits_delta: 0, usd_cost: 0,
      source_table: "apify_runs", source_id: cachedRunId,
      metadata: { platform: plat, handle, cache_hit: true, served_from: "ttl_cache" },
    });
    // Reutilizar items del run cacheado
    const cachedRun = await fetch(`${APIFY_BASE}/actor-runs/${cachedRunId}?token=${TOKEN}`).then(r => r.json());
    const items = cachedRun?.data?.defaultDatasetId
      ? await fetchDatasetItems(cachedRun.data.defaultDatasetId)
      : [];
    return { items, runId: cachedRunId, usdCost: 0, credits: 0, balanceAfter: balance, cacheHit: true, platform: plat, handle };
  }

  // 5. Construir input desde template
  const tplStr = JSON.stringify(actor.input_template).replace(/\{\{handle\}\}/g, handle);
  const input  = JSON.parse(tplStr);

  // 6. Run + poll (con audit)
  const startRes = await startRun(actor.apify_actor_id, input);
  const runId    = startRes.id;
  await _auditRunStart({
    runId, organizationId, brandContainerId: null,
    platform: plat, handle, actorId: actor.apify_actor_id,
  });

  let finalRun;
  try {
    finalRun = await pollRun(runId);
  } catch (pollErr) {
    // Local timeout — el run puede seguir corriendo en Apify (orphan)
    await _auditRunFinish({ runId, status: "TIMED-OUT", error: pollErr.message });
    throw pollErr;
  }

  if (finalRun.status !== "SUCCEEDED") {
    await _auditRunFinish({
      runId, status: finalRun.status, usageUsd: parseFloat(finalRun.usageTotalUsd || 0),
      error: finalRun.statusMessage,
    });
    throw new Error(`apify run ${runId} ended ${finalRun.status}: ${finalRun.statusMessage || ""}`);
  }

  // 7. Items + cobro real
  const items   = await fetchDatasetItems(finalRun.defaultDatasetId);
  const usdReal = parseFloat(finalRun.usageTotalUsd || 0);
  const charge  = await chargeOrg({
    organizationId, usdCost: usdReal, runId, platform: plat, handle,
    actorId: actor.apify_actor_id, itemsCount: items.length, cacheHit: false, markup,
  });
  await _auditRunFinish({
    runId, status: "CHARGED", usageUsd: usdReal,
    itemsCount: items.length, chargedCredits: charge.credits,
  });

  return {
    items, runId, usdCost: usdReal,
    credits: charge.credits, balanceAfter: charge.balance_after,
    cacheHit: false, platform: plat, handle,
  };
}

// ── 8. API pública: runActorBatch ───────────────────────────────────────────
/**
 * Versión batch: ejecuta UN solo run de Apify con N handles de la misma plataforma.
 * Cada actor distribuye internamente: IG y TikTok dan capPerHandle por perfil;
 * FB/YT/X dan capPerHandle × N total. El cobro queda en una sola entrada del ledger
 * pero el caller recibe items agrupados por handle para persistir per-entity.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.platform        — instagram|tiktok|youtube|facebook|x
 * @param {string[]} opts.handles       — array de handles ya normalizados
 * @param {number} [opts.capPerHandle]  — default actor.default_results_per_run
 * @returns {Promise<{itemsByHandle, runId, usdCost, credits, balanceAfter, totalItems}>}
 */
export async function runActorBatch({ organizationId, platform, handles, capPerHandle }) {
  if (!platform) throw new Error("apify.client.runActorBatch: platform requerido");
  if (!Array.isArray(handles) || handles.length === 0) {
    throw new Error("apify.client.runActorBatch: handles vacío");
  }

  const actor = await getActor(platform);
  if (!actor.is_active) throw new Error(`actor ${platform} desactivado`);

  // Normalizar todos los handles + validar contra regex
  const normalized = [];
  for (const raw of handles) {
    const h = normalizeHandle(raw, actor.handle_normalizer, actor.url_patterns);
    if (!h) continue;
    if (!new RegExp(actor.handle_regex).test(h)) {
      console.warn(`apify.client.batch: handle "${h}" no matchea regex ${actor.handle_regex} — skip`);
      continue;
    }
    if (!normalized.includes(h)) normalized.push(h);
  }
  if (!normalized.length) throw new Error(`apify.client.batch: ningún handle válido tras normalizar`);

  const N    = normalized.length;
  const cap  = capPerHandle || actor.default_results_per_run;

  // Plan + presupuesto: estimación = (cost_per_result × cap × N) + actor_start_cost
  const plan = await getOrgPlan(organizationId);
  if (!plan) throw new Error(`apify.client.batch: org ${organizationId} sin plan activo`);

  const balance     = await getOrgCredits(organizationId);
  const dailySpent  = await getDailySpend(organizationId);
  const dailyRemain = plan.scraping_daily_cap - dailySpent;
  const markup      = Number(plan.apify_credit_markup) || 2.0;

  const estimateUsd = (actor.cost_per_result_usd || 0) * cap * N + (actor.actor_start_cost_usd || 0);
  const estimateCredits = +(estimateUsd * markup).toFixed(4);

  if (balance < estimateCredits)    { const err = new Error(`créditos insuficientes (${balance} < ${estimateCredits})`); err.code = "INSUFFICIENT_CREDITS"; throw err; }
  if (dailyRemain < estimateCredits) { const err = new Error(`cap diario alcanzado (${dailySpent}/${plan.scraping_daily_cap})`); err.code = "DAILY_CAP_REACHED"; throw err; }

  // Construir input batch según platform
  const input = _buildBatchInput(platform, normalized, cap);

  // Run + poll (con audit; handle en audit = primer handle para legibilidad)
  const startRes = await startRun(actor.apify_actor_id, input);
  const runId    = startRes.id;
  await _auditRunStart({
    runId, organizationId, brandContainerId: null,
    platform, handle: `[batch:${N}] ${normalized.slice(0,3).join(",")}${N>3?"…":""}`,
    actorId: actor.apify_actor_id,
  });

  let finalRun;
  try { finalRun = await pollRun(runId, TIMEOUT_BATCH_S); }
  catch (pollErr) {
    await _auditRunFinish({ runId, status: "TIMED-OUT", error: pollErr.message });
    throw pollErr;
  }
  if (finalRun.status !== "SUCCEEDED") {
    await _auditRunFinish({
      runId, status: finalRun.status, usageUsd: parseFloat(finalRun.usageTotalUsd || 0),
      error: finalRun.statusMessage,
    });
    throw new Error(`apify run ${runId} ended ${finalRun.status}: ${finalRun.statusMessage || ""}`);
  }

  // Fetch items (cap N × cap, con margen)
  const items = await fetchDatasetItems(finalRun.defaultDatasetId, Math.max(100, N * cap + 50));
  const usdReal = parseFloat(finalRun.usageTotalUsd || 0);

  // Agrupar items por handle
  const itemsByHandle = _groupItemsByHandle(platform, items, normalized);

  // Cobrar 1 sola vez al run completo
  const charge = await chargeOrg({
    organizationId, usdCost: usdReal, runId, platform,
    handle: `[batch:${N}]`, actorId: actor.apify_actor_id,
    itemsCount: items.length, cacheHit: false, markup,
  });
  await _auditRunFinish({
    runId, status: "CHARGED", usageUsd: usdReal,
    itemsCount: items.length, chargedCredits: charge.credits,
  });

  return {
    itemsByHandle, runId, usdCost: usdReal,
    credits: charge.credits, balanceAfter: charge.balance_after,
    totalItems: items.length, platform, handles: normalized,
  };
}

// ── 9. Builders de input batch por plataforma ───────────────────────────────
function _buildBatchInput(platform, handles, capPerHandle) {
  const N = handles.length;
  switch (platform) {
    case "instagram":
      // resultsLimit aplica POR PERFIL en apify/instagram-scraper
      return {
        directUrls: handles.map(h => `https://www.instagram.com/${h}/`),
        searchType: "user", resultsType: "posts",
        searchLimit: 1, resultsLimit: capPerHandle,
      };
    case "tiktok":
      // resultsPerPage es POR PERFIL en clockworks/tiktok-scraper
      return {
        profiles: handles, profileSorting: "latest",
        resultsPerPage: capPerHandle,
        shouldDownloadCovers: false, shouldDownloadVideos: false,
        shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false,
      };
    case "youtube":
      // maxResults es TOTAL en streamers/youtube-scraper → multiplicar por N
      return {
        startUrls: handles.map(h => ({ url: `https://www.youtube.com/@${h}/videos` })),
        maxResults: capPerHandle * N,
      };
    case "facebook":
      // resultsLimit es TOTAL en apify/facebook-posts-scraper → multiplicar por N
      return {
        startUrls: handles.map(h => ({ url: `https://www.facebook.com/${h}` })),
        resultsLimit: capPerHandle * N,
      };
    case "x":
      // maxItems es TOTAL en kaitoeasyapi → multiplicar por N
      return {
        maxItems: capPerHandle * N,
        queryType: "Latest",
        searchTerms: handles.map(h => `from:${h}`),
      };
    default:
      throw new Error(`apify.client.batch: platform "${platform}" sin builder de input`);
  }
}

// ── 10. Agrupar items Apify → handle, usando el campo de autor por actor ─────
// Estrategia: probar varios campos en orden (campo del autor + inputUrl como
// fallback). El inputUrl es lo que NOSOTROS pedimos, así que matchea aunque
// Apify resuelva un alias distinto (ej: @alani → ownerUsername=alanination).
function _groupItemsByHandle(platform, items, handles) {
  const handlesLC = handles.map(h => h.toLowerCase());
  const out = Object.fromEntries(handlesLC.map(h => [h, []]));
  const lookup = new Map(handlesLC.map((h, i) => [h, handles[i]]));

  // Extrae todos los candidatos posibles de "handle" desde un item Apify
  function candidatesFromItem(it) {
    const cs = [];
    switch (platform) {
      case "instagram":
        if (it.ownerUsername) cs.push(it.ownerUsername);
        if (it.inputUrl) cs.push(_pathSegment(it.inputUrl));
        break;
      case "tiktok":
        if (it.authorMeta?.uniqueId) cs.push(it.authorMeta.uniqueId);
        if (it.authorMeta?.name) cs.push(it.authorMeta.name);
        if (it.input) cs.push(it.input);  // clockworks devuelve "input" con el profile pedido
        if (it.webVideoUrl) {
          // https://www.tiktok.com/@username/video/123
          const m = it.webVideoUrl.match(/@([\w.]+)/);
          if (m) cs.push(m[1]);
        }
        break;
      case "youtube":
        if (it.channelUsername) cs.push(it.channelUsername.replace(/^@/, ""));
        if (it.channel?.username) cs.push(it.channel.username.replace(/^@/, ""));
        if (it.channelName) cs.push(it.channelName);
        if (it.inputUrl || it.input) cs.push(_pathSegment((it.inputUrl || it.input)).replace(/^@/, ""));
        break;
      case "x":
        if (it.author?.userName) cs.push(it.author.userName);
        if (it.user?.screen_name) cs.push(it.user.screen_name);
        // kaitoeasyapi devuelve searchTerm = "from:nike" → extraer
        if (it.searchTerm) {
          const m = String(it.searchTerm).match(/from:(\w+)/i);
          if (m) cs.push(m[1]);
        }
        break;
      case "facebook":
        if (it.pageUrl) cs.push(_pathSegment(it.pageUrl));
        if (it.pageName) cs.push(it.pageName);
        if (it.user?.name) cs.push(it.user.name);
        if (it.facebookUrl) cs.push(_pathSegment(it.facebookUrl));
        break;
    }
    return cs.filter(Boolean).map(s => String(s).toLowerCase());
  }

  for (const it of items || []) {
    const cands = candidatesFromItem(it);
    for (const c of cands) {
      if (out[c]) { out[c].push(it); break; }
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [lookup.get(k) || k, v])
  );
}

function _pathSegment(urlStr) {
  try {
    const p = new URL(urlStr).pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    return p ? p.replace(/^@/, "") : "";
  } catch { return ""; }
}
