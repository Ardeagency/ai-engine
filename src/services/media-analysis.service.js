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
