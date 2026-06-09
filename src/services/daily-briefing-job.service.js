/**
 * daily-briefing-job.service.js — Briefing Ejecutivo del Dia (dashboard Estrategia).
 *
 * Job rules-based (SIN LLM, segun la regla de no-LLM-en-background): arma el resumen
 * ejecutivo de cada marca cruzando vulnerabilidades + amenaza competitiva + tendencia
 * mas urgente + acciones pendientes, y lo escribe en body_missions.result_reference
 * (mission_type='daily_briefing'). El dashboard lo lee directamente (Zona 1 + Briefing).
 */
import { supabase } from "../lib/supabase.js";

const REFRESH_MS = parseInt(process.env.DAILY_BRIEFING_REFRESH_MS || "21600000", 10); // 6h
let _timer = null;

const SEV_PENALTY = { critical: 30, high: 15, medium: 8, low: 3 };

function _threatFromCounts(adsRecent, criticalVulns) {
  let t = adsRecent >= 6 ? "CRITICO" : adsRecent >= 3 ? "ALTO" : adsRecent >= 1 ? "MEDIO" : "BAJO";
  if (criticalVulns > 0 && (t === "BAJO" || t === "MEDIO")) t = "ALTO";
  return t;
}

async function generateBriefingForBrand(brand) {
  const bcId = brand.id;
  const orgId = brand.organization_id;
  const since24 = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // 1. Vulnerabilidades abiertas
  let vulns = [];
  try {
    const { data } = await supabase
      .from("brand_vulnerabilities")
      .select("title, severity")
      .eq("brand_container_id", bcId)
      .is("resolved_at", null);
    vulns = data || [];
  } catch (_) {}
  const criticalVulns = vulns.filter((v) => v.severity === "critical").length;
  let score = 100;
  for (const v of vulns) score -= SEV_PENALTY[v.severity] || 5;
  const scoreGlobal = Math.max(0, Math.min(100, score));

  // 2. Amenaza competitiva (ads recientes del rival)
  let adsRecent = 0;
  try {
    const { count } = await supabase
      .from("competitor_ads")
      .select("id", { count: "exact", head: true })
      .eq("brand_container_id", bcId)
      .gte("first_seen_at", since24);
    adsRecent = count || 0;
  } catch (_) {}
  const threatLevel = _threatFromCounts(adsRecent, criticalVulns);

  // 3. Tendencia mas urgente
  let topTrend = null;
  try {
    const { data } = await supabase
      .from("trend_topics")
      .select("keyword, velocity_score")
      .eq("brand_container_id", bcId)
      .order("velocity_score", { ascending: false, nullsFirst: false })
      .limit(1);
    topTrend = data && data[0] ? data[0] : null;
  } catch (_) {}

  // 4. Acciones pendientes + top
  let pending = [];
  try {
    const { data } = await supabase
      .from("vera_pending_actions")
      .select("action_type, vera_reasoning, priority, vera_confidence")
      .eq("brand_container_id", bcId)
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("vera_confidence", { ascending: false, nullsFirst: false })
      .limit(5);
    pending = data || [];
  } catch (_) {}
  const top = pending[0] || null;

  // 5. Texto del briefing (templado)
  const partVuln = vulns.length
    ? `${vulns.length} vulnerabilidad(es) activa(s)${criticalVulns ? ` (${criticalVulns} critica(s))` : ""}`
    : "sin vulnerabilidades abiertas";
  const partTrend = topTrend
    ? `tendencia mas urgente: "${topTrend.keyword}" (velocidad ${topTrend.velocity_score ?? "?"})`
    : "sin tendencia destacada hoy";
  const partPending = pending.length
    ? `${pending.length} accion(es) pendiente(s) de aprobacion`
    : "sin acciones pendientes";
  const partTop = top
    ? ` Prioridad #1: ${String(top.vera_reasoning || top.action_type).slice(0, 160)}.`
    : "";
  const briefingText =
    `Hoy ${brand.nombre_marca}: ${partVuln}. Amenaza competitiva: ${threatLevel}. ` +
    `${partTrend}. ${partPending}.${partTop}`;

  const resultReference = {
    briefing_text: briefingText,
    score_global: scoreGlobal,
    threat_level: threatLevel,
    trend_signal: topTrend ? { keyword: topTrend.keyword, velocity_score: topTrend.velocity_score } : null,
    pending_count: pending.length,
    top_actions: pending.slice(0, 3).map((p) => ({
      action_type: p.action_type,
      reasoning: String(p.vera_reasoning || "").slice(0, 160),
      priority: p.priority,
    })),
    generated_at: new Date().toISOString(),
  };

  // 6. Upsert: una mission daily_briefing por marca por dia (update si ya hay una de hoy)
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  let existingId = null;
  try {
    const { data } = await supabase
      .from("body_missions")
      .select("id")
      .eq("brand_container_id", bcId)
      .eq("mission_type", "daily_briefing")
      .gte("created_at", startOfDay.toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    existingId = data && data[0] ? data[0].id : null;
  } catch (_) {}

  if (existingId) {
    await supabase.from("body_missions")
      .update({ result_reference: resultReference, status: "completed", updated_at: new Date().toISOString() })
      .eq("id", existingId);
  } else {
    await supabase.from("body_missions").insert({
      brand_container_id: bcId,
      organization_id: orgId,
      mission_type: "daily_briefing",
      status: "completed",
      result_reference: resultReference,
    });
  }
  return { brand: brand.nombre_marca, scoreGlobal, threatLevel, pending: pending.length };
}

export async function runDailyBriefings() {
  let done = 0, errors = 0;
  try {
    const { data: brands } = await supabase
      .from("brand_containers")
      .select("id, nombre_marca, organization_id")
      .limit(500);
    for (const b of brands || []) {
      try { await generateBriefingForBrand(b); done++; }
      catch (e) { errors++; console.warn(`daily-briefing: ${b.nombre_marca} -> ${e.message}`); }
    }
  } catch (e) {
    console.warn(`daily-briefing: runDailyBriefings -> ${e.message}`);
  }
  return { done, errors };
}

export function startDailyBriefingJob(intervalMs = REFRESH_MS) {
  if (_timer) return;
  console.log(`daily-briefing-job: scheduler iniciado (refresh cada ${Math.round(intervalMs/3600000)}h, primera corrida en 90s)`);
  setTimeout(async () => {
    const r = await runDailyBriefings();
    console.log(`daily-briefing: corrida inicial — ${r.done} marcas, ${r.errors} errores`);
  }, 90_000);
  _timer = setInterval(async () => {
    const r = await runDailyBriefings();
    if (r.done || r.errors) console.log(`daily-briefing: refresh — ${r.done} marcas, ${r.errors} errores`);
  }, intervalMs);
}

export function stopDailyBriefingJob() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
