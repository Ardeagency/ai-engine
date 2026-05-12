/**
 * image-pipeline.service.js
 *
 * Descarga imágenes desde URLs externas (Shopify CDN, Amazon, etc.) y las sube
 * al bucket `product-images` de Supabase Storage. Política: NUNCA persistir URLs
 * externas en `product_images.image_url` para uso productivo — esas URLs caducan,
 * cambian de CDN o desaparecen al desconectar la integración.
 *
 * Uso:
 *   const { storage_path, public_url, bytes, mime_type, width, height } =
 *     await downloadAndStore({ url, brandContainerId, productId, suffix });
 */
import { supabase } from "../../lib/supabase.js";
import crypto from "node:crypto";

const BUCKET = "product-images";
// 25 MB cap por imagen — cualquier asset producto sano cae muy por debajo.
const MAX_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg":  "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
  "image/avif": "avif",
};

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function hashUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

/**
 * Descarga `url`, sube al bucket en
 *   `${brandContainerId}/${productId}/${hash}-${suffix}.${ext}`
 * y devuelve metadata. Si la imagen ya existe (mismo path), no re-sube.
 */
export async function downloadAndStore({ url, brandContainerId, productId, suffix = "img" }) {
  if (!url || !brandContainerId || !productId) {
    throw new Error("downloadAndStore: missing url / brandContainerId / productId");
  }

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Image fetch ${res.status} for ${url}`);

  const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BYTES) {
    throw new Error(`Image too large (${contentLength} bytes > ${MAX_BYTES})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Image too large after read (${buf.byteLength} bytes)`);
  }

  const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime] || extFromUrl(url) || "bin";
  const hash = hashUrl(url);
  const storagePath = `${brandContainerId}/${productId}/${hash}-${suffix}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: mime || "application/octet-stream", upsert: true });
  if (error) throw new Error(`Storage upload: ${error.message}`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return {
    storage_path: storagePath,
    public_url:   pub?.publicUrl || null,
    bytes:        buf.byteLength,
    mime_type:    mime || null,
    width:        null,  // sin dependencia de sharp/probe-image-size por ahora; futuro
    height:       null,
  };
}

/**
 * Bulk: descarga N imágenes con concurrencia limitada.
 * Devuelve [{ ok, ...meta } | { ok:false, error, source_url }]
 */
export async function downloadAndStoreMany(items, { concurrency = 3 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const it = items[i];
      try {
        const meta = await downloadAndStore(it);
        results[i] = { ok: true, ...meta, source_url: it.url };
      } catch (e) {
        results[i] = { ok: false, error: String(e.message || e), source_url: it.url };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
