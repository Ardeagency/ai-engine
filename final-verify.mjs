import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";

console.log("=== ESTADO FINAL DE TABLAS ===");
const tables = [
  ["brand_posts", "brand_container_id"],
  ["brand_content_analysis", "brand_container_id"],
  ["brand_narrative_pillars", "brand_container_id"],
  ["brand_audience_heatmap", "brand_container_id"],
  ["audience_personas", "brand_container_id"],
  ["audience_segments", "brand_container_id"],
  ["intelligence_signals", null],
  ["trend_topics", "brand_container_id"],
  ["vera_pending_actions", "brand_container_id"],
];
for (const [t, scope] of tables) {
  let q = sb.from(t).select("*", { count: "exact", head: true });
  if (scope) q = q.eq(scope, brandId);
  const { count } = await q;
  console.log("  " + t.padEnd(28) + " " + (count || 0));
}

const { data: heatmap } = await sb.from("brand_audience_heatmap").select("platform, best_hour, best_day, hour_engagement, day_engagement").eq("brand_container_id", brandId);
console.log("\n=== brand_audience_heatmap ===");
for (const h of heatmap || []) {
  const dayNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  console.log("  [" + h.platform + "] best_hour=" + h.best_hour + ":00 UTC | best_day=" + dayNames[h.best_day]);
  // Top 3 hours
  const topHours = Object.entries(h.hour_engagement || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3);
  console.log("    top hours: " + topHours.map(([h, v]) => h + "h=" + v).join(", "));
  const topDays = Object.entries(h.day_engagement || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3);
  console.log("    top days: " + topDays.map(([d, v]) => dayNames[Number(d)] + "=" + v).join(", "));
}

const { data: pillars } = await sb.from("brand_narrative_pillars").select("pillar_name, post_count, avg_engagement, avg_reach").eq("brand_container_id", brandId).order("post_count", { ascending: false });
console.log("\n=== brand_narrative_pillars (rule-based) ===");
for (const p of pillars || []) {
  console.log("  📌 " + p.pillar_name.padEnd(20) + " | posts=" + String(p.post_count).padEnd(4) + " | avg_eng=" + p.avg_engagement);
}

// Distribución de tones detectados
const { data: toneDist } = await sb.from("brand_content_analysis").select("tone_detected, dominant_emotion").eq("brand_container_id", brandId);
const toneCount = {};
const emoCount = {};
for (const t of toneDist || []) {
  toneCount[t.tone_detected] = (toneCount[t.tone_detected] || 0) + 1;
  if (t.dominant_emotion) emoCount[t.dominant_emotion] = (emoCount[t.dominant_emotion] || 0) + 1;
}
console.log("\n=== Distribución de tonos detectados ===");
for (const [k, v] of Object.entries(toneCount).sort((a, b) => b[1] - a[1])) console.log("  " + k.padEnd(20) + " " + v);
console.log("\n=== Distribución de emociones ===");
for (const [k, v] of Object.entries(emoCount).sort((a, b) => b[1] - a[1])) console.log("  " + k.padEnd(20) + " " + v);

// Posts con sentiment poblado
const { data: sentimentPosts, count: sentimentCount } = await sb.from("brand_posts").select("sentiment", { count: "exact" }).eq("brand_container_id", brandId).not("sentiment", "is", null).limit(5);
console.log("\n=== brand_posts.sentiment ===");
console.log("  total con sentiment: " + (sentimentCount || 0));
for (const p of sentimentPosts || []) console.log("  " + JSON.stringify(p.sentiment));
