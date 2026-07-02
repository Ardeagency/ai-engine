/**
 * Brand Apply Service — vuelca el brand_payload del scraper a las tablas reales
 * de la marca (Etapa 1 del auto-builder de org) + descarga el logo.
 *
 * Lo llama el orchestrator tras consolidate() cuando el job tiene organization_id.
 * Mapea: brand_payload → brand_containers (ADN) + brand_colors + brand_fonts +
 * brand_narrative_pillars; y baja el logo del sitio → bucket brand-core →
 * organizations.logo_url. Productos/competencia/monitoreo van en etapas siguientes.
 */
import { supabase } from "../lib/supabase.js";
import { load } from "cheerio";

const UA = "Mozilla/5.0 (compatible; AISmartContentBot/1.0; +https://aismartcontent.io)";

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

// Candidatos de logo en orden de calidad.
function logoCandidates($, baseUrl) {
  const out = [];
  const abs = (href) => { try { return new URL(href, baseUrl).href; } catch { return null; } };
  const sizeOf = (el) => { const m = ($(el).attr("sizes") || "").match(/(\d+)x\d+/); return m ? parseInt(m[1], 10) : 0; };

  // 1. apple-touch-icon (suele ser PNG cuadrado decente)
  $('link[rel~="apple-touch-icon"]').toArray()
    .sort((a, b) => sizeOf(b) - sizeOf(a))
    .forEach((el) => { const u = abs($(el).attr("href")); if (u) out.push(u); });

  // 2. <img> con pinta de logo, preferente en header/nav
  const logoImg = (sel) => $(sel).toArray().forEach((el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    const hint = ($(el).attr("class") || "") + " " + ($(el).attr("id") || "") + " " + ($(el).attr("alt") || "") + " " + src;
    if (/logo/i.test(hint)) { const u = abs(src); if (u) out.push(u); }
  });
  logoImg("header img, nav img, .header img, .navbar img");
  logoImg("img");

  // 3. icon links (favicon) — sorted by sizes desc
  $('link[rel~="icon"], link[rel="shortcut icon"]').toArray()
    .sort((a, b) => sizeOf(b) - sizeOf(a))
    .forEach((el) => { const u = abs($(el).attr("href")); if (u) out.push(u); });

  // 4. og:image (fallback; puede ser banner)
  const og = $('meta[property="og:image"]').attr("content");
  if (og) { const u = abs(og); if (u) out.push(u); }

  return [...new Set(out)];
}

const EXT_BY_TYPE = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp",
  "image/svg+xml": "svg", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
};

async function fetchAndStoreLogo(organizationId, seedUrl) {
  const home = await fetchWithTimeout(seedUrl, {}, 10000);
  if (!home.ok) return null;
  const html = await home.text();
  const $ = load(html);
  const candidates = logoCandidates($, seedUrl).slice(0, 6);

  for (const url of candidates) {
    try {
      const img = await fetchWithTimeout(url, {}, 10000);
      if (!img.ok) continue;
      const ctype = (img.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!ctype.startsWith("image/")) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length < 200 || buf.length > 3 * 1024 * 1024) continue; // descarta vacios/enormes
      const ext = EXT_BY_TYPE[ctype] || "png";
      const path = `organizations/${organizationId}/logo/logo_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("brand-core")
        .upload(path, buf, { contentType: ctype, upsert: true });
      if (upErr) { console.warn("[logo] upload:", upErr.message); continue; }
      const { data: pub } = supabase.storage.from("brand-core").getPublicUrl(path);
      const publicUrl = pub?.publicUrl || null;
      if (!publicUrl) continue;
      await supabase.from("organizations").update({ logo_url: publicUrl }).eq("id", organizationId);
      return { url: publicUrl, source: url };
    } catch (e) { /* siguiente candidato */ }
  }
  return null;
}

export async function applyBrandPayloadToOrg(organizationId, payload, seedUrl = null) {
  if (!organizationId || !payload) return { applied: false, reason: "missing org or payload" };

  // 1. Mercado (brand_container) del org — el shell ya creo uno.
  let { data: container } = await supabase
    .from("brand_containers")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let containerId = container?.id;
  if (!containerId) {
    const { data: org } = await supabase
      .from("organizations").select("name, owner_user_id").eq("id", organizationId).maybeSingle();
    const { data: created, error } = await supabase
      .from("brand_containers")
      .insert({ organization_id: organizationId, user_id: org?.owner_user_id, nombre_marca: org?.name || "Marca" })
      .select("id").single();
    if (error) return { applied: false, reason: `container: ${error.message}` };
    containerId = created.id;
  }

  // 2. ADN del mercado
  const verbal_dna = {
    tono_de_voz: payload.tono_de_voz || null,
    tagline: payload.tagline || null,
    pilares: payload.pilares || [],
    verbos_inspiracion: payload.verbos_inspiracion || [],
    como_comunica: payload.como_comunica || null,
  };
  const visual_dna = {
    estetica: payload.estetica || null,
    preferred_moods: payload.preferred_moods || [],
    signature_hints: payload.signature_hints || [],
    never: payload.never || [],
    palette_extra: payload.palette_extra || [],
  };
  await supabase.from("brand_containers").update({
    nicho_core: payload.nicho_core || null,
    arquetipo: payload.arquetipo || null,
    propuesta_valor: payload.propuesta_valor || null,
    mision_vision: payload.mision_vision || null,
    creative_brief: payload.creative_brief || null,
    objetivos_estrategicos: payload.objetivos_estrategicos || [],
    idiomas_contenido: payload.idiomas_contenido || [],
    mercado_objetivo: payload.mercado_objetivo || [],
    sub_nichos: payload.temas || [],
    palabras_clave: payload.palabras_clave || [],
    palabras_prohibidas: payload.palabras_prohibidas || [],
    verbal_dna, visual_dna,
    updated_at: new Date().toISOString(),
  }).eq("id", containerId);

  // 2b. Nombre REAL de la marca (no el dominio) + slogan en la org y el mercado.
  const orgPatch = {};
  if (payload.brand_name && payload.brand_name.trim()) orgPatch.name = payload.brand_name.trim();
  if (payload.tagline && payload.tagline.trim()) orgPatch.brand_slogan = payload.tagline.trim();
  if (Object.keys(orgPatch).length) {
    await supabase.from("organizations").update(orgPatch).eq("id", organizationId);
    if (orgPatch.name) await supabase.from("brand_containers").update({ nombre_marca: orgPatch.name }).eq("id", containerId);
  }

  // 3. Colores
  const colors = [];
  if (payload.primary_color)   colors.push({ organization_id: organizationId, color_role: "primary",   hex_value: payload.primary_color });
  if (payload.secondary_color) colors.push({ organization_id: organizationId, color_role: "secondary", hex_value: payload.secondary_color });
  (payload.palette_extra || []).slice(0, 4).forEach((hex, i) => {
    if (hex) colors.push({ organization_id: organizationId, color_role: `accent_${i + 1}`, hex_value: hex });
  });
  if (colors.length) await supabase.from("brand_colors").insert(colors);

  // 4. Tipografias
  const fonts = [];
  if (payload.typography_primary)   fonts.push({ organization_id: organizationId, font_family: payload.typography_primary,   font_usage: "primary" });
  if (payload.typography_secondary) fonts.push({ organization_id: organizationId, font_family: payload.typography_secondary, font_usage: "secondary" });
  if (fonts.length) await supabase.from("brand_fonts").insert(fonts);

  // 5. Pilares narrativos
  const pillars = (payload.pilares || []).filter(Boolean).map((p) => ({
    brand_container_id: containerId, organization_id: organizationId, pillar_name: p,
  }));
  if (pillars.length) await supabase.from("brand_narrative_pillars").insert(pillars);

  // 6. Logo (best-effort — nunca rompe el apply)
  let logo = null;
  if (seedUrl) {
    try { logo = await fetchAndStoreLogo(organizationId, seedUrl); }
    catch (e) { console.warn("[logo] failed:", e.message); }
  }

  return { applied: true, container_id: containerId, colors: colors.length, fonts: fonts.length, pillars: pillars.length, logo: logo?.url || null };
}
