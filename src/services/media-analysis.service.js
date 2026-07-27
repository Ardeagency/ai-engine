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
 * verPublicacion — "voy a verlo": describe la media de UN post AHORA y devuelve
 * lo que se ve, para que quien analiza no tenga que opinar del formato de una
 * pieza que nunca vio.
 *
 * A diferencia de triggerMediaAnalysis (fire-and-forget, para la ingesta), esta
 * ESPERA el resultado: quien la llama la esta pidiendo porque necesita la
 * respuesta para seguir razonando. Si el post ya estaba descrito, la reusa sin
 * gastar. Imagen y carrusel se describen hoy; el video todavia no, y en ese caso
 * se dice explicitamente en vez de devolver un vacio que parezca "no habia nada".
 *
 * @param {string} postId  brand_posts.id
 * @param {{force?:boolean, timeoutMs?:number}} [opts] force = volver a mirar
 * @returns {Promise<{ok:boolean, description:string|null, kind:string, reused:boolean, error?:string}>}
 */
export async function verPublicacion(postId, opts = {}) {
  if (!postId) return { ok: false, description: null, kind: "none", reused: false, error: "postId requerido" };
  const { force = false, timeoutMs = 120_000 } = opts;
  try {
    const resp = await fetch("http://127.0.0.1:8001/analyze/media-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: String(postId), force: !!force }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        description: null,
        kind: "none",
        reused: false,
        error: body?.detail || `analizador respondio ${resp.status}`,
      };
    }
    return {
      ok: !!body.description,
      description: body.description || null,
      kind: body.kind || "none",
      reused: !!body.reused,
      ...(body.error ? { error: body.error } : {}),
    };
  } catch (e) {
    return { ok: false, description: null, kind: "none", reused: false, error: String(e.message).slice(0, 200) };
  }
}
