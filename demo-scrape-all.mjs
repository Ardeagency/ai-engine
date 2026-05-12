/**
 * demo-scrape-all.mjs — corre Apify para todas las entities de Arde y persiste en brand_posts.
 * Uso: node demo-scrape-all.mjs
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runActor } from "./src/lib/apify.client.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ORG_ID = "a1000000-0000-0000-0000-000000000001";
const BRAND_ID = "a3000000-0000-0000-0000-000000000001";

// ── Transformers por plataforma → brand_posts row ────────────────────────────
function tiktokToBrandPost(item, entity) {
  return {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "tiktok",
    profile_handle: entity.target_identifier,
    post_id: String(item.id),
    content: item.text || "",
    media_assets: { video_url: item.webVideoUrl, cover: item.videoMeta?.coverUrl, duration: item.videoMeta?.duration },
    metrics: { plays: item.playCount||0, likes: item.diggCount||0, comments: item.commentCount||0, shares: item.shareCount||0, saves: item.collectCount||0 },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    enrichment: { music: item.musicMeta, author: item.authorMeta, isPinned: item.isPinned, isAd: item.isAd },
    author_display_name: item.authorMeta?.nickName || item.authorMeta?.name,
    mentions: (item.mentions||[]).slice(0,20),
    hashtags: (item.hashtags||[]).map(h => typeof h==='string'?h:h.name).filter(Boolean).slice(0,30),
    followers_snapshot: item.authorMeta?.fans || null,
  };
}

function instagramToBrandPost(item, entity) {
  return {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "instagram",
    profile_handle: entity.target_identifier,
    post_id: String(item.id || item.shortCode),
    content: item.caption || "",
    media_assets: { url: item.url, displayUrl: item.displayUrl, type: item.type, images: item.images, videoUrl: item.videoUrl },
    metrics: { likes: item.likesCount||0, comments: item.commentsCount||0, video_views: item.videoViewCount||0, video_plays: item.videoPlayCount||0 },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    enrichment: { ownerUsername: item.ownerUsername, isSponsored: item.isSponsored, productType: item.productType, location: item.locationName },
    author_display_name: item.ownerFullName,
    mentions: (item.mentions||[]).slice(0,20),
    hashtags: (item.hashtags||[]).slice(0,30),
  };
}

function youtubeToBrandPost(item, entity) {
  return {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "youtube",
    profile_handle: entity.target_identifier,
    post_id: String(item.id || item.url?.split("v=").pop()),
    content: item.title || item.text || "",
    media_assets: { url: item.url, thumbnail: item.thumbnailUrl, duration: item.duration },
    metrics: { views: item.viewCount||0, likes: item.likes||0, comments: item.commentsCount||0 },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    enrichment: { channel: item.channelName, channelUrl: item.channelUrl, isShorts: item.isShorts, uploadDate: item.date },
    author_display_name: item.channelName,
  };
}

function xToBrandPost(item, entity) {
  return {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "x",
    profile_handle: entity.target_identifier,
    post_id: String(item.id || item.tweet_id || item.url?.split("/").pop()),
    content: item.text || item.full_text || "",
    media_assets: { url: item.url, media: item.media || item.entities?.media },
    metrics: { likes: item.favorite_count||item.likeCount||0, replies: item.reply_count||item.replyCount||0, retweets: item.retweet_count||item.retweetCount||0, views: item.view_count||item.viewCount||0 },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    enrichment: { lang: item.lang, isRetweet: item.isRetweet, conversationId: item.conversation_id },
    author_display_name: item.author?.name || item.user?.name,
    hashtags: (item.hashtags||item.entities?.hashtags?.map(h=>h.text)||[]).slice(0,30),
    followers_snapshot: item.author?.followers_count || item.user?.followers_count || null,
  };
}

const TRANSFORMERS = { tiktok: tiktokToBrandPost, instagram: instagramToBrandPost, youtube: youtubeToBrandPost, x: xToBrandPost };

// ── Targets de demo ─────────────────────────────────────────────────────────
// Para cada marca: scrape 2 plataformas (TikTok + Instagram), evitar X/YT por ahora (handles X distintos)
const DEMO_TARGETS = [
  // [entity_name, tiktok_handle, instagram_handle, youtube_handle (channel), x_handle]
  { name: "Red Bull",      tiktok: "redbull",         instagram: "redbull",         youtube: "RedBull",     x: "redbull" },
  { name: "Monster Energy",tiktok: "monsterenergy",   instagram: "monsterenergy",   youtube: "MonsterEnergy", x: "MonsterEnergy" },
  { name: "Celsius Energy",tiktok: "celsiusofficial", instagram: "celsiusofficial", youtube: null, x: null },
  { name: "Liquid Death",  tiktok: "liquiddeath",     instagram: "liquiddeath",     youtube: "LiquidDeath", x: "LiquidDeath" },
];

// ── Main ────────────────────────────────────────────────────────────────────
const stats = { totalRuns: 0, totalItems: 0, totalUsd: 0, totalCredits: 0, byPlatform: {}, errors: [] };

// Lookup entity_ids existentes
const { data: entities } = await sb.from("intelligence_entities")
  .select("id, name, target_identifier, metadata")
  .eq("brand_container_id", BRAND_ID).eq("domain","social").eq("is_active", true);

console.log(`\n🎬 Demo Apify scrape — ${DEMO_TARGETS.length} marcas × hasta 4 plataformas\n`);

for (const target of DEMO_TARGETS) {
  // Find existing entity (cualquier plataforma sirve, usamos el id como ancla)
  const entity = entities.find(e => e.name === target.name);
  if (!entity) { console.log(`⚠️  ${target.name}: entity no encontrada`); continue; }

  for (const platform of ["tiktok", "instagram", "youtube", "x"]) {
    const handle = target[platform];
    if (!handle) continue;
    const transformer = TRANSFORMERS[platform];

    try {
      console.log(`▶ ${target.name} / ${platform} / @${handle}...`);
      const r = await runActor({ organizationId: ORG_ID, urlOrHandle: handle, platform });

      // Persist items
      const rows = r.items.map(it => transformer(it, entity)).filter(r => r.post_id);
      if (rows.length) {
        const { error: upErr } = await sb.from("brand_posts").upsert(rows, { onConflict: "network,post_id", ignoreDuplicates: true });
        if (upErr) console.log(`  ⚠️ upsert: ${upErr.message}`);
      }

      stats.totalRuns++;
      stats.totalItems += r.items.length;
      stats.totalUsd += r.usdCost;
      stats.totalCredits += r.credits;
      stats.byPlatform[platform] = (stats.byPlatform[platform]||0) + r.items.length;

      console.log(`  ✓ ${r.items.length} items | $${r.usdCost.toFixed(4)} = ${r.credits} cr | bal ${r.balanceAfter.toFixed(2)} ${r.cacheHit?"[CACHE HIT]":""}`);
    } catch(e) {
      console.log(`  ✗ ${e.message}`);
      stats.errors.push({ target: target.name, platform, error: e.message });
    }
  }
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("RESUMEN");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`Runs ejecutados:  ${stats.totalRuns}`);
console.log(`Items totales:    ${stats.totalItems}`);
console.log(`USD gastado:      $${stats.totalUsd.toFixed(4)}`);
console.log(`Créditos cobrados: ${stats.totalCredits.toFixed(2)}`);
console.log(`Por plataforma:   ${JSON.stringify(stats.byPlatform)}`);
if (stats.errors.length) console.log(`Errores (${stats.errors.length}):`, stats.errors);
