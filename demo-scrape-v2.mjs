/**
 * demo-scrape-v2.mjs — re-scrapea con transformers expandidos.
 *   - Hace upsert solo de campos crudos (sin enrichment ni media_assets si ya tiene description)
 *   - PATCH separado para enrichment.platform_native.{network} (preserva descripciones del analyzer)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runActor } from "./src/lib/apify.client.js";
import { TRANSFORMERS } from "./demo-transformers.mjs";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ORG_ID = "a1000000-0000-0000-0000-000000000001";
const BRAND_ID = "a3000000-0000-0000-0000-000000000001";

const TARGETS = [
  { name: "Red Bull",       tiktok: "redbull",         instagram: "redbull",         youtube: "RedBull",       x: "redbull" },
  { name: "Monster Energy", tiktok: "monsterenergy",   instagram: "monsterenergy",   youtube: "MonsterEnergy", x: "MonsterEnergy" },
  { name: "Celsius Energy", tiktok: "celsiusofficial", instagram: "celsiusofficial", youtube: null,            x: null },
  { name: "Liquid Death",   tiktok: "liquiddeath",     instagram: "liquiddeath",     youtube: "LiquidDeath",   x: "LiquidDeath" },
];

async function upsertWithMerge(row, platformNative, network) {
  // 1. Upsert base — devolvemos id al insertar/actualizar
  // Usar onConflict (network, post_id) — ya hay índice único
  const { data: existing } = await sb.from("brand_posts")
    .select("id, enrichment, media_assets")
    .eq("network", network).eq("post_id", row.post_id).maybeSingle();

  // Preservar media_assets.description si ya existe (Sonnet 4.6)
  if (existing?.media_assets && (existing.media_assets.description || existing.media_assets.image_extraction_error)) {
    // No tocar media_assets — preservar descripciones
    delete row.media_assets;
  }

  const { error: upErr } = await sb.from("brand_posts")
    .upsert(row, { onConflict: "network,post_id" });
  if (upErr) return { error: upErr.message };

  // SELECT explícito (evita error PostgREST cuando upsert returns multiple/none)
  const { data: rows, error: selErr } = await sb.from("brand_posts")
    .select("id, enrichment").eq("network", network).eq("post_id", row.post_id).limit(1);
  if (selErr || !rows?.length) return { error: `select after upsert: ${selErr?.message || "no_rows"}` };
  const upserted = rows[0];

  // 2. Merge enrichment.platform_native.{network} (preserva otras claves del analyzer)
  const newEnrichment = { ...(upserted.enrichment || {}) };
  newEnrichment.platform_native = newEnrichment.platform_native || {};
  newEnrichment.platform_native[network] = platformNative;

  const { error: patchErr } = await sb.from("brand_posts")
    .update({ enrichment: newEnrichment, updated_at: new Date().toISOString() })
    .eq("id", upserted.id);
  if (patchErr) return { error: `patch: ${patchErr.message}` };

  return { ok: true, post_id: upserted.id };
}

const stats = { runs: 0, items: 0, ok: 0, errs: 0, usd: 0, cr: 0, byNetwork: {} };
const { data: entities } = await sb.from("intelligence_entities")
  .select("id, name, target_identifier")
  .eq("brand_container_id", BRAND_ID).eq("is_active", true);

console.log(`\n🎬 Demo v2 — re-scrape con transformers expandidos\n`);

for (const t of TARGETS) {
  const entity = entities.find(e => e.name === t.name);
  if (!entity) { console.log(`⚠️ ${t.name}: entity no encontrada`); continue; }

  for (const network of ["tiktok", "instagram", "youtube", "x"]) {
    const handle = t[network];
    if (!handle) continue;
    const transformer = TRANSFORMERS[network];
    if (!transformer) continue;

    try {
      const r = await runActor({ organizationId: ORG_ID, urlOrHandle: handle, platform: network });
      stats.runs++;
      stats.usd += r.usdCost || 0;
      stats.cr += r.credits || 0;

      let okCount = 0, errCount = 0;
      for (const item of r.items) {
        const { basePost, platformNative } = transformer(item, entity);
        if (!basePost.post_id || basePost.post_id === "undefined") { errCount++; continue; }
        const res = await upsertWithMerge(basePost, platformNative, network);
        if (res.ok) okCount++;
        else { errCount++; if (errCount <= 2) console.log(`  ⚠ ${res.error?.slice(0, 100)}`); }
      }
      stats.items += r.items.length; stats.ok += okCount; stats.errs += errCount;
      stats.byNetwork[network] = (stats.byNetwork[network] || 0) + okCount;
      console.log(`✓ ${t.name}/${network}/@${handle}: ${okCount} OK, ${errCount} err | $${(r.usdCost||0).toFixed(4)} ${r.cacheHit ? "[CACHE]" : ""}`);
    } catch (e) {
      console.log(`✗ ${t.name}/${network}: ${e.message?.slice(0, 100)}`);
      stats.errs++;
    }
  }
}

console.log("\n═══════════════════════════════");
console.log("RESUMEN");
console.log(`Runs:     ${stats.runs}`);
console.log(`Items:    ${stats.items} (${stats.ok} OK, ${stats.errs} errs)`);
console.log(`Costo:    $${stats.usd.toFixed(4)} = ${stats.cr.toFixed(2)} créditos`);
console.log(`Network:  ${JSON.stringify(stats.byNetwork)}`);
