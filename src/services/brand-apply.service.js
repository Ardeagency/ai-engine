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
    // Como habla de verdad: frases suyas y los dos limites del tono.
    frases_propias: payload.frases_propias || [],
    ejemplos_si: payload.ejemplos_si || [],
    ejemplos_no: payload.ejemplos_no || [],
    diferenciadores: payload.diferenciadores || [],
    momentos_de_uso: payload.momentos_de_uso || [],
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
    // Trazabilidad: con que motores se construyo, que tan confiable es cada
    // bloque y sobre cuanto material se leyo. Lo inferido y lo verificado no
    // pueden entrar a la marca como si valieran lo mismo.
    metadata: payload._meta ? { auto_builder: payload._meta } : undefined,
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

  // 5. Pilares narrativos DECLARADOS. Van marcados como tales: la misma tabla
  //    recibe los pilares que el analyzer DETECTA de los posts reales, y
  //    mezclarlos dejaba filas con post_count 0 que ensucian los dashboards.
  const pillars = (payload.pilares || []).filter(Boolean).map((p) => ({
    brand_container_id: containerId, organization_id: organizationId,
    pillar_name: p, pillar_type: "declarado",
    description: "Pilar declarado por la marca (leido del sitio al crear la org), no detectado de publicaciones",
  }));
  if (pillars.length) await supabase.from("brand_narrative_pillars").insert(pillars);

  // 5b. AUDIENCIAS. Es la tabla mas rica del esquema y hasta 2026-07 el creador
  //     de orgs no la llenaba nunca; sin ella quedaban muertos el fusionador de
  //     demografia real del social-scraper (que escribe en real_*), el generador
  //     de ancla de ADN y el alineamiento de audiencia.
  let personas = 0;
  const audiencias = Array.isArray(payload.audiencias) ? payload.audiencias : [];
  if (audiencias.length) {
    const rows = audiencias.filter((a) => a && a.name).map((a) => ({
      organization_id:     organizationId,
      brand_container_id:  containerId,
      name:                String(a.name).slice(0, 120),
      description:         a.description || null,
      awareness_level:     a.awareness_level || null,
      dolores:             a.dolores || [],
      deseos:              a.deseos || [],
      objeciones:          a.objeciones || [],
      gatillos_compra:     a.gatillos_compra || [],
      estilo_lenguaje:     a.estilo_lenguaje || [],
      datos_demograficos:  a.datos_demograficos || [],
      datos_psicograficos: a.datos_psicograficos || [],
      target_age_min:      Number.isFinite(a.target_age_min) ? a.target_age_min : null,
      target_age_max:      Number.isFinite(a.target_age_max) ? a.target_age_max : null,
      target_genders:      a.target_genders || [],
      is_featured:         a.es_principal === true,
      is_active:           true,
      created_via:         "auto_builder",
      real_interests:      { por_que_existe: a.por_que_existe || null, confianza: payload?._meta?.confianza?.audiencias || null },
    }));
    if (rows.length) {
      const { error } = await supabase.from("audience_personas").insert(rows);
      if (error) console.warn("[apply] audiencias:", error.message);
      else personas = rows.length;
    }
  }

  // 5c. REGLAS DE NEGOCIO (envios, pagos, mayoristas…). Extraidas literal del
  //     sitio, con su cita, para que el agente pueda responderlas sin inventar.
  let reglas = 0;
  const reglasNegocio = Array.isArray(payload.reglas_negocio) ? payload.reglas_negocio : [];
  if (reglasNegocio.length) {
    const rows = reglasNegocio.filter((r) => r && r.tipo && r.resumen).map((r) => ({
      brand_container_id: containerId,
      rule_type:  r.tipo,
      rule_value: {
        resumen:    r.resumen,
        detalle:    r.detalle || null,
        cita:       r.cita || null,
        fuente_url: r.fuente_url || null,
        origen:     "auto_builder",
        confianza:  payload?._meta?.confianza?.reglas || null,
      },
    }));
    if (rows.length) {
      const { error } = await supabase.from("brand_rules").insert(rows);
      if (error) console.warn("[apply] reglas de negocio:", error.message);
      else reglas = rows.length;
    }
  }

  // 6. Logo (best-effort — nunca rompe el apply)
  let logo = null;
  if (seedUrl) {
    try { logo = await fetchAndStoreLogo(organizationId, seedUrl); }
    catch (e) { console.warn("[logo] failed:", e.message); }
  }

  return {
    applied: true, container_id: containerId,
    colors: colors.length, fonts: fonts.length, pillars: pillars.length,
    personas, reglas, logo: logo?.url || null,
  };
}
