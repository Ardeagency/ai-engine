/**
 * artifact.tools.js — Vera genera archivos profesionales con identidad de marca.
 *
 * createArtifact: Vera aporta contenido (markdown o datos) + un `type`; el motor
 * (artifact-renderer.service) lo renderiza con los colores/tipografía/tono de la
 * marca y lo persiste en el bucket `vera-artifacts` (público) + fila en
 * `vera_artifacts`. Devuelve una URL estable descargable.
 *
 * type → formato por defecto:
 *   report | analysis | informe → PDF
 *   presentation                → PDF (deck 16:9; separa slides con una línea "---")
 *   infographic                 → PNG (data.stats = [{value,label}] para tarjetas)
 *   table                       → XLSX  (data.sheets=[{name,rows:[[...]]}] o data.rows=[[...]])
 *   document                    → DOCX (Word)
 *
 * Escritura: persiste archivo + fila → requiere `reason` para auditoría.
 */
import { randomUUID } from "crypto";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { supabase } from "../lib/supabase.js";
import * as R from "../services/artifact-renderer.service.js";

const BUCKET = "vera-artifacts";
const DOC_TYPES = new Set(["report", "analysis", "informe", "presentation", "infographic", "document", "table"]);
const DEFAULT_FORMAT = {
  report: "pdf", analysis: "pdf", informe: "pdf",
  presentation: "pdf", infographic: "png", table: "xlsx", document: "docx",
};
const MIME = {
  pdf: "application/pdf", png: "image/png", csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
};

function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artefacto";
}

function normalizeSheets(data) {
  if (!data) return [{ name: "Hoja1", rows: [["(sin datos)"]] }];
  if (Array.isArray(data.sheets)) return data.sheets.map((s) => ({ name: s.name, rows: s.rows || [] }));
  if (Array.isArray(data.rows)) {
    const rows = data.columns ? [data.columns, ...data.rows] : data.rows;
    return [{ name: data.name || "Hoja1", rows }];
  }
  if (Array.isArray(data)) return [{ name: "Hoja1", rows: data }];
  return [{ name: "Hoja1", rows: [["(sin datos)"]] }];
}

export async function createArtifact(params, brandContainerId, organizationId, userId) {
  const p = params?.params ? params.params : (params || {});
  const type = String(p.type || "").toLowerCase();
  const title = p.title;
  const reason = p.reason;
  if (!DOC_TYPES.has(type)) throw new Error(`createArtifact: 'type' inválido. Usa: ${[...DOC_TYPES].join(", ")}`);
  if (!title) throw new Error("createArtifact: 'title' requerido");
  if (!reason) throw new Error("createArtifact: 'reason' requerido para auditoría");

  const ext = String(p.format || DEFAULT_FORMAT[type] || "pdf").toLowerCase();
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const bcid = bc?.id || brandContainerId || null;
  const kit = await R.loadBrandKit(bcid, organizationId);

  // ── Render ──
  let buffer, finalExt = ext;
  const content = p.content || "";
  const data = p.data;

  if (p.html) {
    // Diseño BESPOKE: Vera diseñó el documento HTML completo (skill diseno-creacion-archivos).
    // Lo renderizamos tal cual (con auto-fit anti-recorte). PNG para infografía, PDF para el resto.
    const png = ext === "png" || type === "infographic";
    buffer = png ? await R.renderHtmlPng(p.html) : await R.renderHtmlPdf(p.html);
    finalExt = png ? "png" : "pdf";
  } else if (type === "table") {
    if (ext === "csv") { buffer = R.rowsToCsv(normalizeSheets(data)[0].rows); finalExt = "csv"; }
    else { buffer = R.rowsToXlsx(normalizeSheets(data)); finalExt = "xlsx"; }
  } else if (type === "document") {
    buffer = await R.mdToDocx(content, kit, title); finalExt = "docx";
  } else if (type === "presentation") {
    buffer = await R.htmlToPdf(R.deckHtml(kit, { title, markdown: content }), { landscape: true }); finalExt = "pdf";
  } else if (type === "infographic") {
    buffer = await R.htmlToPng(R.infographicHtml(kit, { title, markdown: content, data }), { width: 1080 }); finalExt = "png";
  } else { // report | analysis | informe
    buffer = await R.htmlToPdf(R.reportHtml(kit, { title, subtitle: p.subtitle, markdown: content }), {}); finalExt = "pdf";
  }

  if (!buffer || !buffer.length) throw new Error("createArtifact: el render produjo un archivo vacío");

  // ── Persistir ──
  const id = randomUUID();
  const path = `${organizationId}/${bcid || "org"}/${id}-${slugify(title)}.${finalExt}`;
  const up = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: MIME[finalExt] || "application/octet-stream", upsert: true,
  });
  if (up.error) throw new Error(`createArtifact upload: ${up.error.message}`);
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { error: dbErr } = await supabase.from("vera_artifacts").insert({
    id, organization_id: organizationId, brand_container_id: bcid,
    conversation_id: p.conversation_id || null, created_by: userId || null,
    type, title, format: finalExt, storage_bucket: BUCKET, storage_path: path,
    public_url: pub.publicUrl, bytes: buffer.length,
    metadata: { reason, brand: kit.nombreMarca || null },
  });
  if (dbErr) throw new Error(`createArtifact db: ${dbErr.message}`);

  return {
    success: true, artifact_id: id, title, type, format: finalExt,
    url: pub.publicUrl, bytes: buffer.length, brand: kit.nombreMarca || null,
    message: `Artefacto "${title}" (${finalExt.toUpperCase()}) generado y listo para descargar.`,
  };
}

/**
 * listArtifacts — historial de artefactos generados (read-only).
 * params: { limit?: 1..50, conversation_id?: uuid }
 */
export async function listArtifacts(params, brandContainerId, organizationId) {
  const p = params?.params ? params.params : (params || {});
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 10, 1), 50);
  let q = supabase.from("vera_artifacts")
    .select("id,type,title,format,public_url,bytes,created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false }).limit(limit);
  if (p.conversation_id) q = q.eq("conversation_id", p.conversation_id);
  const { data, error } = await q;
  if (error) throw new Error(`listArtifacts: ${error.message}`);
  return { success: true, artifacts: data || [] };
}

/**
 * getBrandKit — devuelve la identidad visual de la marca (colores, fuentes, logo,
 * tono, tagline) para que Vera DISEÑE el archivo a medida (ver skill
 * diseno-creacion-archivos). Llama esto ANTES de createArtifact con html.
 */
export async function getBrandKit(params, brandContainerId, organizationId) {
  const p = params?.params ? params.params : (params || {});
  const bc = await resolveBrandContainer(p.brand_container_id || brandContainerId, organizationId);
  const bcid = bc?.id || brandContainerId || null;
  const kit = await R.loadBrandKit(bcid, organizationId);
  return {
    success: true,
    brand: kit.nombreMarca || null,
    tono: kit.tono || null,
    tagline: kit.tagline || null,
    colors: kit.colors,        // { primary, secondary, accent, text, bg, muted }
    fonts: kit.fonts,          // { heading, body }
    fontFaces: kit.fontFaces,  // [{ family, url, weight }]
    logo_url: kit.logoUrl || null,
    design_guide: [
      "Eres una DISEÑADORA senior. Diseña el archivo a medida (bespoke), NUNCA con una plantilla genérica.",
      "RESTRICCIÓN DURA de marca: usa SOLO estos colores (declára­los como CSS vars en :root) + neutros derivados de ellos; SOLO estas fuentes (si no hay, una superfamilia profesional vía Google Fonts, nunca la del sistema); el logo si hay (si no, lockup tipográfico con el nombre); el tono gobierna el carácter visual. La marca es el ACENTO (~10%), NO el fondo (60% neutro).",
      "El CONTENIDO NUNCA se desborda ni se recorta: si una sección es densa, repártela en más slides; jamás la aprietes hasta que se salga.",
      "NINGÚN slide vacío ni medio vacío: cada uno sustancialmente lleno, ocupando el alto.",
      "CONTRASTE legible (WCAG AA): casi-negro sobre claro, blanco sobre oscuro/rojo; nunca claro sobre claro.",
      "DATOS como visual, no texto corrido: rankings→tabla o barras; scores→score cards; métricas→KPI cards (número grande + label); SKUs→cards.",
      "Jerarquía por tamaño+peso+color; un foco por página; escala tipográfica modular; espaciado en grilla de 8px; VARÍA el layout entre páginas.",
      "EVITA: franjas/banners diagonales, footers que chocan, doble titular redundante, bullets en todo, comillas rectas, gradientes/sombras decorativos, clip art, pie 3D, gridlines pesados, todo centrado en una banda con vacíos.",
      "Deck: cada .slide = 1280×720, @page{size:1280px 720px;margin:0}, print-color-adjust:exact en *, break-after:page. Devuelve un HTML5 completo y autocontenido (CSS en un <style>; sin assets externos salvo fuentes; gráficos→SVG/CSS inline).",
      "Entrega: pasa el documento HTML completo a createArtifact en params.html (type: presentation|report|infographic…). Se renderiza tal cual con auto-fit anti-recorte.",
    ].join(" "),
  };
}
