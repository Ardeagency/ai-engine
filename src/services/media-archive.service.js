/**
 * media-archive.service.js — archiva en R2 la miniatura de un post monitoreado.
 *
 * POR QUE EXISTE: Instagram y TikTok firman las URLs de su CDN con expiracion
 * (el parametro `oe=` es un timestamp). A las pocas semanas devuelven 403 y la
 * galeria de Competencia queda llena de placeholders: el dashboard pierde la
 * cara del contenido justo cuando uno quiere revisar que hizo el rival.
 *
 * La unica ventana en la que esa URL sirve es el momento de la captura. Aqui
 * se aprovecha: al ingerir el post se copia la miniatura a R2
 * (media.aismartcontent.io) y se guarda esa URL permanente en
 * `media_assets.archived_url`. El frontend la prefiere y cae a la original solo
 * si no existe.
 *
 * DISCIPLINA DE COSTO: se archiva UNA imagen por post (la miniatura), nunca el
 * video — un master de video pesa cientos de veces mas y no aporta a la
 * lectura del dashboard. La entrega al navegador pasa por las Image
 * Transformations de Cloudflare (media-optimizer.js reescribe todo <img> de ese
 * host a /cdn-cgi/image/...), asi que el peso servido es una fraccion del
 * archivado.
 *
 * FAIL-OPEN: cualquier fallo devuelve null y la ingesta sigue con la URL
 * original. Archivar es una mejora, jamas un requisito para guardar el post.
 */
const R2_INGEST_URL = process.env.R2_INGEST_URL || "";
const R2_INGEST_KEY = process.env.R2_INGEST_KEY || "";

// Un post puede traer la miniatura en cualquiera de estos campos segun la red.
// El orden es de mayor a menor calidad/fiabilidad.
const THUMB_FIELDS = [
  "display_url",      // Instagram
  "cover_image",      // TikTok
  "thumbnail_url",    // generico
  "main_image_url",   // Amazon
];

/** Primera URL http(s) utilizable de un media_assets ya construido. */
export function pickThumbUrl(mediaAssets) {
  const a = mediaAssets || {};
  const ok = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
  for (const f of THUMB_FIELDS) if (ok(a[f])) return a[f];
  // Los arrays llegan de YouTube (varias resoluciones) y de galerias.
  for (const f of ["thumbnails", "images", "media_urls"]) {
    const arr = Array.isArray(a[f]) ? a[f] : [];
    for (const v of arr) {
      if (ok(v)) return v;
      if (v && ok(v.url)) return v.url;
    }
  }
  return null;
}

/** Ruta estable en el bucket: el mismo post siempre cae en la misma llave. */
export function thumbPath({ brandContainerId, network, postId }) {
  const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `monitoring/${safe(brandContainerId)}/${safe(network)}/${safe(postId)}.jpg`;
}

/**
 * Copia la miniatura del post a R2 y devuelve su URL permanente.
 * @returns {Promise<string|null>} URL en media.aismartcontent.io, o null.
 */
export async function archiveThumb({ mediaAssets, brandContainerId, network, postId, timeoutMs = 12000 }) {
  if (!R2_INGEST_URL || !R2_INGEST_KEY) return null;
  const sourceUrl = pickThumbUrl(mediaAssets);
  if (!sourceUrl || !brandContainerId || !postId) return null;
  // Ya archivada (reingesta del mismo post): no se vuelve a pagar la copia.
  if (sourceUrl.includes("media.aismartcontent.io")) return sourceUrl;

  const path = thumbPath({ brandContainerId, network, postId });
  // El scraper procesa decenas de posts por corrida: un CDN colgado no puede
  // secuestrar la ingesta entera.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${R2_INGEST_URL}/url`, {
      method: "POST",
      headers: { "x-ingest-key": R2_INGEST_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: sourceUrl, path }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j.url || null;
  } catch (_) {
    return null;   // fail-open: la ingesta continua con la URL original
  } finally {
    clearTimeout(timer);
  }
}
