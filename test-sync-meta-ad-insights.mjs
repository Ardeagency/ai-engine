import { syncMetaAdInsightsForOrg } from "./src/services/sync-meta-ad-insights.service.js";
const orgId = "a1000000-0000-0000-0000-000000000001";
console.log("Running backfill with date_preset=maximum for IGNIS...");
const t0 = Date.now();
try {
  const result = await syncMetaAdInsightsForOrg(orgId, { datePreset: "maximum" });
  console.log("Stats:", JSON.stringify(result, null, 2));
  console.log("Duration:", ((Date.now()-t0)/1000).toFixed(1)+"s");
} catch (e) {
  console.error("FAILED:", e.message);
  console.error(e.stack);
}
