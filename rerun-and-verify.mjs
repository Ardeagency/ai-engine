import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";

// 1) Re-correr el sensor de heatmap (forzar trigger now)
await sb.from("monitoring_triggers").update({ next_run_at: new Date().toISOString() })
  .eq("brand_container_id", brandId).eq("sensor_type", "brand_audience_heatmap_compute");

const scraper = await import("./src/services/social-scraper.service.js");
const r = await scraper.runCompetitorScraper();
console.log("scraper cycle:", JSON.stringify(r));

// 2) Re-analizar TODOS los posts para que el sentiment se recompute con el lexicon corregido
//    (analyzeAndPersistPost es idempotente — si ya existe lo skipea, así que primero borro)
console.log("\nBorrando análisis previos para forzar re-cálculo con sentiment fix...");
await sb.from("brand_content_analysis").delete().eq("brand_container_id", brandId);
await sb.from("brand_narrative_pillars").delete().eq("brand_container_id", brandId);
await sb.from("brand_posts").update({ sentiment: {} }).eq("brand_container_id", brandId);

const ca = await import("./src/services/content-analysis.service.js");
const bf = await ca.runContentAnalysisBackfill(brandId, 500);
console.log("backfill:", JSON.stringify(bf));

// 3) Verificar
const { data: hm } = await sb.from("brand_audience_heatmap").select("platform, best_hour, best_day, hour_engagement, day_engagement").eq("brand_container_id", brandId);
console.log("\n=== brand_audience_heatmap ===");
const dayNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
for (const h of hm || []) {
  console.log("  [" + h.platform + "] best_hour=" + h.best_hour + ":00 UTC | best_day=" + dayNames[h.best_day]);
  const topHours = Object.entries(h.hour_engagement || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5);
  console.log("    top hours: " + topHours.map(([h, v]) => h + "h=" + Number(v).toFixed(0)).join(", "));
}

const { count: caCount } = await sb.from("brand_content_analysis").select("*", { count: "exact", head: true }).eq("brand_container_id", brandId);
console.log("\nbrand_content_analysis: " + (caCount || 0));

// Sentiment distribution
const { data: sentiSamples } = await sb.from("brand_posts").select("content, sentiment").eq("brand_container_id", brandId).not("sentiment", "is", null);
let nonZero = 0, posScore = 0, negScore = 0, zeroScore = 0;
for (const p of sentiSamples || []) {
  const s = p.sentiment?.score;
  if (s == null || s === 0) zeroScore++;
  else if (s > 0) { nonZero++; posScore++; }
  else if (s < 0) { nonZero++; negScore++; }
}
console.log("\n=== sentiment distribution (posts con sentiment poblado) ===");
console.log("  total: " + sentiSamples?.length + " | con score≠0: " + nonZero + " | positivos: " + posScore + " | negativos: " + negScore + " | zero: " + zeroScore);
const withSenti = (sentiSamples || []).filter((p) => p.sentiment?.score && p.sentiment.score !== 0).slice(0, 3);
console.log("\nSamples con sentiment ≠ 0:");
for (const p of withSenti) console.log("  score=" + p.sentiment.score + " | " + (p.content || "").slice(0, 80));

// Pillars
const { data: pillars } = await sb.from("brand_narrative_pillars").select("pillar_name, post_count, avg_engagement").eq("brand_container_id", brandId).order("post_count", { ascending: false });
console.log("\n=== brand_narrative_pillars ===");
for (const p of pillars || []) console.log("  📌 " + p.pillar_name.padEnd(20) + " posts=" + p.post_count + " avg_eng=" + p.avg_engagement);
