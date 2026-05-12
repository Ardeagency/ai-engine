/**
 * apify.client.js — Wrapper único para todos los scrapes vía Apify.
 *
 * Responsabilidades:
 *   1. Auto-detección de plataforma desde URL/handle (lookup scraper_actors)
 *   2. Normalización de handle según el normalizer del actor
 *   3. Pre-flight: validar plan + créditos + cap diario + cache hit
 *   4. Ejecución de Apify run (POST /v2/acts/{actor}/runs + poll)
 *   5. Lectura del usageTotalUsd real al finalizar
 *   6. Cobro exacto en organization_credits (1 crédito = $0.10 USD)
 *   7. Registro en credit_usage ledger
 *   8. Devuelve items normalizados al caller
 *
 * Variables de entorno:
 *   APIFY_API_TOKEN         — token de Apify (requerido)
 *   APIFY_RUN_TIMEOUT_SEC   — timeout por run (default 180)
 *   USD_PER_CREDIT          — conversión (default 0.10 = 1 crédito)
 */
import { supabase } from "./supabase.js";

const APIFY_BASE = "https://api.apify.com/v2";
const TOKEN      = process.env.APIFY_API_TOKEN;
const TIMEOUT_S  = parseInt(process.env.APIFY_RUN_TIMEOUT_SEC || "180", 10);
const USD_PER_CR = parseFloat(process.env.USD_PER_CREDIT || "0.10");

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
    .select("plan_id, status, plans!inner(id, name, max_handles, scraping_cadence_hours, scraping_daily_cap, cache_ttl_hours)")
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

async function pollRun(runId) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < TIMEOUT_S) {
    const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`);
    const j = await r.json();
    const d = j.data;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(d.status)) return d;
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`apify run ${runId} timeout after ${TIMEOUT_S}s`);
}

async function fetchDatasetItems(datasetId, limit = 100) {
  const r = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&limit=${limit}&format=json`);
  if (!r.ok) throw new Error(`dataset fetch failed (${r.status})`);
  return r.json();
}

// ── 6. Cobro atómico + ledger ───────────────────────────────────────────────
async function chargeOrg({ organizationId, usdCost, runId, platform, handle, actorId, itemsCount, cacheHit = false }) {
  const credits = +(usdCost / USD_PER_CR).toFixed(2);

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
  const effectiveCap = Math.min(cap || actor.default_results_per_run, actor.default_results_per_run);

  // Estimación max (cap × cost_per_result + actor_start)
  const estimateUsd = (actor.cost_per_result_usd || 0) * effectiveCap + (actor.actor_start_cost_usd || 0);
  const estimateCredits = +(estimateUsd / USD_PER_CR).toFixed(2);

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
    actorId: actor.apify_actor_id, itemsCount: items.length, cacheHit: false,
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
