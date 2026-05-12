import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runActor } from "./src/lib/apify.client.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ORG = "a1000000-0000-0000-0000-000000000001";
const BRAND = "a3000000-0000-0000-0000-000000000001";

function xToBP(item, entity) {
  return {
    brand_container_id: BRAND,
    entity_id: entity.id,
    network: "x",
    profile_handle: entity.target_identifier,
    post_id: String(item.id),
    content: item.text || "",
    media_assets: { url: item.url, media: item.extendedEntities?.media || item.entities?.media },
    metrics: { likes: item.likeCount||0, replies: item.replyCount||0, retweets: item.retweetCount||0, views: item.viewCount||0, bookmarks: item.bookmarkCount||0, quotes: item.quoteCount||0 },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    enrichment: { lang: item.lang, isRetweet: item.isRetweet, isReply: item.isReply, isQuote: item.isQuote, conversationId: item.conversationId, scraper:"apify:kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest" },
    author_display_name: item.author?.name || null,
    hashtags: (item.entities?.hashtags||[]).map(h=>h.text).slice(0,30),
    mentions: (item.entities?.user_mentions||[]).map(m=>m.screen_name).slice(0,20),
    followers_snapshot: item.author?.followers || null,
  };
}

const HANDLES = [{name:"Red Bull",h:"redbull"},{name:"Monster Energy",h:"MonsterEnergy"},{name:"Liquid Death",h:"LiquidDeath"}];
const {data: entities} = await sb.from("intelligence_entities").select("id,name,target_identifier").eq("brand_container_id",BRAND).eq("is_active",true);

let total=0, totalCr=0;
for (const t of HANDLES) {
  const e = entities.find(x => x.name===t.name);
  try {
    const r = await runActor({organizationId:ORG, urlOrHandle:t.h, platform:"x"});
    const rows = r.items.map(it => xToBP(it, e));
    const {error} = await sb.from("brand_posts").upsert(rows, {onConflict:"network,post_id", ignoreDuplicates:false});
    if (error) console.log(`✗ ${t.name}: ${error.message}`);
    else { console.log(`✓ ${t.name}/x: ${r.items.length} items, $${r.usdCost} = ${r.credits} cr`); total += r.items.length; totalCr += r.credits; }
  } catch(e) { console.log(`✗ ${t.name}: ${e.message}`); }
}
console.log(`TOTAL: ${total} items, ${totalCr.toFixed(2)} créditos`);
