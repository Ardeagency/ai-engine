import { createClient } from "@supabase/supabase-js";
import { scrapeAdLibraryPublic } from "./src/services/advanced-scraper.service.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";

console.log("=== TEST 1: scrapeAdLibraryPublic directo (Red Bull, CO) ===");
const t0 = Date.now();
try {
  const r = await scrapeAdLibraryPublic({ searchTerms: "Red Bull", country: "CO", limit: 25, maxScrolls: 3 });
  const dt = Date.now() - t0;
  console.log(`Duración: ${dt}ms | ads encontrados: ${r.ads?.length || 0}`);
  if (r.ads?.length) {
    const sample = r.ads[0];
    console.log("\nSample ad:");
    console.log(`  ad_archive_id: ${sample.ad_archive_id}`);
    console.log(`  page_name: ${sample.page_name}`);
    console.log(`  page_id: ${sample.page_id}`);
    console.log(`  publisher_platforms: ${JSON.stringify(sample.publisher_platforms)}`);
    console.log(`  delivery_start: ${sample.delivery_start}`);
    console.log(`  snapshot_url: ${sample.snapshot_url}`);
    console.log(`  creative_bodies: ${JSON.stringify(sample.creative_bodies?.slice(0, 1)).slice(0, 200)}`);
    console.log("\nUnique pages:");
    const uniq = [...new Set(r.ads.map((a) => a.page_name).filter(Boolean))];
    for (const n of uniq.slice(0, 10)) console.log(`  - ${n}`);
  } else if (r.debug_samples) {
    console.log("\nNo ads detectados. Sample raw URL:", r.debug_samples?.[0]?.url);
    console.log("First 500 chars:", r.debug_samples?.[0]?.sample?.slice(0, 500));
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
}

console.log("\n=== TEST 2: sensor full cycle (con fallback automático) ===");
await sb.from("monitoring_triggers").update({ next_run_at: new Date().toISOString() })
  .eq("brand_container_id", brandId).eq("sensor_type", "meta_ad_library_sync");
const m = await import("./src/services/social-scraper.service.js");
const r2 = await m.runCompetitorScraper();
console.log("scraper:", JSON.stringify(r2));
const { data: lr } = await sb.from("sensor_runs").select("stats").eq("brand_container_id", brandId).eq("sensor_type", "meta_ad_library_sync").order("started_at",{ascending:false}).limit(1);
console.log("Stats:", JSON.stringify(lr?.[0]?.stats));
const { count } = await sb.from("competitor_ads").select("*",{count:"exact",head:true}).eq("brand_container_id", brandId);
console.log("competitor_ads total: " + (count||0));
if (count) {
  const { data: ads } = await sb.from("competitor_ads").select("ad_archive_id, copy_text, metadata").eq("brand_container_id", brandId).limit(5);
  for (const a of ads) {
    console.log(`  [${a.metadata?.source || "api"}] ${a.metadata?.page_name} — ${a.ad_archive_id}`);
    console.log(`    ${(a.copy_text || "").slice(0, 100).replace(/\n/g, " ")}`);
  }
}
