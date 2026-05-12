/**
 * shopify-rest.js — Cliente REST Admin API.
 *
 * Soporta:
 *   - GET sencillo con auth header
 *   - GET paginado vía Link header (cursor-based, post-2019-07)
 *   - Backoff básico ante 429 con Retry-After
 *
 * NO usa GraphQL bulk operations (eso queda para fase 2B con shopify-bulk.js).
 * Para datasets grandes usar shopifyRestGetAllPages con maxPages adecuado.
 */
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const MAX_RETRIES = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * GET una sola página de la Admin REST API.
 * @param {string} shop          - "mitienda.myshopify.com"
 * @param {string} accessToken   - shpat_... offline token
 * @param {string} pathOrUrl     - "/products.json?limit=50" o URL completa
 * @returns {Promise<{ data: object, linkHeader: string }>}
 */
export async function shopifyRestGet(shop, accessToken, pathOrUrl) {
  if (!shop || !accessToken) throw new Error("shop and accessToken required");

  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${shop}/admin/api/${API_VERSION}${pathOrUrl}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("retry-after") || "1");
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Shopify rate limited after ${MAX_RETRIES} attempts: ${url}`);
      }
      await sleep(Math.min(retryAfter * 1000, 8000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Shopify ${url} failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const json = await res.json().catch(() => ({}));
    return { data: json, linkHeader: res.headers.get("link") || "" };
  }
  throw new Error("Unreachable");
}

/**
 * Pagina automáticamente vía Link header hasta agotar resultados o llegar a maxPages.
 * El primer key del JSON ("products", "orders", etc.) determina el array a acumular.
 */
export async function shopifyRestGetAllPages(shop, accessToken, basePath, opts = {}) {
  const limit    = opts.limit || 250;
  const maxPages = opts.maxPages || 50;
  const items    = [];
  let pageCount  = 0;

  // Construir primera URL (asegurando ?limit=)
  const sep = basePath.includes("?") ? "&" : "?";
  let nextUrl = basePath.includes("limit=")
    ? basePath
    : `${basePath}${sep}limit=${limit}`;

  while (nextUrl && pageCount < maxPages) {
    const { data, linkHeader } = await shopifyRestGet(shop, accessToken, nextUrl);

    // Identificar el array principal del response (primer key con array)
    const arr = Array.isArray(Object.values(data)[0])
      ? Object.values(data)[0]
      : [];
    items.push(...arr);
    pageCount++;

    nextUrl = parseNextPageUrl(linkHeader);
  }

  return { items, pages: pageCount, truncated: pageCount >= maxPages };
}

function parseNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  // Format: '<https://shop.myshopify.com/admin/api/2026-04/products.json?...&page_info=...>; rel="next", <...>; rel="previous"'
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}
