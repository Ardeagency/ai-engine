/**
 * backfill_media_format.mjs — enriquece el media_assets de posts PROPIOS con lo
 * que hace falta para RENDERIZARLOS con su forma real.
 *
 * Dos huecos que la miniatura sola no cubre:
 *
 * 1) FORMATO. La portada que devuelve TikTok viene recortada por ellos a
 *    300x400 (`tplv-tiktokx-cropcenter`), asi que el frontend —que adopta el
 *    ratio de la imagen— pintaba un reel 9:16 casi cuadrado. `video/query` si
 *    expone `width`/`height` reales: se guardan y mandan ellos.
 *    De paso se guarda `embed_link`, el player limpio de TikTok
 *    (`player/v1/<id>`), distinto del `/embed/v2/` que arrastra footer y
 *    "videos relacionados" de otras marcas.
 *
 * 2) CARRUSEL. Un CAROUSEL_ALBUM se guardaba con UNA sola imagen, asi que se
 *    veia como un post simple. El Graph devuelve `children{media_url,...}`:
 *    se archivan todos a R2 y quedan en `media_assets.items`.
 *
 * Uso:  node scripts/backfill_media_format.mjs [--dry] [--container=<uuid>]
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { archiveThumb } from "/root/ai-engine/src/services/media-archive.service.js";
import { decryptIntegrationRow } from "/root/ai-engine/src/lib/integration-token-vault.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DRY = process.argv.includes("--dry");
const ONLY = (process.argv.find((a) => a.startsWith("--container=")) || "").split("=")[1] || null;
const GRAPH = "https://graph.facebook.com/v22.0";
const esObjeto = (v) => v && typeof v === "object" && !Array.isArray(v);

async function metaToken(bcId) {
  const { data } = await sb.from("brand_integrations")
    .select("access_token, encryption_iv, metadata")
    .eq("brand_container_id", bcId).eq("platform", "facebook").eq("is_active", true).maybeSingle();
  if (!data) return null;
  decryptIntegrationRow(data);
  return data.access_token;
}

async function tiktokIntegration(bcId) {
  const { data } = await sb.from("brand_integrations")
    .select("id, platform, access_token, refresh_token, token_expires_at, encryption_iv, metadata, brand_container_id")
    .eq("brand_container_id", bcId).eq("platform", "tiktok").eq("is_active", true).maybeSingle();
  if (!data) return null;
  decryptIntegrationRow(data);
  return data;
}

let q = sb.from("brand_posts")
  .select("id, brand_container_id, network, post_id, media_assets, captured_at")
  .eq("post_source", "own").order("captured_at", { ascending: false });
if (ONLY) q = q.eq("brand_container_id", ONLY);
const { data: todos, error } = await q;
if (error) { console.error("consulta fallo:", error.message); process.exit(1); }

const porContainer = new Map();
for (const p of (todos || [])) {
  if (!p.post_id) continue;
  if (!porContainer.has(p.brand_container_id)) porContainer.set(p.brand_container_id, []);
  porContainer.get(p.brand_container_id).push(p);
}

const total = { tkFormato: 0, carruseles: 0, piezas: 0, saltados: 0, errores: 0 };

for (const [bcId, posts] of porContainer) {
  console.log(`\n── container ${bcId}${DRY ? "  [DRY]" : ""}`);

  // ── TikTok: dimensiones reales + player limpio ────────────────────────────
  const tks = posts.filter((p) => p.network === "tiktok" && !(esObjeto(p.media_assets) && p.media_assets.width));
  if (tks.length) {
    const integ = await tiktokIntegration(bcId);
    if (!integ) { console.log(`  tiktok: ${tks.length} pendientes pero sin integracion activa`); }
    else {
      const ids = tks.map((p) => String(p.post_id));
      const info = new Map();
      for (let i = 0; i < ids.length; i += 20) {
        const r = await fetch("https://open.tiktokapis.com/v2/video/query/?fields=id,width,height,duration,embed_link,cover_image_url", {
          method: "POST",
          headers: { Authorization: `Bearer ${integ.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ filters: { video_ids: ids.slice(i, i + 20) } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { console.warn(`  tiktok query: HTTP ${r.status}`); continue; }
        for (const v of j?.data?.videos || []) info.set(String(v.id), v);
      }
      for (const p of tks) {
        const v = info.get(String(p.post_id));
        if (!v || !v.width || !v.height) { total.saltados++; continue; }
        const previo = esObjeto(p.media_assets) ? p.media_assets : {};
        const next = { ...previo, width: v.width, height: v.height };
        if (v.duration) next.duration = v.duration;
        if (v.embed_link) next.embed_link = v.embed_link;
        if (DRY) { total.tkFormato++; continue; }
        const { error: e } = await sb.from("brand_posts").update({ media_assets: next, updated_at: new Date().toISOString() }).eq("id", p.id);
        if (e) { total.errores++; console.log(`  ✗ tiktok ${p.post_id}: ${e.message}`); continue; }
        total.tkFormato++;
      }
      console.log(`  tiktok: ${total.tkFormato} con formato real (${v_ratio(info)})`);
    }
  }

  // ── Instagram: piezas del carrusel ────────────────────────────────────────
  const carr = posts.filter((p) => p.network === "instagram"
    && esObjeto(p.media_assets)
    && /CAROUSEL/i.test(String(p.media_assets.media_type || ""))
    && !Array.isArray(p.media_assets.items));
  if (carr.length) {
    const tok = await metaToken(bcId);
    if (!tok) console.log(`  instagram: ${carr.length} carruseles pero sin integracion`);
    else for (const p of carr) {
      const r = await fetch(`${GRAPH}/${p.post_id}?fields=id,children{id,media_type,media_url,thumbnail_url}&access_token=${tok}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { total.errores++; console.log(`  ✗ ig ${p.post_id}: ${String(j?.error?.message || r.status).slice(0, 80)}`); continue; }
      const hijos = j?.children?.data || [];
      if (hijos.length < 2) { total.saltados++; continue; }
      if (DRY) { total.carruseles++; total.piezas += hijos.length; console.log(`  · ig ${p.post_id} — ${hijos.length} piezas`); continue; }
      const items = [];
      for (let n = 0; n < hijos.length; n++) {
        const c = hijos[n];
        const esVideo = String(c.media_type || "").toUpperCase() === "VIDEO";
        // De un video del carrusel se archiva su POSTER, no el master.
        const src = esVideo ? (c.thumbnail_url || null) : (c.media_url || c.thumbnail_url || null);
        if (!src) continue;
        const archived = await archiveThumb({
          mediaAssets: { display_url: src }, brandContainerId: bcId,
          network: "instagram", postId: `${p.post_id}_${n}`,
        });
        items.push({ url: archived || src, type: esVideo ? "video" : "image", archived: Boolean(archived) });
      }
      if (items.length < 2) { total.saltados++; continue; }
      const next = { ...p.media_assets, items };
      const { error: e } = await sb.from("brand_posts").update({ media_assets: next, updated_at: new Date().toISOString() }).eq("id", p.id);
      if (e) { total.errores++; console.log(`  ✗ ig ${p.post_id} update: ${e.message}`); continue; }
      total.carruseles++; total.piezas += items.length;
      console.log(`  ✓ ig ${p.post_id} — ${items.length} piezas archivadas`);
    }
  }
}

function v_ratio(info) {
  const v = [...info.values()][0];
  return v ? `${v.width}x${v.height}` : "-";
}

console.log(`\ntiktok con formato: ${total.tkFormato} | carruseles: ${total.carruseles} (${total.piezas} piezas) | saltados: ${total.saltados} | errores: ${total.errores}`);
