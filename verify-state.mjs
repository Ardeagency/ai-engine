import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";

const { data: runs } = await sb.from("sensor_runs")
  .select("sensor_type, status, duration_ms, stats, error_message")
  .eq("brand_container_id", brandId)
  .gte("started_at", new Date(Date.now() - 600000).toISOString())
  .order("started_at", { ascending: false });

console.log("=== SENSOR RUNS (últimos 10 min) ===");
for (const r of runs || []) {
  console.log("[" + r.status + "] " + r.sensor_type + " (" + r.duration_ms + "ms) → " + JSON.stringify(r.stats));
  if (r.error_message) console.log("  ERROR: " + r.error_message);
}

const { data: segs, count: segCount } = await sb.from("audience_segments")
  .select("id,external_audience_name,external_audience_type,estimated_size,age_range,genders", { count: "exact" })
  .eq("brand_container_id", brandId);

console.log("\n=== AUDIENCE_SEGMENTS ===");
console.log("total: " + segCount);
for (const s of (segs || []).slice(0, 8)) {
  console.log("  - " + s.external_audience_name + " [" + s.external_audience_type + "] size=" + s.estimated_size + " genders=" + JSON.stringify(s.genders));
}

const { data: personas } = await sb.from("audience_personas")
  .select("id, name, alignment_score, alignment_analyzed_at, top_converting_segment, datos_demograficos, real_age_distribution, real_gender_distribution, real_location_distribution")
  .eq("brand_container_id", brandId);

console.log("\n=== PERSONAS CON ALIGNMENT ===");
for (const p of personas || []) {
  const sources = [
    ...(p.real_age_distribution?._sources || []),
    ...(p.real_gender_distribution?._sources || []),
  ];
  console.log("Persona: " + p.name);
  console.log("  alignment_score: " + p.alignment_score + " (analyzed: " + p.alignment_analyzed_at + ")");
  console.log("  datos_demograficos: " + JSON.stringify(p.datos_demograficos));
  console.log("  data_sources_fused: " + JSON.stringify([...new Set(sources)]));
  console.log("  top_converting: " + JSON.stringify(p.top_converting_segment));
  // Top 3 ages
  const ageEntries = Object.entries(p.real_age_distribution || {})
    .filter(([k]) => !k.startsWith("_"))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3);
  console.log("  top ages: " + ageEntries.map(([k, v]) => k + "=" + (Number(v) * 100).toFixed(0) + "%").join(", "));
  // Top 2 countries
  const countryEntries = Object.entries(p.real_location_distribution?.countries || {})
    .filter(([k]) => !k.startsWith("_"))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3);
  console.log("  top countries: " + countryEntries.map(([k, v]) => k + "=" + (Number(v) * 100).toFixed(0) + "%").join(", "));
}

const { data: pending } = await sb.from("vera_pending_actions")
  .select("id, action_type, target_table, target_id, status, priority, vera_confidence, vera_reasoning")
  .eq("brand_container_id", brandId)
  .eq("status", "pending")
  .order("created_at", { ascending: false });

console.log("\n=== VERA_PENDING_ACTIONS (status=pending) ===");
console.log("total: " + (pending?.length || 0));
for (const a of pending || []) {
  console.log("---");
  console.log("[priority=" + a.priority + ", confidence=" + a.vera_confidence + "] " + a.action_type + " → " + a.target_table + "/" + a.target_id);
  console.log("  reasoning:");
  for (const line of (a.vera_reasoning || "").split("\n")) console.log("    " + line);
}
