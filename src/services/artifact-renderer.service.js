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
};

export async function loadBrandKit(brandContainerId, organizationId) {
  const kit = JSON.parse(JSON.stringify(DEFAULT_KIT));
  try {
    if (brandContainerId) {
      const { data: bc } = await supabase.from("brand_containers").select("*").eq("id", brandContainerId).maybeSingle();
      if (bc) {
        kit.nombreMarca = bc.nombre_marca || "";
        kit.logoUrl = bc.logo_url || bc.logo || bc.logotipo_url || null;
        const vd = bc.verbal_dna || {};
        kit.tono = vd.tono || null;
      }
      const { data: colors } = await supabase.from("brand_colors").select("nombre,hex,uso").eq("brand_container_id", brandContainerId);
      if (colors && colors.length) applyColors(kit, colors);
    }
    if (organizationId) {
      const { data: fonts } = await supabase.from("brand_fonts")
        .select("font_family,font_usage,font_weight,font_url,fallback_font").eq("organization_id", organizationId);
      if (fonts && fonts.length) applyFonts(kit, fonts);
    }
  } catch (_) { /* usa fallback */ }
  return kit;
}

function applyColors(kit, rows) {
  const byUso = {};
  for (const r of rows) {
    const u = (r.uso || r.nombre || "").toLowerCase();
    if (/primar|principal/.test(u)) byUso.primary = r.hex;
    else if (/secundar/.test(u)) byUso.secondary = r.hex;
    else if (/acento|accent|destac/.test(u)) byUso.accent = r.hex;
    else if (/text|texto|tinta/.test(u)) byUso.text = r.hex;
    else if (/fondo|background|\bbg\b/.test(u)) byUso.bg = r.hex;
  }
  const hexes = rows.map((r) => r.hex).filter(Boolean);
  kit.colors.primary = byUso.primary || hexes[0] || kit.colors.primary;
  kit.colors.secondary = byUso.secondary || hexes[1] || kit.colors.secondary;
  kit.colors.accent = byUso.accent || hexes[2] || byUso.primary || hexes[0] || kit.colors.accent;
  if (byUso.text) kit.colors.text = byUso.text;
  if (byUso.bg) kit.colors.bg = byUso.bg;
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

// ── CSS base de marca ────────────────────────────────────────────────────────
function baseCss(kit) {
  const c = kit.colors;
  const faces = kit.fontFaces.map((f) =>
    `@font-face{font-family:'${f.family}';src:url('${f.url}');font-weight:${f.weight};font-display:swap;}`).join("\n");
  return `
${faces}
:root{--primary:${c.primary};--secondary:${c.secondary};--accent:${c.accent};--text:${c.text};--bg:${c.bg};--muted:${c.muted};}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{margin:0;font-family:${kit.fonts.body};color:var(--text);background:var(--bg);line-height:1.6;font-size:14px;}
h1,h2,h3,h4{font-family:${kit.fonts.heading};color:var(--primary);line-height:1.2;margin:1.2em 0 .5em;}
h1{font-size:30px;} h2{font-size:22px;border-bottom:2px solid var(--accent);padding-bottom:.25em;} h3{font-size:17px;}
p{margin:.6em 0;} a{color:var(--accent);}
strong{color:var(--primary);}
ul,ol{margin:.5em 0 .8em 1.2em;padding:0;} li{margin:.25em 0;}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:12.5px;}
th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top;}
th{background:var(--primary);color:#fff;font-family:${kit.fonts.heading};}
tr:nth-child(even) td{background:#f8f9fb;}
blockquote{border-left:4px solid var(--accent);margin:1em 0;padding:.4em 1em;color:var(--secondary);background:#f8f9fb;}
code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font-size:12px;}
hr{border:none;border-top:1px solid #e5e7eb;margin:1.5em 0;}
`;
}

function brandHeader(kit) {
  const logo = kit.logoUrl ? `<img src="${kit.logoUrl}" style="height:34px;width:auto;" />` : "";
  const name = kit.nombreMarca ? `<span style="font-family:${kit.fonts.heading};font-weight:700;color:var(--primary);font-size:15px;letter-spacing:.02em;">${escapeHtml(kit.nombreMarca)}</span>` : "";
  return `<div style="display:flex;align-items:center;gap:12px;">${logo}${name}</div>`;
}

// ── Plantillas HTML ──────────────────────────────────────────────────────────
export function reportHtml(kit, { title, subtitle, markdown }) {
  const body = marked.parse(markdown || "");
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${baseCss(kit)}
@page{size:A4;margin:18mm 16mm;}
.cover{padding:0 0 18px;border-bottom:3px solid var(--accent);margin-bottom:22px;}
.cover .meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px;}
.cover .date{color:var(--muted);font-size:12px;}
.cover h1{margin:0;font-size:32px;}
.cover .sub{color:var(--secondary);font-size:15px;margin-top:6px;}
.foot{position:fixed;bottom:8mm;left:16mm;right:16mm;display:flex;justify-content:space-between;color:var(--muted);font-size:10px;border-top:1px solid #e5e7eb;padding-top:6px;}
</style></head><body>
<div class="cover">
  <div class="meta">${brandHeader(kit)}<span class="date">${date}</span></div>
  <h1>${escapeHtml(title || "Informe")}</h1>
  ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}
</div>
<main>${body}</main>
<div class="foot"><span>${escapeHtml(kit.nombreMarca || "")}</span><span>Generado por Vera · ${date}</span></div>
</body></html>`;
}

export function deckHtml(kit, { title, markdown }) {
  const slidesMd = String(markdown || "").split(/\n-{3,}\n/);
  const slides = slidesMd.map((md, i) => {
    const html = marked.parse(md.trim() || "");
    return `<section class="slide"><div class="slide-inner">${html}</div>
      <div class="slide-foot"><span>${escapeHtml(kit.nombreMarca || "")}</span><span>${i + 1}/${slidesMd.length}</span></div></section>`;
  }).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${baseCss(kit)}
@page{size:A4 landscape;margin:0;}
body{background:#fff;}
.slide{position:relative;width:297mm;height:209mm;padding:24mm 26mm;page-break-after:always;overflow:hidden;
  background:linear-gradient(115deg,#ffffff 64%,${shade(kit.colors.primary,0.06)} 64%);}
.slide:first-child{background:var(--primary);color:#fff;display:flex;flex-direction:column;justify-content:center;}
.slide:first-child h1,.slide:first-child h2,.slide:first-child h3{color:#fff;}
.slide:first-child h1{font-size:44px;border:none;}
.slide-inner h2{border-bottom:none;font-size:30px;}
.slide-inner{font-size:18px;}
.slide-inner li{margin:.4em 0;font-size:18px;}
.slide-foot{position:absolute;bottom:12mm;left:26mm;right:26mm;display:flex;justify-content:space-between;color:var(--muted);font-size:11px;}
.slide:first-child .slide-foot{color:rgba(255,255,255,.7);}
</style></head><body>${slides}</body></html>`;
}

export function infographicHtml(kit, { title, markdown, data }) {
  const stats = (data && Array.isArray(data.stats)) ? data.stats : [];
  const statCards = stats.map((s) =>
    `<div class="stat"><div class="stat-val">${escapeHtml(String(s.value ?? ""))}</div><div class="stat-lbl">${escapeHtml(String(s.label ?? ""))}</div></div>`).join("");
  const body = marked.parse(markdown || "");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${baseCss(kit)}
body{width:1080px;margin:0;}
#infographic{width:1080px;padding:56px 56px 64px;background:linear-gradient(180deg,${shade(kit.colors.primary,0.04)},#fff 380px);}
.ig-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.ig-title{font-family:${kit.fonts.heading};font-size:46px;font-weight:800;color:var(--primary);line-height:1.1;margin:18px 0 28px;}
.ig-title:after{content:"";display:block;width:90px;height:6px;background:var(--accent);margin-top:16px;border-radius:3px;}
.stats{display:grid;grid-template-columns:repeat(${Math.min(Math.max(stats.length || 1, 1), 3)},1fr);gap:18px;margin:8px 0 30px;}
.stat{background:#fff;border:1px solid #eef0f3;border-top:5px solid var(--accent);border-radius:14px;padding:22px 20px;box-shadow:0 6px 20px rgba(20,23,26,.05);}
.stat-val{font-family:${kit.fonts.heading};font-size:40px;font-weight:800;color:var(--primary);}
.stat-lbl{color:var(--secondary);font-size:15px;margin-top:6px;}
#infographic h2{font-size:24px;} #infographic p,#infographic li{font-size:16px;}
</style></head><body><div id="infographic">
  <div class="ig-head">${brandHeader(kit)}<span style="color:var(--muted);font-size:13px;">${new Date().toISOString().slice(0,10)}</span></div>
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
