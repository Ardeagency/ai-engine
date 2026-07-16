// ─────────────────────────────────────────────────────────────────────────────
// visibility-sensor.service.js — Radiografia de Visibilidad, sensor GEO (fase 1).
//
// Mide la Visibilidad IA de una marca: corre prompts-objetivo contra los motores en
// modo GROUNDED (grounded-llm.js), detecta si la marca aparece + posicion + share of
// voice vs competidores + fuentes que cita la IA, y escribe visibility_probes /
// visibility_mentions / visibility_snapshots. Alimenta a Vera (brain-feed + strategic_frame).
//
// NO usa pg_cron (Postgres no llama LLMs): scheduler Node estilo brand-sensor-sync.
// Presupuesto ACOTADO: tope de prompts x motor x marca y tope de marcas por ciclo.
// Parseo de menciones = deterministico (reglas), no LLM de fondo. Sentimiento = null en
// F1 (no medido; cero dato falso). Costo -> credit_usage kind 'visibility_probe'.
//
// Ref: docs/radiografia-visibilidad.md
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../lib/supabase.js";
import { chatCompletion } from "../lib/openai.js";
import { askEngine } from "../lib/grounded-llm.js";

// ── Config / presupuesto (env-overridable) ──────────────────────────────────────
const ENGINES_ACTIVE = (process.env.VISIBILITY_ENGINES || "openai,gemini,claude")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_PROMPTS = parseInt(process.env.VISIBILITY_MAX_PROMPTS || "15", 10);
const MAX_BRANDS_PER_CYCLE = parseInt(process.env.VISIBILITY_MAX_BRANDS_PER_CYCLE || "20", 10);
const DEFAULT_CADENCE_DAYS = parseInt(process.env.VISIBILITY_DEFAULT_CADENCE_DAYS || "7", 10);
const CYCLE_INTERVAL_MS = parseInt(process.env.VISIBILITY_CYCLE_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10); // 6h barrido
// Pesos por motor en el score (grounded-de-busqueda pesa mas). Perplexity entra en F1.1.
const ENGINE_WEIGHT = { openai: 1.0, gemini: 1.2, claude: 1.0, perplexity: 1.3 };

let _interval = null;

// ── Utilidades de parseo (deterministicas) ──────────────────────────────────────
function _norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

// primer indice de aparicion de cualquier alias (o -1). Frontera laxa para no perder
// marcas con espacios/guiones; evita falsos por substring exigiendo separador no-alfanumerico.
function _firstIndex(haystack, aliases) {
  let best = -1;
  for (const a of aliases) {
    const term = _norm(a).trim();
    if (term.length < 2) continue;
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    const m = re.exec(haystack);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function _domainOf(url) {
  try { return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

// ── Generacion de prompts-objetivo ──────────────────────────────────────────────
async function _generatePrompts(brand) {
  const kws = Array.isArray(brand.palabras_clave) ? brand.palabras_clave.slice(0, 8) : [];
  const subn = Array.isArray(brand.sub_nichos) ? brand.sub_nichos.slice(0, 5) : [];
  const ctx = {
    nicho: brand.nicho_core,
    sub_nichos: subn,
    propuesta: brand.propuesta_valor,
    mercado: brand.mercado_objetivo,
    keywords: kws,
  };
  // Intento LLM (una llamada barata) para prompts naturales de descubrimiento.
  try {
    const { content } = await chatCompletion({
      model: process.env.VISIBILITY_PROMPTGEN_MODEL || "gpt-4o-mini",
      max_tokens: 700,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Eres un experto en GEO. Devuelve SOLO JSON." },
        {
          role: "user",
          content:
            `Genera ${MAX_PROMPTS} preguntas REALES que un comprador le haria a una IA (ChatGPT/Perplexity) ` +
            `para descubrir soluciones en esta categoria, SIN nombrar la marca (medimos descubrimiento, no reconocimiento). ` +
            `Mezcla intencion de categoria ("mejor X para Y"), comparacion ("alternativas a...") y problema ("como resuelvo..."). ` +
            `Contexto: ${JSON.stringify(ctx)}. ` +
            `Formato: {"prompts":[{"q":"...","intent":"category|comparison|problem"}]}`,
        },
      ],
    });
    const parsed = JSON.parse(content);
    const out = (parsed.prompts || [])
      .filter((p) => p && p.q)
      .slice(0, MAX_PROMPTS)
      .map((p) => ({ q: String(p.q), intent: p.intent || "category" }));
    if (out.length) return out;
  } catch (e) {
    console.warn(`[visibility] promptgen LLM fallo, uso fallback: ${e.message}`);
  }
  // Fallback deterministico (sin LLM).
  const base = [brand.nicho_core, ...subn, ...kws].filter(Boolean);
  const mkt = brand.mercado_objetivo ? ` en ${brand.mercado_objetivo}` : "";
  const templates = [];
  for (const t of base.slice(0, MAX_PROMPTS)) {
    templates.push({ q: `Cual es la mejor opcion de ${t}${mkt}?`, intent: "category" });
    if (templates.length >= MAX_PROMPTS) break;
    templates.push({ q: `Que alternativas recomiendas para ${t}${mkt}?`, intent: "comparison" });
    if (templates.length >= MAX_PROMPTS) break;
  }
  return templates.slice(0, MAX_PROMPTS);
}

// ── Marca + competidores ────────────────────────────────────────────────────────
async function _loadBrandContext(brand) {
  const { data: comps } = await supabase
    .from("intelligence_entities")
    .select("id, name, domain, target_identifier, is_active")
    .eq("brand_container_id", brand.id)
    .eq("is_active", true);
  const competitors = (comps || [])
    .map((c) => ({
      name: c.name,
      domain: c.domain ? _domainOf(c.domain) : null,
      aliases: [c.name, c.target_identifier].filter(Boolean),
    }))
    .filter((c) => c.aliases.length);

  // Auto-descubre las superficies propias (web/tienda/red) SIN pedir URL al usuario.
  const surfaces = await _discoverSurfaces(brand);
  const brandAliases = [brand.nombre_marca].filter(Boolean);
  return { competitors, surfaces, brandAliases };
}

// Superficies propias derivadas de datos existentes: web del scrape de onboarding,
// tiendas y redes de las integraciones activas. Cero input del usuario.
const _STORE_PLATFORMS = new Set(["shopify", "mercadolibre", "amazon", "woocommerce", "tiendanube", "vtex"]);
const _SOCIAL_PLATFORMS = new Set(["facebook", "instagram", "tiktok", "twitter", "x", "youtube", "linkedin", "pinterest", "threads"]);

async function _discoverSurfaces(brand) {
  const web = new Set(), tienda = new Set(), red = new Set();
  const { data: integ } = await supabase
    .from("brand_integrations")
    .select("platform, shop_domain, account_url")
    .eq("brand_container_id", brand.id)
    .eq("is_active", true);
  for (const row of integ || []) {
    const d = _domainOf(row.shop_domain || row.account_url || "");
    if (!d) continue;
    const p = (row.platform || "").toLowerCase();
    if (_STORE_PLATFORMS.has(p)) tienda.add(d);
    else if (_SOCIAL_PLATFORMS.has(p)) red.add(d);
    else web.add(d);
  }
  const { data: jobs } = await supabase
    .from("brand_scrape_jobs")
    .select("seed_url")
    .eq("organization_id", brand.organization_id)
    .not("seed_url", "is", null)
    .limit(10);
  for (const j of jobs || []) { const d = _domainOf(j.seed_url); if (d) web.add(d); }
  return { web, tienda, red };
}

// Clasifica un dominio citado por la IA en una superficie propia (o null si es de un tercero).
function _classifySurface(surfaces, domain) {
  if (!domain) return null;
  for (const surf of ["web", "tienda", "red"]) {
    for (const d of surfaces[surf]) {
      if (domain === d || domain.endsWith("." + d)) return surf;
    }
  }
  return null;
}

// ── Parseo de una respuesta grounded a una fila visibility_mentions ──────────────
function _parseMention(ans, prompt, intent, ctx) {
  const text = _norm(ans.text);
  const brandIdx = _firstIndex(text, ctx.brandAliases);
  const brand_mentioned = brandIdx >= 0;

  // Ranking: ordena por posicion de primera aparicion (marca + competidores presentes).
  const positions = [];
  if (brand_mentioned) positions.push({ who: "__brand__", idx: brandIdx });
  const competitor_mentions = [];
  for (const c of ctx.competitors) {
    const idx = _firstIndex(text, c.aliases);
    if (idx >= 0) { positions.push({ who: c.name, idx }); competitor_mentions.push({ name: c.name, position: null }); }
  }
  positions.sort((a, b) => a.idx - b.idx);
  positions.forEach((p, i) => {
    if (p.who === "__brand__") return;
    const cm = competitor_mentions.find((x) => x.name === p.who);
    if (cm) cm.position = i + 1;
  });
  const brand_position = brand_mentioned ? positions.findIndex((p) => p.who === "__brand__") + 1 : null;

  // Citas: clasifica cada fuente por superficie propia (web/tienda/red) o tercero.
  const cited_sources = (ans.citations || []).map((c) => {
    const domain = c.domain || _domainOf(c.url);
    const surface = _classifySurface(ctx.surfaces, domain);
    return { url: c.url, domain, title: c.title || null, surface, is_ours: surface != null };
  });

  // Excerpt de evidencia alrededor de la mencion (o inicio).
  let answer_excerpt = null;
  if (brand_mentioned) {
    const raw = ans.text || "";
    const start = Math.max(0, brandIdx - 80);
    answer_excerpt = raw.slice(start, start + 240);
  }

  return {
    engine: ans.engine,
    prompt,
    prompt_intent: intent,
    brand_mentioned,
    brand_position,
    competitor_mentions,
    cited_sources,
    answer_excerpt,
    sentiment: null, // F1: no medido (cero dato falso)
    raw_response: { text: (ans.text || "").slice(0, 4000), usage: ans.usage },
    _costUsd: ans.costUsd || 0,
  };
}

// ── Scoring -> fila visibility_snapshots ────────────────────────────────────────
function _computeSnapshot(mentions) {
  const byEngine = {};
  for (const m of mentions) {
    (byEngine[m.engine] ||= []).push(m);
  }
  const engine_breakdown = {};
  let weightedSum = 0, weightTotal = 0;
  let brandHits = 0, competitorHits = 0;

  for (const [engine, ms] of Object.entries(byEngine)) {
    const total = ms.length;
    const hits = ms.filter((m) => m.brand_mentioned);
    const appeared_pct = total ? hits.length / total : 0;
    const posAvg = hits.length
      ? hits.reduce((s, m) => s + 1 / Math.log2((m.brand_position || 1) + 1), 0) / hits.length
      : 0;
    const engineScore = appeared_pct * posAvg; // 0..1
    const w = ENGINE_WEIGHT[engine] ?? 1;
    weightedSum += engineScore * w;
    weightTotal += w;
    brandHits += hits.length;
    competitorHits += ms.reduce((s, m) => s + (m.competitor_mentions?.length || 0), 0);
    engine_breakdown[engine] = {
      appeared_pct: Number(appeared_pct.toFixed(3)),
      prompts: total,
      score: Number((engineScore * 100).toFixed(1)),
    };
  }

  const ai_visibility_score = weightTotal ? Number(((weightedSum / weightTotal) * 100).toFixed(1)) : 0;
  const denom = brandHits + competitorHits;
  const ai_share_of_voice = denom ? Number((brandHits / denom).toFixed(3)) : null;

  // Fuentes citadas y brecha (fuentes de prompts donde ganó un competidor y la marca no).
  const sourceCounts = {};
  const gapCounts = {};
  for (const m of mentions) {
    for (const s of m.cited_sources || []) {
      if (!s.domain) continue;
      sourceCounts[s.domain] = (sourceCounts[s.domain] || 0) + 1;
      const lostPrompt = !m.brand_mentioned && (m.competitor_mentions?.length || 0) > 0;
      if (lostPrompt && !s.is_ours) gapCounts[s.domain] = (gapCounts[s.domain] || 0) + 1;
    }
  }
  const top_cited_sources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 15).map(([domain, count]) => ({ domain, count }));
  const source_gap = Object.entries(gapCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 15).map(([domain, count]) => ({ domain, count }));

  // Desglose por superficie propia: cuantas veces la IA cito tu web / tienda / red.
  const surface_breakdown = { web: 0, tienda: 0, red: 0 };
  for (const m of mentions) {
    for (const s of m.cited_sources || []) {
      if (s.surface && surface_breakdown[s.surface] != null) surface_breakdown[s.surface] += 1;
    }
  }

  return {
    ai_visibility_score,
    human_visibility_score: null, // fase C (gate externo)
    ai_share_of_voice,
    engine_breakdown,
    surface_breakdown,
    top_cited_sources,
    source_gap,
    components: { show_ai: ai_visibility_score, reach: null, read: null, trust: null, show_seo: null },
  };
}

// ── Corrida para UNA marca ──────────────────────────────────────────────────────
export async function runForBrand(brand) {
  const ctx = await _loadBrandContext(brand);
  const prompts = await _generatePrompts(brand);

  const { data: probe, error: probeErr } = await supabase
    .from("visibility_probes")
    .insert({
      organization_id: brand.organization_id,
      brand_container_id: brand.id,
      probe_type: "geo",
      engines: ENGINES_ACTIVE,
      prompts_total: prompts.length,
      status: "running",
    })
    .select("id")
    .single();
  if (probeErr) throw new Error(`insert visibility_probes: ${probeErr.message}`);

  const mentions = [];
  let executed = 0, totalCost = 0, failures = 0;
  for (const p of prompts) {
    for (const engine of ENGINES_ACTIVE) {
      try {
        const ans = await askEngine(engine, p.q);
        const parsed = _parseMention(ans, p.q, p.intent, ctx);
        totalCost += parsed._costUsd;
        const { _costUsd, ...row } = parsed;
        mentions.push(row);
        await supabase.from("visibility_mentions").insert({
          probe_id: probe.id,
          organization_id: brand.organization_id,
          brand_container_id: brand.id,
          ...row,
        });
        executed++;
      } catch (e) {
        failures++;
        console.warn(`[visibility] ${engine} fallo en "${p.q.slice(0, 40)}": ${e.message}`);
      }
    }
  }

  const snap = _computeSnapshot(mentions);
  const today = new Date().toISOString().slice(0, 10);
  const prev = await _priorScores(brand.id, today);
  await supabase.from("visibility_snapshots").upsert(
    {
      organization_id: brand.organization_id,
      brand_container_id: brand.id,
      snapshot_date: today,
      ...snap,
      trend_7d: prev.d7 != null ? Number((snap.ai_visibility_score - prev.d7).toFixed(1)) : null,
      trend_30d: prev.d30 != null ? Number((snap.ai_visibility_score - prev.d30).toFixed(1)) : null,
    },
    { onConflict: "brand_container_id,snapshot_date" },
  );

  const mentionsFound = mentions.filter((m) => m.brand_mentioned).length;
  await supabase.from("visibility_probes").update({
    status: failures && !executed ? "failed" : failures ? "partial" : "completed",
    prompts_executed: executed,
    mentions_found: mentionsFound,
    total_cost_usd: Number(totalCost.toFixed(6)),
    total_credits_consumed: Number(totalCost.toFixed(6)),
    completed_at: new Date().toISOString(),
  }).eq("id", probe.id);

  // Accounting de costo (fire-and-forget, no bloquea).
  supabase.from("credit_usage").insert({
    organization_id: brand.organization_id,
    kind: "visibility_probe",
    credits_delta: Number(totalCost.toFixed(6)),
    usd_cost: Number(totalCost.toFixed(6)),
    source_table: "visibility_probes",
    source_id: probe.id,
    metadata: { engines: ENGINES_ACTIVE, prompts: prompts.length, executed, failures, ai_visibility_score: snap.ai_visibility_score },
  }).then(({ error }) => { if (error) console.warn(`[visibility] credit_usage: ${error.message}`); });

  console.log(`[visibility] ${brand.nombre_marca}: score=${snap.ai_visibility_score} sov=${snap.ai_share_of_voice} (${executed} calls, ${failures} fail, $${totalCost.toFixed(3)})`);
  return { probeId: probe.id, ...snap };
}

async function _priorScores(brandId, today) {
  const { data } = await supabase
    .from("visibility_snapshots")
    .select("snapshot_date, ai_visibility_score")
    .eq("brand_container_id", brandId)
    .lt("snapshot_date", today)
    .order("snapshot_date", { ascending: false })
    .limit(60);
  const rows = data || [];
  const pick = (days) => {
    const target = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    let best = null;
    for (const r of rows) if (r.snapshot_date <= target && (!best || r.snapshot_date > best.snapshot_date)) best = r;
    return best?.ai_visibility_score ?? null;
  };
  return { d7: pick(7), d30: pick(30) };
}

// ── Barrido: marcas "due" segun cadencia por plan ───────────────────────────────
async function _cadenceDaysForOrg(organizationId) {
  const { data } = await supabase
    .from("subscriptions")
    .select("plans!inner(visibility_cadence_days)")
    .eq("organization_id", organizationId)
    .in("status", ["trial", "active", "past_due"])
    .maybeSingle();
  return data?.plans?.visibility_cadence_days ?? DEFAULT_CADENCE_DAYS;
}

export async function runVisibilityCycle() {
  const { data: brands, error } = await supabase
    .from("brand_containers")
    .select("id, organization_id, nombre_marca, nicho_core, sub_nichos, palabras_clave, propuesta_valor, mercado_objetivo");
  if (error) { console.error(`[visibility] cargar marcas: ${error.message}`); return; }

  const due = [];
  for (const b of brands || []) {
    if (!b.nicho_core && !(b.palabras_clave?.length)) continue; // sin contexto no medimos (cero dato falso)
    const cadence = await _cadenceDaysForOrg(b.organization_id);
    const { data: last } = await supabase
      .from("visibility_snapshots")
      .select("snapshot_date")
      .eq("brand_container_id", b.id)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const dueSince = new Date(Date.now() - cadence * 864e5).toISOString().slice(0, 10);
    if (!last || last.snapshot_date <= dueSince) due.push(b);
    if (due.length >= MAX_BRANDS_PER_CYCLE) break;
  }

  console.log(`[visibility] ciclo: ${due.length} marcas due (tope ${MAX_BRANDS_PER_CYCLE})`);
  for (const b of due) {
    try { await runForBrand(b); }
    catch (e) { console.error(`[visibility] marca ${b.nombre_marca} fallo: ${e.message}`); }
  }
}

// ── Scheduler (registrar en src/index.js) ───────────────────────────────────────
export function startVisibilitySensor(intervalMs = CYCLE_INTERVAL_MS) {
  if (process.env.VISIBILITY_SENSOR_ENABLED === "false") {
    console.log("[visibility] deshabilitado (VISIBILITY_SENSOR_ENABLED=false)");
    return;
  }
  setTimeout(() => { runVisibilityCycle().catch((e) => console.error(`[visibility] ciclo inicial: ${e.message}`)); }, 60_000);
  _interval = setInterval(() => { runVisibilityCycle().catch((e) => console.error(`[visibility] ciclo: ${e.message}`)); }, intervalMs);
  console.log(`[visibility] sensor arrancado (motores=${ENGINES_ACTIVE.join("+")}, cada ${Math.round(intervalMs / 3600000)}h)`);
}

export function stopVisibilitySensor() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}
