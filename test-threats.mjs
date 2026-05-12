import { createClient } from "@supabase/supabase-js";
import { runThreatDetection } from "./src/services/threat-detector.service.js";
import { ensureSensorsForBrand } from "./src/services/brand-sensor-sync.service.js";
import { getBrandContent } from "./src/tools/social.tools.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

console.log("=== Test 1: Sync de sensores incluye threat_detection ===");
const r0 = await ensureSensorsForBrand(brandId, orgId);
console.log("ensureSensorsForBrand:", r0);

console.log("\n=== Test 2: runThreatDetection ===");
const r1 = await runThreatDetection(brandId, orgId);
console.log(JSON.stringify(r1, null, 2));

console.log("\n=== Test 3: brand_vulnerabilities después ===");
const { data: vulns } = await sb.from("brand_vulnerabilities")
  .select("title, severity, status, metadata, created_at")
  .eq("brand_container_id", brandId)
  .eq("status", "open")
  .order("created_at", { ascending: false })
  .limit(20);
console.log("Total open: " + (vulns?.length || 0));
const grouped = {};
for (const v of vulns || []) {
  const tt = v.metadata?.threat_type || "(legacy/no_type)";
  grouped[tt] = (grouped[tt] || 0) + 1;
}
console.log("Por threat_type:", JSON.stringify(grouped, null, 2));
console.log("\nUltimas 5:");
for (const v of (vulns || []).slice(0, 5)) {
  console.log("  [" + v.severity + "] " + v.title + " (type=" + (v.metadata?.threat_type || "n/a") + ")");
}

console.log("\n=== Test 4: getBrandContent.active_threats ===");
const bc = await getBrandContent({ organizationId: orgId });
console.log("active_threats count: " + (bc.active_threats?.length || 0));
for (const t of (bc.active_threats || []).slice(0, 5)) {
  console.log("  [" + t.severity + "] " + t.title.slice(0, 80) + " | type=" + t.threat_type);
}

console.log("\n=== Test 5: idempotencia (2da corrida) ===");
const r2 = await runThreatDetection(brandId, orgId);
console.log("Re-run:", JSON.stringify(r2, null, 2));
