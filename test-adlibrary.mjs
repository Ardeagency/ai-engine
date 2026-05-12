import { createClient } from "@supabase/supabase-js";
import { getMetaAdLibrary } from "./src/tools/social.tools.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

console.log("=== Test directo: getMetaAdLibrary para 'Red Bull' en CO ===");
try {
  const r = await getMetaAdLibrary({
    brandContainerId: brandId,
    organizationId:   orgId,
    searchTerms:      "Red Bull",
    country:          "CO",
    limit:            20,
  });
  console.log("total_ads encontrados: " + r.total_ads);
  if (r.ads.length) {
    const sample = r.ads[0];
    console.log("\nMuestra del primer ad:");
    console.log("  page_name:        " + sample.page_name);
    console.log("  page_id:          " + sample.page_id);
    console.log("  publisher_platforms: " + JSON.stringify(sample.publisher_platforms));
    console.log("  delivery_start:   " + sample.delivery_start);
    console.log("  delivery_stop:    " + sample.delivery_stop);
    console.log("  snapshot_url:     " + sample.snapshot_url);
    console.log("  creative_bodies:  " + JSON.stringify(sample.creative_bodies?.slice(0,2)).slice(0, 250));
    console.log("  languages:        " + JSON.stringify(sample.languages));
  }
  console.log("\nSample de page_names únicos:");
  const uniq = [...new Set(r.ads.map((a) => a.page_name))];
  for (const n of uniq.slice(0, 8)) console.log("  - " + n);
} catch (e) {
  console.log("ERROR: " + e.message);
  if (e.needsReauth) console.log("(scope ads_read posiblemente requerido)");
}

console.log("\n\n=== Test sensor: runMetaAdLibrarySync via scraper ===");
// Crear/forzar trigger
const { data: existing } = await sb.from("monitoring_triggers").select("id").eq("brand_container_id", brandId).eq("sensor_type", "meta_ad_library_sync").is("entity_id", null).maybeSingle();
if (existing?.id) {
  await sb.from("monitoring_triggers").update({ next_run_at: new Date().toISOString() }).eq("id", existing.id);
  console.log("trigger existente forzado a now: " + existing.id);
} else {
  const { data: ins } = await sb.from("monitoring_triggers").insert({
    brand_container_id: brandId,
    organization_id:    orgId,
    entity_id:          null,
    sensor_type:        "meta_ad_library_sync",
    cadence:            "daily",
    cadence_value:      "1",
    priority:           5,
    status:             "active",
    next_run_at:        new Date().toISOString(),
    config:             { auto_created_by: "test-adlibrary" },
  }).select("id").maybeSingle();
  console.log("trigger creado: " + ins?.id);
}

const scraper = await import("./src/services/social-scraper.service.js");
const r = await scraper.runCompetitorScraper();
console.log("scraper:", JSON.stringify(r));

const { data: lastRun } = await sb.from("sensor_runs").select("stats, error_message").eq("brand_container_id", brandId).eq("sensor_type", "meta_ad_library_sync").order("started_at", {ascending:false}).limit(1);
console.log("\nÚltimo sensor_run:", JSON.stringify(lastRun?.[0]));

const { count } = await sb.from("competitor_ads").select("*", {count:"exact",head:true}).eq("brand_container_id", brandId);
console.log("\ncompetitor_ads total: " + (count || 0));

const { data: sample } = await sb.from("competitor_ads").select("ad_archive_id, copy_text, first_seen_at, metadata, intelligence_entities!inner(name)").eq("brand_container_id", brandId).limit(5);
for (const a of sample || []) {
  console.log("---");
  console.log("page=" + a.metadata?.page_name + " | entity=" + a.intelligence_entities?.name);
  console.log("ad_id=" + a.ad_archive_id + " | first_seen=" + a.first_seen_at);
  console.log("copy: " + (a.copy_text || "").slice(0, 120).replace(/\n/g, " "));
}
