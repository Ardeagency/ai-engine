import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

// 1) Estado actual de brand_integrations
const { data: integrations } = await sb.from("brand_integrations")
  .select("id, platform, scope, last_sync_at, updated_at, token_expires_at")
  .eq("brand_container_id", brandId)
  .eq("platform", "facebook");

console.log("=== brand_integrations.facebook ===");
for (const i of integrations || []) {
  console.log("id:", i.id);
  console.log("scope (BD):", JSON.stringify(i.scope));
  console.log("updated_at:", i.updated_at);
  console.log("token_expires_at:", i.token_expires_at);
}

// 2) Llamar /me/permissions con el access_token actual para ver qué scopes Meta concedió
const integ = integrations?.[0];
if (!integ) {
  console.log("\n❌ No hay integración facebook activa.");
  process.exit(1);
}

// Necesito access_token — lo obtengo via el helper interno
const { getIntegrationToken } = await import("./src/lib/integration-token.js");
const tokenInfo = await getIntegrationToken(brandId, orgId, "facebook").catch((e) => null);
if (!tokenInfo?.access_token) {
  console.log("\n❌ No se pudo obtener access_token.");
  process.exit(1);
}

const permsRes = await fetch(`https://graph.facebook.com/v22.0/me/permissions?access_token=${encodeURIComponent(tokenInfo.access_token)}`);
const perms = await permsRes.json();
const granted = (perms.data || []).filter((p) => p.status === "granted").map((p) => p.permission);
const declined = (perms.data || []).filter((p) => p.status !== "granted").map((p) => p.permission + ":" + p.status);

console.log("\n=== /me/permissions (lo que Meta realmente concedió) ===");
console.log("granted:", JSON.stringify(granted));
if (declined.length) console.log("not granted:", JSON.stringify(declined));
console.log("ads_read concedido?", granted.includes("ads_read") ? "✅ SÍ" : "❌ NO");

// 3) Forzar sensor de Ad Library
console.log("\n=== Forzando sensor meta_ad_library_sync ===");
await sb.from("monitoring_triggers").update({ next_run_at: new Date().toISOString() })
  .eq("brand_container_id", brandId).eq("sensor_type", "meta_ad_library_sync");

const t0 = Date.now();
const scraper = await import("./src/services/social-scraper.service.js");
const r = await scraper.runCompetitorScraper();
console.log("Duración:", Date.now() - t0, "ms");
console.log("scraper:", JSON.stringify(r));

// 4) Stats del run
const { data: lastRun } = await sb.from("sensor_runs")
  .select("stats, error_message, status")
  .eq("brand_container_id", brandId)
  .eq("sensor_type", "meta_ad_library_sync")
  .order("started_at", { ascending: false })
  .limit(1);
console.log("\nÚltimo sensor_run:", JSON.stringify(lastRun?.[0]));

// 5) Conteo y samples de competitor_ads
const { count } = await sb.from("competitor_ads")
  .select("*", { count: "exact", head: true })
  .eq("brand_container_id", brandId);
console.log("\n=== competitor_ads total: " + (count || 0) + " ===");

if (count > 0) {
  const { data: ads } = await sb.from("competitor_ads")
    .select("ad_archive_id, copy_text, first_seen_at, last_seen_at, metadata, intelligence_entities!inner(name)")
    .eq("brand_container_id", brandId)
    .order("captured_at", { ascending: false })
    .limit(5);
  console.log("\nÚltimos 5 ads:");
  for (const a of ads || []) {
    console.log("---");
    console.log("page:", a.metadata?.page_name, "| entity:", a.intelligence_entities?.name);
    console.log("ad_id:", a.ad_archive_id, "| first_seen:", a.first_seen_at);
    console.log("source:", a.metadata?.source || "api");
    console.log("copy:", (a.copy_text || "").slice(0, 150).replace(/\n/g, " "));
  }
}
