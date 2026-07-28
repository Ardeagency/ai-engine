/**
 * media-analysis.service.js — dispara la descripcion de la media de un post.
 *
 * Vivia como helper privado dentro de social-scraper.service.js, asi que los
 * populadores (TikTok, y los que vengan) no podian usarlo y sus posts entraban
 * sin analisis visual. Fire-and-forget: el analyzer decide si hay algo que
 * describir y si ya estaba descrito.
 */
export async function triggerMediaAnalysis(postId) {
  if (!postId) return;
  try {
    await fetch("http://127.0.0.1:8001/analyze/media-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId }),
    });
  } catch (e) {
    console.warn(`media-analysis ${postId} — ${e.message}`);
  }
}

/**
 * verPublicacion — "voy a verlo": le entrega a Vera la MEDIA de un post para que
 * la mire ella.
 *
 * ANTES esta tool llamaba a un analizador Python que describia la imagen y le
 * devolvia el texto. O sea: ai-engine miraba y Vera leia el resumen de otro.
 * Probado el 2026-07-28 que Vera ve una imagen desde su URL sin problema (28s,
 * descripcion correcta), asi que el rodeo sobraba — y contradecia la doctrina:
 * lo que el motor hace excelente no se reconstruye barato aqui.
 *
 * Ahora esto es lo que debe ser: un pasamanos. Devuelve las URLs de la media, el
 * copy y el contexto. Quien mira es ella.
 *
 * @param {string} postId  brand_posts.id
 * @returns {Promise<object>} la pieza con sus medios listos para mirar
 */
export async function verPublicacion(postId) {
  if (!postId) return { ok: false, error: "postId requerido" };
  const { supabase } = await import("../lib/supabase.js");

  const { data: p, error } = await supabase
    .from("brand_posts")
    .select("id, network, profile_handle, author_display_name, content, media_assets, " +
            "permalink, captured_at, metrics, engagement_total, unpublished_at, post_source")
    .eq("id", postId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!p) return { ok: false, error: "esa publicacion no existe" };

  const ma = p.media_assets || {};
  // Se prefiere SIEMPRE la copia archivada en R2: las URLs de las redes caducan
  // con firma y a los pocos dias devuelven 403, asi que la original solo vale
  // como respaldo inmediato.
  const medios = [];
  if (ma.archived_url) medios.push({ tipo: "archivada", url: ma.archived_url, nota: "copia estable en nuestro almacenamiento" });
  if (ma.cover_image) medios.push({ tipo: "portada", url: ma.cover_image, nota: "portada original de la red — la firma caduca" });
  for (const k of ["url", "image_url", "video_url", "thumbnail_url", "display_url"]) {
    if (ma[k] && !medios.some((m) => m.url === ma[k])) medios.push({ tipo: k, url: ma[k] });
  }

  return {
    ok: true,
    publicacion: {
      id: p.id,
      red: p.network,
      autor: p.author_display_name || p.profile_handle,
      es_propia: p.post_source === "own",
      publicada: p.captured_at,
      despublicada: p.unpublished_at || null,
      enlace: p.permalink || null,
      copy: p.content || "",
      interacciones: p.engagement_total,
      metricas: p.metrics || {},
    },
    medios,
    sin_media: medios.length === 0,
    descripcion_guardada: ma.description || null,
    encargo: medios.length
      ? "Mira los medios de la lista y describe lo que VES: escena, personas, producto, " +
        "texto en pantalla, ritmo si es video. Cuando lo tengas, guardalo con " +
        "describirPublicacion para que quede pegado a la pieza y no haya que volver a mirarla."
      : "Esta publicacion no tiene media guardada — es solo texto, o la ingesta no la trajo. " +
        "Juzgala por su copy y dilo asi; no supongas que habia una imagen.",
  };
}

/**
 * Guarda lo que Vera VIO en una publicacion, pegado a la pieza.
 *
 * Alimenta el mismo campo que lee `getBrandPosts` como `que_se_ve`, asi que una
 * pieza mirada una vez queda mirada para todas las lecturas siguientes.
 */
export async function describirPublicacion({ postId, descripcion }) {
  if (!postId) throw new Error("postId es requerido.");
  const texto = String(descripcion || "").trim();
  if (texto.length < 40) {
    throw new Error(
      `La descripcion tiene ${texto.length} caracteres y se esperan al menos 40. ` +
      "Describe la escena, quien sale y que producto aparece — no una etiqueta."
    );
  }
  const { supabase } = await import("../lib/supabase.js");

  const { data: p } = await supabase
    .from("brand_posts").select("media_assets").eq("id", postId).maybeSingle();
  if (!p) throw new Error("esa publicacion no existe");

  const ma = { ...(p.media_assets || {}), description: texto, described_at: new Date().toISOString(), described_by: "vera" };
  const { error } = await supabase
    .from("brand_posts")
    .update({ media_assets: ma, ai_analyzed_at: new Date().toISOString() })
    .eq("id", postId);
  if (error) throw new Error(`guardar la descripcion: ${error.message}`);

  return { ok: true, postId, caracteres: texto.length, visible_en: "que_se_ve de getBrandPosts" };
}
