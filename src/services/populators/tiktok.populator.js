/**
 * tiktok.populator.js — Consumer de TikTok API v2.
 *
 * Importa los videos ORGANICOS propios de la marca a `brand_posts`
 * (network='tiktok', post_source='own'), dejando ai_analyzed_at NULL para que
 * el pipeline de sentimiento/analisis existente los recoja. Equivale a lo que
 * el scraper hace para otras redes, pero como fuente AUTORITATIVA (la cuenta
 * autorizada por la marca).
 *
 * El token de 24h (que rota) lo maneja tiktok-rest de forma transparente.
 * Requiere los scopes user.info.basic + video.list. El cierre usa un mission
 * propio (`tiktok_finish_bootstrap`) y NO el generico `vera_propose_priority_
 * actions` (ese colisiona en el MISSION_INDEX entre varias plataformas).
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import { getMe, getRecentVideos } from "../../lib/tiktok-rest.js";

function extractTags(text, prefix) {
  if (!text) return [];
  const re = prefix === "#" ? /#([\p{L}\p{N}_]+)/gu : /@([\p{L}\p{N}_.]+)/gu;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return [...new Set(out)];
}

export class TikTokPopulator extends BasePopulator {
  constructor() { super("tiktok"); }

  subjobSequence() {
    return ["tiktok_sync_posts", "tiktok_finish_bootstrap"];
  }

  dispatch(missionType) {
    if (missionType === "tiktok_sync_posts")      return this.syncPosts;
    if (missionType === "tiktok_finish_bootstrap") return this.finishBootstrap;
    return null;
  }

  async bootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload || {};
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();
    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:     "running",
        bootstrap_started_at: new Date().toISOString(),
        metadata:             { ...(cur?.metadata || {}), populator_status: "running" },
      })
      .eq("id", brand_integration_id);

    return this.enqueueSubjobs(job);
  }

  async syncPosts(job) {
    const { brand_integration_id, brand_container_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    const me = await getMe(integ);
    const user = me?.data?.user || {};
    const username = user.username || integ.metadata?.username || null;

    const { videos } = await getRecentVideos(integ, { maxPages: 2, perPage: 20 });

    const stats = { videos_pulled: videos.length, posts_created: 0, skipped_existing: 0, errors: 0 };
    if (!videos.length) {
      await supabase.from("brand_integrations")
        .update({ last_sync_at: new Date().toISOString() }).eq("id", brand_integration_id);
      return { ok: true, ...stats, note: "0 videos (cuenta vacia o sin permisos de lectura)" };
    }

    // Idempotencia: no re-insertar post_ids ya presentes para esta marca.
    const ids = videos.map((v) => String(v.id));
    const { data: existing } = await supabase
      .from("brand_posts")
      .select("post_id")
      .eq("brand_container_id", brand_container_id)
      .eq("network", "tiktok")
      .in("post_id", ids);
    const seen = new Set((existing || []).map((r) => String(r.post_id)));

    const rows = [];
    for (const v of videos) {
      try {
        if (seen.has(String(v.id))) { stats.skipped_existing++; continue; }
        const desc = v.video_description || v.title || "";
        const metrics = {
          like_count:    v.like_count    ?? 0,
          comment_count: v.comment_count ?? 0,
          share_count:   v.share_count   ?? 0,
          view_count:    v.view_count    ?? 0,
        };
        const capturedAt = v.create_time
          ? new Date(Number(v.create_time) * 1000).toISOString()
          : new Date().toISOString();
        rows.push({
          brand_container_id:  brand_container_id,
          network:             "tiktok",
          post_source:         "own",
          profile_handle:      username,
          author_display_name: user.display_name || null,
          post_id:             String(v.id),
          content:             desc,
          permalink:           v.share_url || null,
          media_assets:        v.cover_image_url ? [{ type: "image", url: v.cover_image_url }] : null,
          metrics:             metrics,
          hashtags:            extractTags(desc, "#"),
          mentions:            extractTags(desc, "@"),
          captured_at:         capturedAt,
          is_competitor:       false,
          ai_analyzed_at:      null,
        });
      } catch (e) {
        stats.errors++;
        console.error(`tiktok-populator: video ${v?.id} map failed:`, e?.message);
      }
    }

    if (rows.length) {
      const { data: inserted, error } = await supabase
        .from("brand_posts").insert(rows).select("id");
      if (error) { stats.errors++; console.error("tiktok-populator: insert error:", error.message); }
      else stats.posts_created = inserted.length;
    }

    await supabase.from("brand_integrations")
      .update({ last_sync_at: new Date().toISOString() }).eq("id", brand_integration_id);

    return { ok: true, ...stats, handle: username };
  }

  async finishBootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload;
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");

    const { count } = await supabase
      .from("brand_posts")
      .select("*", { count: "exact", head: true })
      .eq("brand_container_id", brand_container_id)
      .eq("network", "tiktok")
      .eq("post_source", "own");

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();
    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:       "completed",
        bootstrap_completed_at: new Date().toISOString(),
        metadata:               { ...(cur?.metadata || {}), populator_status: "completed" },
      })
      .eq("id", brand_integration_id);

    return { ok: true, status: "bootstrap_completed", posts_indexed: count || 0 };
  }
}
