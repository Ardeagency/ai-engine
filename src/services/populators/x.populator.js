/**
 * x.populator.js — Consumer de X (Twitter) v2.
 *
 * Importa los posts ORGANICOS propios de la marca a `brand_posts`
 * (network='x', post_source='own'), dejando ai_analyzed_at NULL para que el
 * pipeline de sentimiento/analisis existente los recoja. Es el equivalente a
 * lo que el scraper hace para otras redes, pero como fuente AUTORITATIVA (la
 * cuenta autorizada por la marca).
 *
 * El token de 2h (que rota) lo maneja x-rest de forma transparente.
 * Requiere tier de pago en X (Pay Per Use/Basic) para que la lectura devuelva
 * datos; en Free la API no entrega tweets.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import { getMe, getRecentTweets } from "../../lib/x-rest.js";

export class XPopulator extends BasePopulator {
  constructor() { super("x"); }

  subjobSequence() {
    return ["x_sync_posts", "vera_propose_priority_actions"];
  }

  dispatch(missionType) {
    if (missionType === "x_sync_posts")               return this.syncPosts;
    if (missionType === "vera_propose_priority_actions") return this.finishBootstrap;
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
    const user = me?.data || {};
    const userId   = user.id || integ.metadata?.x_user_id || integ.external_account_id;
    const username = user.username || integ.metadata?.username || null;
    if (!userId) throw new Error("x-populator: cannot resolve user id");

    const { tweets, mediaByKey } = await getRecentTweets(integ, userId, { maxPages: 2, perPage: 100 });

    const stats = { tweets_pulled: tweets.length, posts_created: 0, skipped_existing: 0, errors: 0 };
    if (!tweets.length) {
      await supabase.from("brand_integrations")
        .update({ last_sync_at: new Date().toISOString() }).eq("id", brand_integration_id);
      return { ok: true, ...stats, note: "0 tweets (cuenta vacia o tier sin lectura)" };
    }

    // Idempotencia: no re-insertar post_ids ya presentes para esta marca.
    const ids = tweets.map((t) => String(t.id));
    const { data: existing } = await supabase
      .from("brand_posts")
      .select("post_id")
      .eq("brand_container_id", brand_container_id)
      .eq("network", "x")
      .in("post_id", ids);
    const seen = new Set((existing || []).map((r) => String(r.post_id)));

    const rows = [];
    for (const t of tweets) {
      try {
        if (seen.has(String(t.id))) { stats.skipped_existing++; continue; }
        const pm = t.public_metrics || {};
        const ent = t.entities || {};
        const mediaAssets = (t.attachments?.media_keys || [])
          .map((k) => mediaByKey[k])
          .filter(Boolean)
          .map((m) => ({ type: m.type, url: m.url || m.preview_image_url || null }));
        const engagement =
          (pm.like_count || 0) + (pm.retweet_count || 0) + (pm.reply_count || 0) + (pm.quote_count || 0);

        rows.push({
          brand_container_id:  brand_container_id,
          network:             "x",
          post_source:         "own",
          profile_handle:      username,
          author_display_name: user.name || null,
          post_id:             String(t.id),
          content:             t.text || "",
          permalink:           username ? `https://x.com/${username}/status/${t.id}` : null,
          media_assets:        mediaAssets.length ? mediaAssets : null,
          metrics:             pm,
          engagement_total:    engagement,
          hashtags:            (ent.hashtags || []).map((h) => h.tag).filter(Boolean),
          mentions:            (ent.mentions || []).map((m) => m.username).filter(Boolean),
          captured_at:         t.created_at || new Date().toISOString(),
          is_competitor:       false,
          ai_analyzed_at:      null,
        });
      } catch (e) {
        stats.errors++;
        console.error(`x-populator: tweet ${t?.id} map failed:`, e?.message);
      }
    }

    if (rows.length) {
      const { data: inserted, error } = await supabase
        .from("brand_posts").insert(rows).select("id");
      if (error) { stats.errors++; console.error("x-populator: insert error:", error.message); }
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
      .eq("network", "x")
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
