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
import { normalizeMetrics } from "../../lib/platform-metrics.js";
import { archiveThumb } from "../media-archive.service.js";
import { triggerMediaAnalysis } from "../media-analysis.service.js";

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

    const stats = { videos_pulled: videos.length, posts_created: 0, skipped_existing: 0, rescued: 0, errors: 0 };
    if (!videos.length) {
      await supabase.from("brand_integrations")
        .update({ last_sync_at: new Date().toISOString() }).eq("id", brand_integration_id);
      return { ok: true, ...stats, note: "0 videos (cuenta vacia o sin permisos de lectura)" };
    }

    // Idempotencia: no re-insertar post_ids ya presentes para esta marca.
    const ids = videos.map((v) => String(v.id));
    const { data: existing } = await supabase
      .from("brand_posts")
      .select("id, post_id, media_assets")
      .eq("brand_container_id", brand_container_id)
      .eq("network", "tiktok")
      .in("post_id", ids);
    const seen = new Map((existing || []).map((r) => [String(r.post_id), r]));

    const rows = [];
    for (const v of videos) {
      try {
        // Ya guardado: no se re-inserta, pero SI se aprovecha el pase para
        // refrescar metricas y rescatar la portada. El cover de TikTok que
        // devuelve la API es fresco; el guardado caduca en dias, asi que esta
        // es la unica ventana para copiarlo a R2 y describirlo.
        const previo = seen.get(String(v.id));
        if (previo) {
          stats.skipped_existing++;
          const rescatado = await _rescueTiktokAssets(previo, v, brand_container_id);
          const metricasFrescas = normalizeMetrics("tiktok", {
            like_count:    v.like_count,
            comment_count: v.comment_count,
            share_count:   v.share_count,
            view_count:    v.view_count,
          });
          await supabase.from("brand_posts")
            .update({
              metrics: metricasFrescas,
              ...(rescatado ? { media_assets: rescatado } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("id", previo.id);
          if (rescatado) { stats.rescued++; await triggerMediaAnalysis(previo.id); }
          continue;
        }
        const desc = v.video_description || v.title || "";
        // Normaliza las claves nativas de TikTok (like_count, view_count…) a las
        // canónicas que entienden las columnas generadas y los ~100 RPCs.
        const metrics = normalizeMetrics("tiktok", {
          like_count:    v.like_count,
          comment_count: v.comment_count,
          share_count:   v.share_count,
          view_count:    v.view_count,
        });
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
          media_assets:        await _tiktokAssets(v, brand_container_id),
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
      else {
        stats.posts_created = inserted.length;
        // Sin esto los videos propios entraban sin analisis visual: el populador
        // no disparaba la descripcion que si dispara el scraper de IG/FB.
        for (const r of inserted) await triggerMediaAnalysis(r.id);
      }
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

/**
 * Rescata la portada de un video de TikTok YA GUARDADO al que le falta la copia
 * en R2. Devuelve el media_assets actualizado, o null si no hay nada que hacer.
 * Borra `image_extraction_error`: con copia permanente el fallo viejo deja de
 * aplicar y el describer puede reintentar.
 */
async function _rescueTiktokAssets(previo, v, brandContainerId) {
  const cover = v?.cover_image_url || null;
  if (!cover) return null;
  const cur = (previo.media_assets && typeof previo.media_assets === "object" && !Array.isArray(previo.media_assets))
    ? previo.media_assets : {};
  if (cur.archived_url) return null;                  // ya rescatado
  const archived = await archiveThumb({
    mediaAssets:      { cover_image: cover },
    brandContainerId,
    network:          "tiktok",
    postId:           String(v.id),
  });
  if (!archived) return null;
  const next = { ...cur, cover_image: cover, archived_url: archived };
  delete next.image_extraction_error;
  return next;
}

/**
 * media_assets de un video propio de TikTok, con la miniatura ya archivada.
 * Las URLs del CDN de TikTok caducan; se copia la portada a R2 al capturar,
 * que es la unica ventana en que esa URL sirve. Fail-open: sin archivo, se
 * conserva la original.
 */
async function _tiktokAssets(v, brandContainerId) {
  const cover = v?.cover_image_url || null;
  if (!cover) return null;
  const assets = { cover_image: cover };
  const archived = await archiveThumb({
    mediaAssets:      assets,
    brandContainerId,
    network:          "tiktok",
    postId:           String(v.id),
  });
  if (archived) assets.archived_url = archived;
  return assets;
}
