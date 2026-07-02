/**
 * Page Extractor Service — Fase 2 del brand-scraper.
 *
 * Toma { url, html } y devuelve estructura rica de contenido:
 *   {
 *     url, lang, title,
 *     meta:        { og, twitter, theme_color, description, keywords, author, canonical },
 *     text:        { h1, h2, h3, paragraphs, total_chars, language_hint },
 *     colors:      [{ hex, count, source }] (top 20),
 *     typography:  { fonts_declared, fonts_used, google_fonts },
 *     products:    [{ name, price, currency, image, description, source }],
 *     services:    [{ name, description, source }],
 *     assets:      { images, videos, downloadables },
 *     social:      [{ platform, url, handle }],
 *     schema_org:  [{ ...jsonld }],
 *   }
 *
 * No re-fetchea nada. El HTML lo recibe del crawler de Fase 1.
 */
import { load } from "cheerio";

// ────────────────────────────────────────────────────────────────────────────
// Constantes

const SOCIAL_PLATFORMS = [
  { platform: "instagram",  domains: ["instagram.com", "instagr.am"] },
  { platform: "facebook",   domains: ["facebook.com", "fb.com", "fb.me"] },
  { platform: "tiktok",     domains: ["tiktok.com", "vm.tiktok.com"] },
  { platform: "youtube",    domains: ["youtube.com", "youtu.be"] },
  { platform: "twitter",    domains: ["twitter.com", "x.com"] },
  { platform: "linkedin",   domains: ["linkedin.com", "lnkd.in"] },
  { platform: "threads",    domains: ["threads.net"] },
  { platform: "pinterest",  domains: ["pinterest.com", "pin.it"] },
  { platform: "whatsapp",   domains: ["wa.me", "whatsapp.com", "api.whatsapp.com"] },
  { platform: "telegram",   domains: ["t.me", "telegram.me"] },
  { platform: "spotify",    domains: ["spotify.com", "open.spotify.com"] },
];

const DOWNLOADABLE_EXTS = [".pdf", ".zip", ".rar", ".7z", ".tar", ".gz", ".dmg", ".mp4", ".mov", ".m4v", ".mp3", ".wav", ".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls"];

const SERVICE_HINT_RE = /\b(servicio|service|consultor|consulting|asesor|advice|agenc[iy]|estudio|studio|firm|workshop|taller)\b/i;
const PRICE_RE = /([€$£¥₹฿₩])\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s?(EUR|USD|GBP|JPY|MXN|COP|BRL|ARS|CLP|PEN|CHF|CAD|AUD)/i;

// ────────────────────────────────────────────────────────────────────────────
// Helpers de URL

function absUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function getHostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function getPathname(url) {
  try { return new URL(url).pathname.toLowerCase(); } catch { return ""; }
}

// ────────────────────────────────────────────────────────────────────────────
// Extractors

function extractMeta($, baseUrl) {
  const get = (sel, attr = "content") => ($(sel).attr(attr) || "").trim();
  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    const key = ($(el).attr("property") || "").replace(/^og:/, "");
    const value = ($(el).attr("content") || "").trim();
    if (key && value) og[key] = value;
  });
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const key = ($(el).attr("name") || "").replace(/^twitter:/, "");
    const value = ($(el).attr("content") || "").trim();
    if (key && value) twitter[key] = value;
  });
  return {
    og,
    twitter,
    theme_color: get('meta[name="theme-color"]'),
    description: get('meta[name="description"]'),
    keywords: get('meta[name="keywords"]'),
    author: get('meta[name="author"]'),
    canonical: absUrl(get('link[rel="canonical"]', "href"), baseUrl),
    viewport: get('meta[name="viewport"]'),
  };
}

function extractText($, baseUrl) {
  // Quitar elementos que no son contenido para el text extraction
  const $clone = load($.html());
  $clone("script, style, noscript, nav, footer, aside, header, [role='navigation'], [role='banner'], [role='contentinfo']").remove();

  const h1 = $clone("h1").map((_, el) => $clone(el).text().trim()).get().filter(Boolean);
  const h2 = $clone("h2").map((_, el) => $clone(el).text().trim()).get().filter(Boolean);
  const h3 = $clone("h3").map((_, el) => $clone(el).text().trim()).get().filter(Boolean);

  // Tomar parrafos de main, article o body como fallback
  let $main = $clone("main, article, [role='main']").first();
  if (!$main.length) $main = $clone("body");
  const paragraphs = $main
    .find("p, li")
    .map((_, el) => $clone(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((s) => s.length >= 20)
    .slice(0, 200); // cap

  const total_chars = paragraphs.join(" ").length + h1.join(" ").length + h2.join(" ").length + h3.join(" ").length;
  return { h1, h2, h3, paragraphs, total_chars };
}

function extractColors($, themeColor) {
  // Combina theme-color + colores de inline <style> + style attr
  const counts = new Map(); // hex (lower) → { count, sources: Set }
  const add = (hex, source) => {
    const h = hex.toLowerCase();
    if (!counts.has(h)) counts.set(h, { count: 0, sources: new Set() });
    const entry = counts.get(h);
    entry.count++;
    entry.sources.add(source);
  };
  // theme-color
  if (themeColor && /^#[0-9a-f]{3,8}$/i.test(themeColor)) add(themeColor, "theme-color");

  // Inline <style> blocks
  const styleText = $("style").map((_, el) => $(el).html()).get().join("\n");
  // style attrs en elementos
  const inlineStyles = $("[style]").map((_, el) => $(el).attr("style")).get().join(";");
  const allCss = styleText + ";" + inlineStyles;

  // hex (#fff o #ffffff o #ffffffff)
  const hexRe = /#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
  let m;
  while ((m = hexRe.exec(allCss))) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join(""); // expand #fff
    else if (hex.length === 4) hex = hex.split("").map((c) => c + c).join("");
    add("#" + hex.toLowerCase(), "css");
  }
  // rgb() / rgba()
  const rgbRe = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;
  while ((m = rgbRe.exec(allCss))) {
    const [r, g, b] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
      add(hex, "css");
    }
  }

  // Top 20 ordenados por count, excluyendo blanco/negro puros (ruido frecuente)
  const arr = [...counts.entries()]
    .map(([hex, { count, sources }]) => ({ hex, count, sources: [...sources] }))
    .sort((a, b) => b.count - a.count);

  return arr.slice(0, 20);
}

function extractTypography($) {
  // @font-face declarations en inline <style>
  const styleText = $("style").map((_, el) => $(el).html()).get().join("\n");
  const fontFaceRe = /@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^'";]+)['"]?/gi;
  const declared = new Set();
  let m;
  while ((m = fontFaceRe.exec(styleText))) declared.add(m[1].trim());

  // font-family usados en CSS
  const ffRe = /font-family\s*:\s*([^;}\n]+)/gi;
  const used = new Map();
  while ((m = ffRe.exec(styleText))) {
    const stack = m[1].trim().split(",").map((s) => s.replace(/['"]/g, "").trim()).filter(Boolean);
    for (const f of stack) {
      used.set(f, (used.get(f) || 0) + 1);
    }
  }

  // Google Fonts <link>
  const google = new Set();
  $('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/family=([^&:]+)/);
    if (match) {
      for (const family of match[1].split("|")) {
        google.add(family.replace(/\+/g, " "));
      }
    }
  });

  return {
    fonts_declared: [...declared],
    fonts_used: [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, c]) => ({ family: f, count: c })),
    google_fonts: [...google],
  };
}

function extractSchemaOrg($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || "{}");
      if (Array.isArray(json)) out.push(...json);
      else if (json["@graph"]) out.push(...json["@graph"]);
      else out.push(json);
    } catch (_) { /* JSON invalido en algunas paginas, ignorar */ }
  });
  return out;
}

function extractProducts($, baseUrl, schemaOrg) {
  const products = [];

  // 1. JSON-LD Product
  for (const obj of schemaOrg) {
    const type = obj["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
      products.push({
        name: obj.name || "",
        description: obj.description || "",
        image: typeof obj.image === "string" ? obj.image : (Array.isArray(obj.image) ? obj.image[0] : (obj.image?.url || "")),
        brand: typeof obj.brand === "string" ? obj.brand : (obj.brand?.name || ""),
        price: obj.offers?.price || obj.offers?.lowPrice || "",
        currency: obj.offers?.priceCurrency || "",
        sku: obj.sku || "",
        url: absUrl(obj.url, baseUrl) || baseUrl,
        source: "json-ld",
      });
    }
  }

  // 2. og:type = product
  const ogType = ($('meta[property="og:type"]').attr("content") || "").toLowerCase();
  if (ogType.includes("product") && products.length === 0) {
    products.push({
      name: $('meta[property="og:title"]').attr("content") || "",
      description: $('meta[property="og:description"]').attr("content") || "",
      image: $('meta[property="og:image"]').attr("content") || "",
      price: $('meta[property="product:price:amount"]').attr("content") || "",
      currency: $('meta[property="product:price:currency"]').attr("content") || "",
      url: baseUrl,
      source: "og:product",
    });
  }

  // 3. Heuristica de cards: <article> o repeated divs con precio + imagen + heading
  // (skip por ahora — alto falso positivo, lo cubre el LLM en consolidator)

  return products;
}

function extractServices($, baseUrl, schemaOrg) {
  const services = [];

  // 1. JSON-LD Service
  for (const obj of schemaOrg) {
    const type = obj["@type"];
    if (type === "Service" || (Array.isArray(type) && type.includes("Service"))) {
      services.push({
        name: obj.name || "",
        description: obj.description || "",
        provider: obj.provider?.name || "",
        area_served: obj.areaServed || "",
        url: absUrl(obj.url, baseUrl) || baseUrl,
        source: "json-ld",
      });
    }
  }

  // 2. Sin JSON-LD: si h1/h2 incluyen palabras tipo servicio, registrar header como pista
  if (services.length === 0) {
    $("h1, h2, h3").each((_, el) => {
      const txt = $(el).text().trim();
      if (txt && SERVICE_HINT_RE.test(txt)) {
        services.push({ name: txt, description: "", source: "heading-hint" });
      }
    });
  }
  return services.slice(0, 30);
}

function extractAssets($, baseUrl) {
  const images = [];
  $("img[src]").each((_, el) => {
    const src = absUrl($(el).attr("src"), baseUrl);
    if (src) {
      images.push({
        src,
        alt: ($(el).attr("alt") || "").trim(),
        width: $(el).attr("width") || null,
        height: $(el).attr("height") || null,
      });
    }
  });
  const videos = [];
  $("video").each((_, el) => {
    const $el = $(el);
    const src = absUrl($el.attr("src"), baseUrl) || absUrl($el.find("source").first().attr("src"), baseUrl);
    if (src) videos.push({ src, poster: absUrl($el.attr("poster"), baseUrl) });
  });
  // Embeds de YouTube (iframe) → thumbnail como frame representativo del video.
  const embedThumbs = [];
  $("iframe[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    const yt = src.match(/(?:youtube\.com\/embed\/|youtu\.be\/|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/);
    if (yt) embedThumbs.push(`https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`);
  });
  // Frames representativos de video: posters de <video> + thumbnails de embeds.
  const video_posters = [...new Set([
    ...videos.map((v) => v.poster).filter(Boolean),
    ...embedThumbs,
  ])].slice(0, 12);
  const downloadables = [];
  $("a[href]").each((_, el) => {
    const href = absUrl($(el).attr("href"), baseUrl);
    if (!href) return;
    const path = getPathname(href);
    if (DOWNLOADABLE_EXTS.some((ext) => path.endsWith(ext))) {
      downloadables.push({ url: href, text: $(el).text().replace(/\s+/g, " ").trim() });
    }
  });
  return {
    images: images.slice(0, 100),
    videos: videos.slice(0, 30),
    video_posters,
    downloadables: downloadables.slice(0, 50),
  };
}

function extractSocialLinks($, baseUrl, seedHostname) {
  const found = new Map(); // key = `${platform}:${url}` para dedup
  $("a[href]").each((_, el) => {
    const href = absUrl($(el).attr("href"), baseUrl);
    if (!href) return;
    const host = getHostname(href);
    // Skip same domain (no es social del cliente, son links internos)
    if (seedHostname && host && (host === seedHostname || host.endsWith("." + seedHostname.replace(/^www\./, "")))) return;
    for (const { platform, domains } of SOCIAL_PLATFORMS) {
      if (domains.some((d) => host === d || host.endsWith("." + d))) {
        const key = `${platform}:${href}`;
        if (!found.has(key)) {
          // Extract handle: pathname segment 1 sin slashes
          const handle = (getPathname(href).split("/").filter(Boolean)[0] || "").replace(/^@/, "");
          found.set(key, { platform, url: href, handle });
        }
      }
    }
  });
  return [...found.values()];
}

// ────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * extractPage — extrae todo el corpus de una pagina.
 * @param {object} opts
 * @param {string} opts.url       URL final de la pagina (post-redirect)
 * @param {string} opts.html      HTML crudo
 * @param {string} [opts.seedHostname]  hostname del seed para detectar social externos
 * @returns {object} corpus
 */
export function extractPage({ url, html, seedHostname = null }) {
  if (!html) return { url, error: "no html" };

  const $ = load(html);
  const lang = ($("html").attr("lang") || "").trim().toLowerCase() || null;
  const title = $("title").first().text().trim() || null;

  const meta = extractMeta($, url);
  const schemaOrg = extractSchemaOrg($);
  const text = extractText($, url);
  const colors = extractColors($, meta.theme_color);
  const typography = extractTypography($);
  const products = extractProducts($, url, schemaOrg);
  const services = extractServices($, url, schemaOrg);
  const assets = extractAssets($, url);
  const social = extractSocialLinks($, url, seedHostname || getHostname(url));

  return {
    url,
    lang,
    title,
    meta,
    text,
    colors,
    typography,
    products,
    services,
    assets,
    social,
    schema_org_count: schemaOrg.length,
  };
}

/**
 * extractCorpus — itera sobre todas las pages del crawler y agrega un corpus.
 * @param {Array<{url, html}>} pages
 * @param {string} seedHostname
 * @returns {object} corpus agregado para LLM consolidator
 */
export function extractCorpus(pages, seedHostname) {
  const corpus = {
    seed_hostname: seedHostname,
    pages: [],
    aggregated: {
      colors: new Map(),
      typography: { fonts_used: new Map(), google_fonts: new Set(), declared: new Set() },
      products: [],
      services: [],
      social: new Map(),
      assets: { images: 0, videos: 0, downloadables: [] },
      video_posters: new Set(),
      meta_descriptions: [],
      langs: new Map(),
      all_h1: [],
      all_h2: [],
      paragraph_chars: 0,
    },
  };

  for (const p of pages) {
    if (!p.html) continue;
    const ex = extractPage({ url: p.url, html: p.html, seedHostname });
    corpus.pages.push({
      url: ex.url,
      lang: ex.lang,
      title: ex.title,
      meta: ex.meta,
      text: { h1: ex.text.h1, h2: ex.text.h2, paragraphs_count: ex.text.paragraphs.length, total_chars: ex.text.total_chars },
      products_count: ex.products.length,
      services_count: ex.services.length,
      social_count: ex.social.length,
    });

    // Agregar colores
    for (const c of ex.colors) {
      const cur = corpus.aggregated.colors.get(c.hex) || 0;
      corpus.aggregated.colors.set(c.hex, cur + c.count);
    }
    // Tipografias
    for (const f of ex.typography.fonts_used) {
      const cur = corpus.aggregated.typography.fonts_used.get(f.family) || 0;
      corpus.aggregated.typography.fonts_used.set(f.family, cur + f.count);
    }
    ex.typography.google_fonts.forEach((g) => corpus.aggregated.typography.google_fonts.add(g));
    ex.typography.fonts_declared.forEach((d) => corpus.aggregated.typography.declared.add(d));
    // Products + services
    corpus.aggregated.products.push(...ex.products);
    corpus.aggregated.services.push(...ex.services);
    // Social
    for (const s of ex.social) {
      corpus.aggregated.social.set(`${s.platform}:${s.url}`, s);
    }
    // Assets
    corpus.aggregated.assets.images += ex.assets.images.length;
    corpus.aggregated.assets.videos += ex.assets.videos.length;
    corpus.aggregated.assets.downloadables.push(...ex.assets.downloadables);
    (ex.assets.video_posters || []).forEach((u) => corpus.aggregated.video_posters.add(u));
    // Meta descriptions y h1/h2 para corpus textual
    if (ex.meta.description) corpus.aggregated.meta_descriptions.push(ex.meta.description);
    if (ex.lang) corpus.aggregated.langs.set(ex.lang, (corpus.aggregated.langs.get(ex.lang) || 0) + 1);
    corpus.aggregated.all_h1.push(...ex.text.h1);
    corpus.aggregated.all_h2.push(...ex.text.h2);
    corpus.aggregated.paragraph_chars += ex.text.total_chars;
  }

  // Materializar Maps/Sets en arrays
  const agg = corpus.aggregated;
  return {
    ...corpus,
    aggregated: {
      colors_top: [...agg.colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([hex, count]) => ({ hex, count })),
      typography: {
        fonts_used_top: [...agg.typography.fonts_used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([family, count]) => ({ family, count })),
        google_fonts: [...agg.typography.google_fonts],
        fonts_declared: [...agg.typography.declared],
      },
      products: agg.products.slice(0, 100),
      services: agg.services.slice(0, 50),
      social: [...agg.social.values()],
      assets_summary: agg.assets,
      video_posters: [...agg.video_posters].slice(0, 12),
      meta_descriptions: agg.meta_descriptions.slice(0, 30),
      langs: [...agg.langs.entries()].map(([lang, count]) => ({ lang, count })),
      all_h1: agg.all_h1.slice(0, 80),
      all_h2: agg.all_h2.slice(0, 150),
      paragraph_chars: agg.paragraph_chars,
    },
  };
}
