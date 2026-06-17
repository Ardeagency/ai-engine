/**
 * artifact-renderer.service.js — Motor de render de artefactos de marca para Vera.
 *
 * Principio profesional: Vera aporta el CONTENIDO (markdown / datos
 * estructurados); este motor lo RENDERIZA aplicando la identidad de la marca
 * (colores, tipografía, tono) sobre plantillas. Vera NUNCA escribe HTML/CSS a
 * mano — por eso la salida sale siempre consistente con la marca.
 *
 * Formatos:
 *   - report / analysis / informe → PDF  (markdown → HTML de marca → Playwright)
 *   - presentation                → PDF  (deck 16:9, slides separados por "---")
 *   - infographic                 → PNG  (póster vertical, screenshot Playwright)
 *   - table                       → XLSX/CSV (SheetJS)
 *   - document (Word)             → DOCX (docx)
 *
 * El navegador Chromium es un singleton perezoso (lo trae Playwright, ya usado
 * por el scraper). Fallback de marca neutro-profesional si la marca no tiene tokens.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { marked } from "marked";
import { chromium } from "playwright";
import { supabase } from "../lib/supabase.js";

marked.setOptions({ gfm: true, breaks: true });

// ── Brand kit ──────────────────────────────────────────────────────────────
const DEFAULT_KIT = {
  nombreMarca: "",
  colors: { primary: "#15171a", secondary: "#3f4451", accent: "#2563eb", text: "#15171a", bg: "#ffffff", muted: "#6b7280" },
  fonts: { heading: "Georgia, 'Times New Roman', serif", body: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  fontFaces: [],
  logoUrl: null,
  tono: null,
  tagline: null,
};

// hex -> HSL (heurística de roles cuando la marca no etiqueta sus colores)
function hexToHsl(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return { h: 0, s: 0, l: 50 };
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: s * 100, l: l * 100 };
}

export async function loadBrandKit(brandContainerId, organizationId) {
  const kit = JSON.parse(JSON.stringify(DEFAULT_KIT));
  try {
    if (brandContainerId) {
      const { data: bc } = await supabase.from("brand_containers").select("nombre_marca,verbal_dna").eq("id", brandContainerId).maybeSingle();
      if (bc) {
        kit.nombreMarca = bc.nombre_marca || "";
        const vd = bc.verbal_dna || {};
        kit.tono = vd.tono || null;
        kit.tagline = vd.tagline || null;
      }
    }
    if (organizationId) {
      // Colores: schema real = color_role + hex_value, por organization_id (NO brand_container_id)
      const { data: colors } = await supabase.from("brand_colors").select("color_role,hex_value").eq("organization_id", organizationId);
      if (colors && colors.length) applyColors(kit, colors);
      // Logo: vive en brand_assets (asset_type tipo logo/isotipo/imagotipo), no en brand_containers
      const { data: assets } = await supabase.from("brand_assets").select("asset_type,file_url").eq("organization_id", organizationId);
      if (assets && assets.length) {
        const logo = assets.find((a) => /logo|isotipo|imagotipo|logotipo/i.test(a.asset_type || "") && /\.(png|jpe?g|svg|webp)$/i.test(a.file_url || ""));
        if (logo) kit.logoUrl = logo.file_url;
      }
      const { data: fonts } = await supabase.from("brand_fonts")
        .select("font_family,font_usage,font_weight,font_url,fallback_font").eq("organization_id", organizationId);
      if (fonts && fonts.length) applyFonts(kit, fonts);
    }
  } catch (e) { console.error("loadBrandKit:", e.message); /* usa fallback profesional */ }
  return kit;
}

function applyColors(kit, rows) {
  const byRole = {};
  for (const r of rows) {
    const u = (r.color_role || "").toLowerCase();
    const hex = r.hex_value;
    if (!hex) continue;
    if (/primar|principal|marca|brand/.test(u)) byRole.primary = hex;
    else if (/secundar/.test(u)) byRole.secondary = hex;
    else if (/acento|accent|destac/.test(u)) byRole.accent = hex;
    else if (/text|texto|tinta|negro|dark/.test(u)) byRole.text = hex;
    else if (/fondo|background|\bbg\b|claro|light|blanco/.test(u)) byRole.bg = hex;
  }
  const hexes = rows.map((r) => r.hex_value).filter(Boolean);
  kit.colors.primary = byRole.primary || hexes[0] || kit.colors.primary;
  kit.colors.secondary = byRole.secondary || hexes[1] || kit.colors.secondary;
  kit.colors.accent = byRole.accent || byRole.primary || hexes[0] || kit.colors.accent;
  if (byRole.text) kit.colors.text = byRole.text;
  if (byRole.bg) kit.colors.bg = byRole.bg;
  // Heurística cuando los roles son genéricos (ej. "Color", "Color 3"): el más
  // saturado = primary/accent (la marca), el más oscuro = texto.
  if (!byRole.primary && hexes.length) {
    const withHsl = hexes.map((h) => ({ hex: h, ...hexToHsl(h) }));
    const sat = [...withHsl].sort((a, b) => b.s - a.s)[0];
    const dark = [...withHsl].sort((a, b) => a.l - b.l)[0];
    if (sat) { kit.colors.primary = sat.hex; if (!byRole.accent) kit.colors.accent = sat.hex; }
    if (!byRole.text && dark && dark.l < 28) kit.colors.text = dark.hex;
  }
}

function applyFonts(kit, rows) {
  const head = rows.find((r) => /titul|head|display|encabez/i.test(r.font_usage || ""));
  const body = rows.find((r) => /cuerpo|body|text|parraf/i.test(r.font_usage || ""));
  const fam = (r) => (r ? `'${r.font_family}', ${r.fallback_font || "sans-serif"}` : null);
  kit.fonts.heading = fam(head) || fam(rows[0]) || kit.fonts.heading;
  kit.fonts.body = fam(body) || fam(rows[1]) || fam(rows[0]) || kit.fonts.body;
  for (const r of rows) {
    if (r.font_url && r.font_family) kit.fontFaces.push({ family: r.font_family, url: r.font_url, weight: r.font_weight || "400" });
  }
}

// ── Sistema de diseño: deriva tokens profesionales del kit de marca ──────────
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function relLum(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return 0.5;
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}
const onColor = (hex) => (relLum(hex) > 0.42 ? "#16181d" : "#ffffff"); // texto legible sobre un fondo
function tintHsl(hex, l, s) { const x = hexToHsl(hex); return `hsl(${Math.round(x.h)},${Math.round(clamp(s == null ? x.s : s, 0, 100))}%,${Math.round(clamp(l, 0, 100))}%)`; }

// Tokens: a partir de primary/accent/text deriva neutros tintados, superficies,
// bordes, fondo oscuro y "soft" de marca — todo contraste-seguro.
function deriveTokens(kit) {
  const c = kit.colors;
  const ph = hexToHsl(c.primary).h;
  const accent = c.accent || c.primary;
  const ah = hexToHsl(accent), aS = Math.min(ah.s, 80);
  const ink = (c.text && hexToHsl(c.text).l < 35) ? c.text : tintHsl(c.primary, 13, 8);
  const dark = (hexToHsl(c.primary).l < 24) ? c.primary : tintHsl(c.primary, 12, 14);
  const t = {
    primary: c.primary, accent,
    ink, ink2: tintHsl(c.primary, 38, 8), muted: tintHsl(c.primary, 55, 6),
    surface: "#ffffff", surfaceAlt: tintHsl(c.primary, 97, 8), surfaceCard: tintHsl(c.primary, 98, 8),
    border: tintHsl(c.primary, 89, 8), borderStrong: tintHsl(c.primary, 80, 8),
    dark, onDark: "#f3f3f4", brandSoft: `hsl(${Math.round(ah.h)},${Math.round(aS)}%,94%)`, onAccent: onColor(accent),
  };
  const css = `:root{--primary:${t.primary};--accent:${t.accent};--ink:${t.ink};--ink2:${t.ink2};--muted:${t.muted};`
    + `--surface:${t.surface};--surface-alt:${t.surfaceAlt};--surface-card:${t.surfaceCard};--border:${t.border};--border-strong:${t.borderStrong};`
    + `--dark:${t.dark};--on-dark:${t.onDark};--brand-soft:${t.brandSoft};--on-accent:${t.onAccent};}`;
  return { css, t };
}

// Fuentes: usa las de la marca; si no hay, una superfamilia profesional vía Google Fonts.
function fontSetup(kit) {
  const hasBrand = (kit.fontFaces && kit.fontFaces.length) || (kit.fonts.heading && !/Georgia/.test(kit.fonts.heading));
  if (hasBrand) {
    const faces = (kit.fontFaces || []).map((f) =>
      `@font-face{font-family:'${f.family}';src:url('${f.url}');font-weight:${f.weight};font-display:swap;}`).join("\n");
    return { link: "", heading: kit.fonts.heading, body: kit.fonts.body, faces };
  }
  return {
    link: `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`,
    heading: "'Manrope', system-ui, -apple-system, sans-serif", body: "'Inter', system-ui, -apple-system, sans-serif", faces: "",
  };
}

// ── CSS base profesional (escala modular, grid 8px, tablas minimal, micro-tipo) ──
function baseCss(kit, f, css) {
  return `
${f.faces}
${css}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}
body{margin:0;font-family:${f.body};color:var(--ink);background:var(--surface);line-height:1.5;font-size:11pt;-webkit-font-smoothing:antialiased;font-variant-ligatures:common-ligatures;}
h1,h2,h3,h4{font-family:${f.heading};color:var(--ink);line-height:1.15;margin:0 0 .4em;font-weight:700;letter-spacing:-.01em;}
h1{font-size:30pt;} h2{font-size:17pt;} h3{font-size:13pt;} h4{font-size:11pt;}
p{margin:0 0 .7em;} a{color:var(--accent);text-decoration:none;}
strong{font-weight:700;color:var(--ink);}
ul,ol{margin:.3em 0 .9em;padding-left:1.1em;} li{margin:.32em 0;}
table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:10.5pt;table-layout:fixed;}
th,td{text-align:left;padding:9px 12px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;}
thead th{border-bottom:2px solid var(--ink);font-family:${f.heading};font-weight:700;font-size:9pt;text-transform:uppercase;letter-spacing:.05em;color:var(--ink2);}
tbody td{border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;}
th[align=right],td[align=right]{text-align:right;}
blockquote{margin:.8em 0;padding:.5em 1.1em;border-left:3px solid var(--accent);background:var(--surface-alt);color:var(--ink2);font-style:italic;}
code{background:var(--surface-alt);padding:1px 5px;border-radius:4px;font-size:.9em;}
hr{border:none;border-top:1px solid var(--border);margin:1.2em 0;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:.4em 0;}
.kpi{background:var(--surface-alt);border:1px solid var(--border);border-radius:12px;padding:16px 18px;}
.kpi .v{font-family:${f.heading};font-weight:800;color:var(--accent);font-size:26pt;line-height:1;}
.kpi .l{color:var(--ink2);font-size:9.5pt;margin-top:7px;line-height:1.3;}
`;
}

function brandLockup(kit, onDark) {
  const col = onDark ? "var(--on-dark)" : "var(--ink)";
  const logo = kit.logoUrl ? `<img src="${kit.logoUrl}" style="height:30px;width:auto;" />` : "";
  const name = (!kit.logoUrl && kit.nombreMarca) ? `<span style="font-weight:800;font-size:13pt;letter-spacing:.04em;color:${col};">${escapeHtml(kit.nombreMarca)}</span>` : "";
  return `<div style="display:flex;align-items:center;gap:12px;">${logo}${name}</div>`;
}

// Renderiza el contenido markdown de un slide: extrae el título (primer heading)
// y convierte listas "**valor** etiqueta" en KPI cards; el resto, markdown normal.
function renderSlideContent(md) {
  const tokens = marked.lexer(md || "");
  let title = "";
  const rest = [];
  for (const t of tokens) {
    if (!title && t.type === "heading") { title = t.text; continue; }
    rest.push(t);
  }
  let body = "";
  for (const t of rest) {
    if (t.type === "list" && t.items.length >= 2 && t.items.every((it) => /^\*\*[^*]+\*\*/.test((it.text || "").trim()))) {
      const cards = t.items.map((it) => {
        const m = (it.text || "").trim().match(/^\*\*([^*]+)\*\*\s*([\s\S]*)$/);
        const v = m ? m[1] : it.text; const l = m ? m[2] : "";
        return `<div class="kpi"><div class="v">${escapeHtml(v)}</div><div class="l">${escapeHtml(String(l).replace(/\*\*/g, ""))}</div></div>`;
      }).join("");
      body += `<div class="kpis">${cards}</div>`;
    } else {
      body += marked.parser([t]);
    }
  }
  return { title, body };
}

// ── Plantillas HTML ──────────────────────────────────────────────────────────
export function reportHtml(kit, { title, subtitle, markdown }) {
  const f = fontSetup(kit); const { css } = deriveTokens(kit);
  const body = marked.parse(markdown || "");
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${f.link}<style>${baseCss(kit, f, css)}
@media print{@page{size:A4;margin:22mm 20mm 24mm;} h2,h3{break-after:avoid;} table,figure,blockquote,.kpis,.kpi{break-inside:avoid;} p{orphans:3;widows:3;}}
main{max-width:none;}
main h2{margin-top:1.4em;padding-bottom:.18em;border-bottom:1px solid var(--border);}
.cover{padding:0 0 20px;border-bottom:3px solid var(--accent);margin-bottom:30px;}
.cover .meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:64px;}
.cover .date{color:var(--muted);font-size:10pt;font-variant-numeric:tabular-nums;}
.cover h1{margin:0;font-size:34pt;max-width:18ch;}
.cover .sub{color:var(--ink2);font-size:13pt;margin-top:10px;max-width:60ch;}
</style></head><body>
<section class="cover">
  <div class="meta">${brandLockup(kit, false)}<span class="date">${date}</span></div>
  <h1>${escapeHtml(title || "Informe")}</h1>
  ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}
</section>
<main>${body}</main>
</body></html>`;
}

export function deckHtml(kit, { title, subtitle, markdown }) {
  const f = fontSetup(kit); const { css } = deriveTokens(kit);
  const sections = String(markdown || "").split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean);
  const total = sections.length + 1;
  const sub = subtitle || (Array.isArray(kit.tono) ? "" : kit.tono) || kit.tagline || "";
  const cover = `<section class="slide cover">
    <div class="brand">${brandLockup(kit, true)}</div>
    <div class="accent-bar"></div>
    <h1>${escapeHtml(title || kit.nombreMarca || "Presentación")}</h1>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
  </section>`;
  const contentSlides = sections.map((md, i) => {
    const { title: st, body } = renderSlideContent(md);
    return `<section class="slide">
      ${st ? `<div class="slide-title">${escapeHtml(st)}</div>` : ""}
      <div class="slide-main">${body}</div>
      <div class="slide-foot"><span>${escapeHtml(kit.nombreMarca || "")}</span><span>${i + 2}/${total}</span></div>
    </section>`;
  }).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${f.link}<style>${baseCss(kit, f, css)}
@media print{@page{size:1280px 720px;margin:0;}}
body{background:var(--surface);}
.slide{position:relative;width:1280px;height:720px;overflow:hidden;display:flex;flex-direction:column;padding:60px 72px;page-break-after:always;background:var(--surface);color:var(--ink);}
.slide:last-child{page-break-after:auto;}
.slide-title{font-family:${f.heading};font-size:27pt;font-weight:800;letter-spacing:-.015em;margin:0;}
.slide-title:after{content:"";display:block;width:56px;height:5px;background:var(--accent);border-radius:3px;margin:16px 0 0;}
.slide-main{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:14px;font-size:15pt;margin-top:22px;}
.slide-main > :first-child{margin-top:0;} .slide-main > :last-child{margin-bottom:0;}
.slide-main li{font-size:15pt;margin:.45em 0;}
.slide-main .kpi .v{font-size:34pt;} .slide-main .kpi .l{font-size:12pt;}
.slide-foot{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:9.5pt;padding-top:16px;border-top:1px solid var(--border);font-variant-numeric:tabular-nums;}
/* portada / divisores: oscuros, cinematográficos */
.slide.cover{background:var(--dark);color:var(--on-dark);justify-content:center;padding:80px 84px;}
.slide.cover .brand{margin-bottom:auto;}
.slide.cover .accent-bar{width:84px;height:6px;background:var(--accent);border-radius:3px;margin:0 0 26px;}
.slide.cover h1{color:#fff;font-size:48pt;line-height:1.05;margin:0;max-width:20ch;}
.slide.cover .sub{color:var(--on-dark);opacity:.82;font-size:15pt;margin-top:18px;max-width:60ch;}
</style></head><body>${cover}${contentSlides}</body></html>`;
}

export function infographicHtml(kit, { title, markdown, data }) {
  const f = fontSetup(kit); const { css } = deriveTokens(kit);
  const stats = (data && Array.isArray(data.stats)) ? data.stats : [];
  const cols = clamp(stats.length || 1, 1, 3);
  const statCards = stats.map((s) =>
    `<div class="stat"><div class="stat-val">${escapeHtml(String(s.value ?? ""))}</div><div class="stat-lbl">${escapeHtml(String(s.label ?? ""))}</div></div>`).join("");
  const body = marked.parse(markdown || "");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${f.link}<style>${baseCss(kit, f, css)}
body{width:1080px;margin:0;background:var(--surface);}
#infographic{width:1080px;padding:60px 60px 68px;background:var(--surface);}
.ig-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
.ig-date{color:var(--muted);font-size:11pt;font-variant-numeric:tabular-nums;}
.ig-title{font-family:${f.heading};font-size:42pt;font-weight:800;color:var(--ink);line-height:1.06;letter-spacing:-.02em;margin:20px 0 30px;}
.ig-title:after{content:"";display:block;width:96px;height:6px;background:var(--accent);margin-top:18px;border-radius:3px;}
.stats{display:grid;grid-template-columns:repeat(${cols},1fr);gap:18px;margin:6px 0 32px;}
.stat{background:var(--surface-alt);border:1px solid var(--border);border-top:5px solid var(--accent);border-radius:14px;padding:24px 22px;}
.stat-val{font-family:${f.heading};font-size:34pt;font-weight:800;color:var(--accent);line-height:1;}
.stat-lbl{color:var(--ink2);font-size:12pt;margin-top:8px;line-height:1.3;}
#infographic h2{font-size:18pt;margin-top:1.1em;} #infographic p,#infographic li{font-size:13pt;}
</style></head><body><div id="infographic">
  <div class="ig-head">${brandLockup(kit, false)}<span class="ig-date">${new Date().toISOString().slice(0,10)}</span></div>
  <div class="ig-title">${escapeHtml(title || "")}</div>
  ${statCards ? `<div class="stats">${statCards}</div>` : ""}
  <div>${body}</div>
</div></body></html>`;
}

// ── Render con Playwright ───────────────────────────────────
// Browser singleton perezoso con cierre por inactividad: tras el primer
// artifact, el chromium quedaba residente para siempre. Ahora se cierra solo
// luego de IDLE_MS sin renders, sin matar renders en vuelo (_inFlight).
let _browser = null;
let _idleTimer = null;
let _inFlight = 0;
const IDLE_MS = Number(process.env.ARTIFACT_BROWSER_IDLE_MS) || 5 * 60 * 1000;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  return _browser;
}

function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    if (_inFlight > 0) { scheduleIdleClose(); return; } // hay render en curso: re-agenda
    const b = _browser; _browser = null;
    if (b && b.isConnected()) { try { await b.close(); } catch (_) { /* ya cerrado */ } }
  }, IDLE_MS);
  if (_idleTimer.unref) _idleTimer.unref(); // no mantener vivo el proceso por este timer
}

// Cada render abre una pestania efimera; el browser se reutiliza y se cierra solo al quedar idle.
async function renderWithPage(pageOpts, fn) {
  const browser = await getBrowser();
  _inFlight++;
  const page = await browser.newPage(pageOpts);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    _inFlight--;
    scheduleIdleClose();
  }
}

export async function htmlToPdf(html, { landscape = false } = {}) {
  return renderWithPage({ javaScriptEnabled: false }, async (page) => { // doc estatico: sin JS (defensa)
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
    return await page.pdf({ printBackground: true, landscape, preferCSSPageSize: true });
  });
}

export async function htmlToPng(html, { width = 1080 } = {}) {
  return renderWithPage({ viewport: { width, height: 1200 }, deviceScaleFactor: 2, javaScriptEnabled: false }, async (page) => {
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
    const el = await page.$("#infographic");
    return el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png", fullPage: true });
  });
}

// ── Render de HTML BESPOKE (Vera diseña el documento; ver skill diseno-creacion-archivos) ──
// Red de seguridad anti-recorte: cualquier .slide que desborde su caja se escala
// para que su contenido quepa completo (el contenido NUNCA se recorta).
async function autoFitSlides(page) {
  try {
    await page.$$eval(".slide", (els) => {
      for (const s of els) {
        if (s.scrollHeight <= s.clientHeight + 2 && s.scrollWidth <= s.clientWidth + 2) continue;
        const wrap = document.createElement("div");
        while (s.firstChild) wrap.appendChild(s.firstChild);
        s.appendChild(wrap);
        const k = Math.min(s.clientHeight / wrap.scrollHeight, s.clientWidth / wrap.scrollWidth, 1) * 0.97;
        wrap.style.transformOrigin = "top left";
        wrap.style.width = (100 / k) + "%";
        wrap.style.transform = `scale(${k})`;
      }
    });
  } catch (_) { /* sin .slide o sin JS: no-op */ }
}

// Vera pasa un documento HTML5 completo y autocontenido; lo renderizamos tal cual.
export async function renderHtmlPdf(html) {
  return renderWithPage({}, async (page) => {
    await page.setContent(html, { waitUntil: "networkidle", timeout: 45000 });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await autoFitSlides(page);
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  });
}

export async function renderHtmlPng(html) {
  return renderWithPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 }, async (page) => {
    await page.setContent(html, { waitUntil: "networkidle", timeout: 45000 });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    const el = await page.$("#infographic");
    return el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png", fullPage: true });
  });
}

// ── Tablas ───────────────────────────────────────────────────────────────────
export function rowsToXlsx(sheets) {
  const xlsx = require("xlsx");
  const wb = xlsx.utils.book_new();
  for (const s of sheets) {
    const ws = xlsx.utils.aoa_to_sheet(s.rows || []);
    xlsx.utils.book_append_sheet(wb, ws, String(s.name || "Hoja").slice(0, 31));
  }
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function rowsToCsv(rows) {
  const xlsx = require("xlsx");
  const ws = xlsx.utils.aoa_to_sheet(rows || []);
  return Buffer.from("﻿" + xlsx.utils.sheet_to_csv(ws), "utf8"); // BOM para acentos en Excel
}

// ── Word (DOCX) desde markdown ───────────────────────────────────────────────
export async function mdToDocx(md, kit, title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel,
          Table, TableRow, TableCell, WidthType, AlignmentType } = require("docx");
  const accent = (kit.colors.accent || "#2563eb").replace("#", "");
  const primary = (kit.colors.primary || "#15171a").replace("#", "");
  const tokens = marked.lexer(md || "");
  const children = [];

  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: title, bold: true, color: primary })] }));
  if (kit.nombreMarca) children.push(new Paragraph({
    children: [new TextRun({ text: kit.nombreMarca + " · " + new Date().toISOString().slice(0,10), color: "888888", size: 18 })] }));

  const inlineRuns = (text) => {
    // soporta **bold** simple; resto plano
    const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p) => p.startsWith("**") && p.endsWith("**")
      ? new TextRun({ text: p.slice(2, -2), bold: true })
      : new TextRun({ text: p }));
  };

  for (const tok of tokens) {
    if (tok.type === "heading") {
      const lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.min(tok.depth - 1, 3)];
      children.push(new Paragraph({ heading: lvl, children: [new TextRun({ text: tok.text, color: tok.depth <= 2 ? accent : primary, bold: true })] }));
    } else if (tok.type === "paragraph") {
      children.push(new Paragraph({ children: inlineRuns(tok.text) }));
    } else if (tok.type === "list") {
      tok.items.forEach((it) => children.push(new Paragraph({
        children: inlineRuns(it.text), bullet: tok.ordered ? undefined : { level: 0 },
        numbering: undefined })));
    } else if (tok.type === "table") {
      const headerRow = new TableRow({ children: tok.header.map((h) => new TableCell({
        shading: { fill: primary }, children: [new Paragraph({ children: [new TextRun({ text: h.text, bold: true, color: "FFFFFF" })] })] })) });
      const bodyRows = tok.rows.map((r) => new TableRow({ children: r.map((cell) =>
        new TableCell({ children: [new Paragraph({ children: inlineRuns(cell.text) })] })) }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] }));
    } else if (tok.type === "blockquote") {
      children.push(new Paragraph({ children: [new TextRun({ text: tok.text, italics: true, color: "555555" })] }));
    } else if (tok.type === "space" || tok.type === "hr") {
      children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBuffer(doc);
}

// ── utils ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function shade(hex, alpha) {
  const h = String(hex || "#000").replace("#", "");
  if (h.length < 6) return `rgba(20,23,26,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
