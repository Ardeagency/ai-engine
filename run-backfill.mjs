import { createClient } from "@supabase/supabase-js";
import { runContentAnalysisBackfill } from "./src/services/content-analysis.service.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";

console.log("=== ANTES ===");
const { count: beforeCount } = await sb.from("brand_content_analysis").select("*", { count: "exact", head: true }).eq("brand_container_id", brandId);
console.log("brand_content_analysis: " + (beforeCount || 0));

const result = await runContentAnalysisBackfill(brandId, 500);
console.log("\nResultado backfill:", JSON.stringify(result));

console.log("\n=== DESPUÉS ===");
const { count: afterCount } = await sb.from("brand_content_analysis").select("*", { count: "exact", head: true }).eq("brand_container_id", brandId);
console.log("brand_content_analysis: " + (afterCount || 0));

// Crear trigger de heatmap
const { data: bc } = await sb.from("brand_containers").select("organization_id").eq("id", brandId).maybeSingle();
const { data: existing } = await sb.from("monitoring_triggers").select("id").eq("brand_container_id", brandId).eq("sensor_type", "brand_audience_heatmap_compute").is("entity_id", null).maybeSingle();
if (existing) {
  console.log("\nheatmap trigger ya existía: " + existing.id);
} else {
  const { data: ins, error } = await sb.from("monitoring_triggers").insert({
    brand_container_id: brandId,
    organization_id:    bc.organization_id,
    entity_id:          null,
    sensor_type:        "brand_audience_heatmap_compute",
    cadence:            "daily",
    cadence_value:      "1",
    priority:           5,
    status:             "active",
    next_run_at:        new Date().toISOString(),
    config:             { auto_created_by: "audience-intelligence-rollout-2026-04-28" },
  }).select("id").maybeSingle();
  if (error) console.log("\nheatmap trigger insert error: " + error.message);
  else console.log("\nheatmap trigger creado: " + ins.id);
}

// Resumen narrativo de pilares
const { data: pillars } = await sb.from("brand_narrative_pillars").select("pillar_name, post_count, avg_engagement").eq("brand_container_id", brandId).order("post_count", { ascending: false });
console.log("\n=== brand_narrative_pillars ===");
for (const p of pillars || []) console.log("  " + p.pillar_name + ": " + p.post_count + " posts, avg_eng=" + p.avg_engagement);

// Sample de 3 análisis recién creados
const { data: samples } = await sb.from("brand_content_analysis").select("brand_post_id, tone_detected, dominant_emotion, narrative_pillar, clarity_score, fatigue_risk, why_it_worked, brand_posts(network, content)").eq("brand_container_id", brandId).order("analyzed_at", { ascending: false }).limit(3);
console.log("\n=== 3 análisis sample ===");
for (const s of samples || []) {
  console.log("---");
  console.log("post: [" + s.brand_posts?.network + "] " + (s.brand_posts?.content || "").slice(0, 80));
  console.log("  tone: " + s.tone_detected + " | emotion: " + s.dominant_emotion + " | pillar: " + s.narrative_pillar);
  console.log("  clarity: " + s.clarity_score + " | fatigue: " + s.fatigue_risk);
  console.log("  why: " + JSON.stringify(s.why_it_worked));
}
