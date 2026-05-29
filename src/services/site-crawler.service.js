/**
 * Site Crawler Service — BFS recursivo para descubrir todas las rutas de un sitio.
 *
 * Fase 1 del pipeline brand-scraper:
 *   1. Fetch del seed_url
 *   2. Extrae links del HTML, normaliza, deduplica, filtra (same domain + html only)
 *   3. Procesa el siguiente lote — el loop termina cuando un batch no descubre rutas nuevas
 *   4. Devuelve { pages: [{url, html}], stats: {...}, errors: [...] }
 *
 * El HTML crudo se devuelve para que la Fase 2 (page-extractor) lo procese sin re-fetchear.
 *
 * Limites configurables:
 *   - maxPages (default 200)
 *   - maxDepth (default 5)
 *   - maxConcurrent fetches por sub-batch (default 5)
 *   - delayMs entre sub-batches (default 200)
 *   - timeoutMs por request (default 15000)
 */
import { load } from "cheerio";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; AI-Smart-Content-Crawler/1.0; +https://aismartcontent.io)";

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "yclid", "mc_eid", "mc_cid",
  "ref", "ref_src", "ref_url", "source", "campaign_id",
  "_ga", "_gl", "hsCtaTracking",
]);

const NON_HTML_EXTENSIONS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
  ".bmp", ".tiff", ".avif",
  ".mp4", ".mp3", ".wav", ".webm", ".mov", ".avi", ".m4a", ".m4v",
  ".zip", ".tar", ".gz", ".rar", ".7z", ".dmg", ".exe", ".pkg",
  ".css", ".js", ".json", ".xml", ".rss", ".atom",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
];

const NON_HTTP_PROTOCOLS = ["mailto:", "tel:", "javascript:", "data:", "ftp:", "sms:", "whatsapp:"];

// Paths que NO queremos crawlear (admin, checkout, auth, APIs).
const EXCLUDED_PATH_PREFIXES = [
  "/wp-admin", "/wp-login", "/wp-json",
  "/admin", "/administrator",
  "/cart", "/carrito", "/checkout", "/basket",
  "/account", "/cuenta", "/mi-cuenta", "/profile", "/perfil",
  "/login", "/signin", "/sign-in", "/iniciar-sesion",
  "/signup", "/sign-up", "/register", "/registro", "/registrarse",
  "/logout", "/signout",
  "/api/", "/.well-known/", "/wp-content/uploads/",
  "/feed", "/rss", "/sitemap",
];

// ────────────────────────────────────────────────────────────────────────────

/** Normaliza URL: lowercase host, sin tracking, sin fragment, sin trailing slash. */
export function normalizeUrl(rawUrl, baseUrl = null) {
  try {
    const u = new URL(rawUrl, baseUrl || undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;

    // Borrar params de tracking
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    // Ordenar search params para mejor dedup
    const sorted = [...u.searchParams.entries()].sort();
    u.search = sorted.length ? "?" + sorted.map(([k, v]) => `${k}=${v}`).join("&") : "";

    u.hash = "";
    u.hostname = u.hostname.toLowerCase();

    // Sin trailing slash excepto root
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Mismo dominio o subdominio del seed. */
export function isSameDomain(url, seedHostname) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const seed = seedHostname.toLowerCase().replace(/^www\./, "");
    return host === seed || host.endsWith("." + seed);
  } catch {
    return false;
  }
}

/** Resource es HTML (no .pdf/.jpg/etc, no mailto:/tel:/etc). */
export function isHtmlResource(url) {
  if (NON_HTTP_PROTOCOLS.some((p) => url.toLowerCase().startsWith(p))) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const pathLower = u.pathname.toLowerCase();
    if (NON_HTML_EXTENSIONS.some((ext) => pathLower.endsWith(ext))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Path no esta en lista de excluidos (admin/cart/login/etc). */
export function isExcludedPath(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  } catch {
    return true;
  }
}

/** Extrae todos los <a href> del HTML, normaliza con baseUrl, dedup. */
export function extractLinks(html, baseUrl) {
  if (!html) return [];
  const $ = load(html);
  const out = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) out.add(normalized);
  });
  return [...out];
}

// ────────────────────────────────────────────────────────────────────────────

/** Fetch resilient con timeout + UA + content-type check. */
async function fetchOne(url, timeoutMs, userAgent) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "es,en;q=0.7,*;q=0.3",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) {
      return { ok: false, requestedUrl: url, error: `HTTP ${res.status}`, status: res.status };
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("html") && !ct.includes("xhtml")) {
      return { ok: false, requestedUrl: url, error: `Not HTML (content-type: ${ct})` };
    }
    const html = await res.text();
    // res.url incluye redirects → URL final
    const finalUrl = normalizeUrl(res.url) || url;
    return { ok: true, requestedUrl: url, finalUrl, status: res.status, html };
  } catch (e) {
    clearTimeout(tid);
    const error = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    return { ok: false, requestedUrl: url, error };
  }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * crawlSite — BFS recursivo desde seedUrl.
 *
 * Termina cuando:
 *   - Un batch no descubre rutas nuevas (queue queda vacio)
 *   - Se llega a maxPages
 *   - Se llega a maxDepth
 *
 * @param {object} opts
 * @param {string} opts.seedUrl              — URL de arranque (requerido)
 * @param {number} [opts.maxPages=200]
 * @param {number} [opts.maxDepth=5]
 * @param {number} [opts.maxConcurrent=5]    — fetches en paralelo dentro de un sub-batch
 * @param {number} [opts.delayMs=200]        — pausa entre sub-batches (rate limit)
 * @param {number} [opts.timeoutMs=15000]
 * @param {boolean}[opts.includeHtml=true]   — devolver html en cada page (gigante; false = solo url+stats)
 * @param {function}[opts.onProgress]        — callback({phase, visited, pages, queue, depth})
 * @param {string} [opts.userAgent]
 * @returns {Promise<{pages: object[], errors: object[], stats: object, terminated: string}>}
 */
export async function crawlSite(opts) {
  const {
    seedUrl,
    maxPages = 200,
    maxDepth = 5,
    maxConcurrent = 5,
    delayMs = 200,
    timeoutMs = 15000,
    includeHtml = true,
    onProgress = null,
    userAgent = DEFAULT_USER_AGENT,
  } = opts || {};

  const startTime = Date.now();
  const seed = normalizeUrl(seedUrl);
  if (!seed) throw new Error(`Invalid seedUrl: ${seedUrl}`);

  const seedHostname = new URL(seed).hostname;
  const visited = new Set([seed]);
  const pages = [];
  const errors = [];

  let queue = [seed];
  let depth = 0;
  let totalBytes = 0;
  let terminated = "completed";

  while (queue.length > 0) {
    if (depth >= maxDepth) { terminated = "max_depth"; break; }
    if (pages.length >= maxPages) { terminated = "max_pages"; break; }

    // Snapshot del batch actual (todo lo que esta en queue ahora)
    const batchSlots = Math.min(queue.length, maxPages - pages.length);
    const batch = queue.slice(0, batchSlots);
    queue = queue.slice(batchSlots);

    if (onProgress) {
      onProgress({ phase: "batch_start", depth, batchSize: batch.length, visited: visited.size, pages: pages.length, queue: queue.length });
    }

    let newRoutesInBatch = 0;

    // Procesa el batch en sub-chunks de maxConcurrent
    for (let i = 0; i < batch.length; i += maxConcurrent) {
      const chunk = batch.slice(i, i + maxConcurrent);
      const fetched = await Promise.all(chunk.map((u) => fetchOne(u, timeoutMs, userAgent)));

      for (const r of fetched) {
        if (!r.ok) {
          errors.push({ url: r.requestedUrl, error: r.error });
          continue;
        }
        const finalUrl = r.finalUrl || r.requestedUrl;
        // Si el redirect llevo a otra URL ya visitada o fuera de dominio, skip
        if (visited.has(finalUrl) && finalUrl !== r.requestedUrl) {
          // ya la teniamos
        } else {
          visited.add(finalUrl);
        }

        totalBytes += r.html.length;
        pages.push({
          url: finalUrl,
          status: r.status,
          content_length: r.html.length,
          depth,
          ...(includeHtml ? { html: r.html } : {}),
        });

        // Extrae links y agrega nuevos a queue
        const links = extractLinks(r.html, finalUrl);
        for (const link of links) {
          if (
            !visited.has(link) &&
            isSameDomain(link, seedHostname) &&
            isHtmlResource(link) &&
            !isExcludedPath(link)
          ) {
            visited.add(link);
            queue.push(link);
            newRoutesInBatch++;
          }
        }
      }

      if (delayMs > 0 && i + maxConcurrent < batch.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (onProgress) {
      onProgress({
        phase: "batch_end",
        depth,
        visited: visited.size,
        pages: pages.length,
        queue: queue.length,
        newRoutesInBatch,
      });
    }

    // Condicion clave: si este batch no descubrio rutas nuevas Y queue quedo vacio, terminamos.
    if (newRoutesInBatch === 0 && queue.length === 0) {
      terminated = "no_new_routes";
      break;
    }

    depth++;
  }

  return {
    seed,
    pages,
    errors,
    terminated,
    stats: {
      total_pages: pages.length,
      total_urls_visited: visited.size,
      total_bytes: totalBytes,
      errors_count: errors.length,
      depth_reached: depth,
      duration_ms: Date.now() - startTime,
    },
  };
}
