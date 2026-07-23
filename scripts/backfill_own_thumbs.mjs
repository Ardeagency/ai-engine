/**
 * backfill_own_thumbs.mjs — reconstruye la miniatura de los posts PROPIOS
 * pidiendosela a la API de la integracion, POST POR POST.
 *
 * Distinto de backfill_thumbs.mjs, que es oportunista: aquel reintenta la URL
 * del CDN que ya esta guardada y solo salva lo que aun no caduco. Este NO
 * depende de esa URL — vuelve a preguntarle a Meta o a TikTok por el id del
 * post, y ambas APIs re-firman una URL fresca sin importar la edad de la pieza
 * (verificado en vivo con un post de Facebook de 2022 y videos de feb-2024).
 *
 * Por que hace falta: los sensores periodicos solo revisitan una ventana —
 * `meta_posts` los ~100 mas recientes por red, el populator de TikTok los 40
 * mas recientes — y ademas `_rescueOwnThumb` empata por `entity_id`, asi que
 * una fila con la entidad en NULL es invisible para el. Lo que cae fuera de esa
 * ventana o quedo huerfano no se rescata NUNCA. Esto lo cierra de raiz.
 *
 * Tambien normaliza el `media_assets` en forma array cruda [{url,type}] — la
 * que dejaron los writers viejos y que ningun lector consumia.
 *
 * Uso:  node scripts/backfill_own_thumbs.mjs [--dry] [--anclar] [--container=<uuid>]
 *         --dry        no escribe: solo informa que haria
 *         --anclar     ademas fija entity_id en las filas Meta huerfanas, para
 *                      que el sensor diario las vea de aqui en adelante
 *         --container  limita a un brand_container
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { archiveThumb } from "/root/ai-engine/src/services/media-archive.service.js";
import { decryptIntegrationRow } from "/root/ai-engine/src/lib/integration-token-vault.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DRY = process.argv.includes("--dry");
const ANCLAR = process.argv.includes("--anclar");
const ONLY = (process.argv.find((a) => a.startsWith("--container=")) || "").split("=")[1] || null;
const GRAPH = "https://graph.facebook.com/v22.0";

const esObjeto = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Token de usuario (Instagram) y de pagina (Facebook) de la integracion Meta. */
async function metaTokens(bcId) {
  const { data } = await sb.from("brand_integrations")
    .select("access_token, encryption_iv, metadata")
    .eq("brand_container_id", bcId).eq("platform", "facebook").eq("is_active", true).maybeSingle();
  if (!data) return null;
  decryptIntegrationRow(data);
  const md = data.metadata || {};
  const pages = Array.isArray(md.pages) ? md.pages : [];
  // El endpoint de un post de PAGINA exige el token de la pagina; el token de
  // usuario devuelve (#10) pages_read_engagement. Instagram si acepta el de usuario.
  const page = pages.find((p) => String(p.id) === String(md.selected_page_id)) || pages[0];
  return { user: data.access_token, page: page?.access_token || data.access_token };
}

async function metaThumb(net, postId, toks) {
  const esIg = net === "instagram";
  const fields = esIg ? "id,media_url,thumbnail_url,permalink,media_type"
                      : "id,full_picture,picture,permalink_url";
  const tok = esIg ? toks.user : toks.page;
  const r = await fetch(`${GRAPH}/${postId}?fields=${fields}&access_token=${tok}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return { err: String(j?.error?.message || `HTTP ${r.status}`).slice(0, 110) };
  // En un video de IG `media_url` es el archivo de video, no una imagen:
  // la miniatura es `thumbnail_url`. Archivar el master seria caro e inutil.
  const esVideo = String(j.media_type || "").toUpperCase() === "VIDEO";
  const url = (esVideo ? j.thumbnail_url : j.media_url) || j.thumbnail_url || j.media_url
    || j.full_picture || j.picture || null;
  if (!url) return { err: "sin imagen en la respuesta" };
  return { url, permalink: j.permalink || j.permalink_url || null, mediaType: j.media_type || null };
}

/** TikTok acepta hasta 20 ids por llamada; devuelve Map(id -> {url, permalink}). */
async function tiktokThumbs(bcId, ids) {
  const out = new Map();
  const { data } = await sb.from("brand_integrations")
    .select("id, platform, access_token, refresh_token, token_expires_at, encryption_iv, metadata, brand_container_id")
    .eq("brand_container_id", bcId).eq("platform", "tiktok").eq("is_active", true).maybeSingle();
  if (!data) return out;
  decryptIntegrationRow(data);
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const r = await fetch("https://open.tiktokapis.com/v2/video/query/?fields=id,cover_image_url,share_url", {
      method: "POST",
      headers: { Authorization: `Bearer ${data.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { video_ids: lote } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn(`  tiktok query lote ${i / 20 + 1}: HTTP ${r.status} ${JSON.stringify(j?.error || {}).slice(0, 120)}`); continue; }
    for (const v of j?.data?.videos || []) {
      if (v.cover_image_url) out.set(String(v.id), { url: v.cover_image_url, permalink: v.share_url || null });
    }
  }
  return out;
}

// ── 1. Posts propios sin copia permanente ───────────────────────────────────
let q = sb.from("brand_posts")
  .select("id, brand_container_id, network, post_id, media_assets, entity_id, captured_at")
  .eq("post_source", "own")
  .order("captured_at", { ascending: false });
if (ONLY) q = q.eq("brand_container_id", ONLY);
const { data: todos, error } = await q;
if (error) { console.error("consulta fallo:", error.message); process.exit(1); }

const faltan = (todos || []).filter((p) => p.post_id && !(esObjeto(p.media_assets) && p.media_assets.archived_url));
console.log(`posts propios sin copia en R2: ${faltan.length} de ${todos.length}${DRY ? "  [DRY RUN]" : ""}`);

const porContainer = new Map();
for (const p of faltan) {
  if (!porContainer.has(p.brand_container_id)) porContainer.set(p.brand_container_id, []);
  porContainer.get(p.brand_container_id).push(p);
}

const total = { ok: 0, sinApi: 0, sinImagen: 0, falloR2: 0, anclados: 0 };

for (const [bcId, posts] of porContainer) {
  console.log(`\n── container ${bcId} — ${posts.length} posts`);
  const toks = await metaTokens(bcId);
  const idsTk = posts.filter((p) => p.network === "tiktok").map((p) => String(p.post_id));
  const coversTk = idsTk.length ? await tiktokThumbs(bcId, idsTk) : new Map();
  if (idsTk.length) console.log(`  tiktok: ${coversTk.size}/${idsTk.length} portadas frescas`);

  // Entidad que usa el sensor meta_posts de este container: es la que deja
  // visibles las filas para `_rescueOwnThumb` de ahi en adelante.
  let entidadMeta = null;
  if (ANCLAR) {
    const { data: t } = await sb.from("monitoring_triggers")
      .select("entity_id").eq("brand_container_id", bcId).eq("sensor_type", "meta_posts")
      .not("entity_id", "is", null).maybeSingle();
    entidadMeta = t?.entity_id || null;
  }

  for (const p of posts) {
    const net = String(p.network || "").toLowerCase();
    let res;
    if (net === "tiktok") {
      const c = coversTk.get(String(p.post_id));
      res = c || { err: "la API no devolvio ese video" };
    } else if (net === "instagram" || net === "facebook") {
      if (!toks) { total.sinApi++; continue; }
      res = await metaThumb(net, p.post_id, toks);
    } else { total.sinApi++; continue; }

    if (res.err || !res.url) { total.sinImagen++; console.log(`  ✗ ${net} ${p.post_id} — ${res.err || "sin url"}`); continue; }
    if (DRY) { total.ok++; console.log(`  · ${net} ${p.post_id} — url fresca OK`); continue; }

    const assets = net === "tiktok" ? { cover_image: res.url } : { display_url: res.url };
    const archived = await archiveThumb({
      mediaAssets: assets, brandContainerId: bcId, network: net, postId: String(p.post_id),
    });
    if (!archived) { total.falloR2++; console.log(`  ✗ ${net} ${p.post_id} — R2 no respondio`); continue; }

    // La forma array no aporta nada que conservar; la forma objeto SI trae la
    // descripcion de vision, que costo un LLM y no se puede perder.
    const previo = esObjeto(p.media_assets) ? p.media_assets : {};
    const next = { ...previo, ...assets, archived_url: archived };
    if (res.permalink && !next.permalink) next.permalink = res.permalink;
    if (res.mediaType && !next.media_type) next.media_type = res.mediaType;
    delete next.image_extraction_error;

    const patch = { media_assets: next, updated_at: new Date().toISOString() };
    if (ANCLAR && entidadMeta && !p.entity_id && net !== "tiktok") { patch.entity_id = entidadMeta; total.anclados++; }
    const { error: uErr } = await sb.from("brand_posts").update(patch).eq("id", p.id);
    if (uErr) { total.falloR2++; console.log(`  ✗ ${net} ${p.post_id} — update: ${uErr.message}`); continue; }
    total.ok++;
    console.log(`  ✓ ${net} ${p.post_id}`);
  }
}

console.log(`\nrescatados: ${total.ok} | sin imagen en la API: ${total.sinImagen} | sin integracion: ${total.sinApi} | fallo R2/update: ${total.falloR2} | entity_id anclados: ${total.anclados}`);
