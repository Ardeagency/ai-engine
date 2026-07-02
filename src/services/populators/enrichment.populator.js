/**
 * enrichment.populator.js
 *
 * Mission `vera_enrich_product`: usa Anthropic Claude para llenar campos
 * descriptivos de un producto que vienen vacíos desde la importación raw
 * de plataformas (Shopify, Amazon, etc.):
 *   - beneficios_principales (ARRAY text)
 *   - diferenciadores         (ARRAY text)
 *   - casos_de_uso            (ARRAY text)
 *   - caracteristicas_visuales (ARRAY text)
 *   - materiales_composicion   (ARRAY text)
 *
 * El usuario pidió explícitamente OpenAI/Anthropic para esta tarea
 * (excepción a la regla "no LLM en background"). Idempotente: si los
 * campos ya están llenos, se salta el producto sin gastar tokens.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import { load } from "cheerio";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const UA = "Mozilla/5.0 (compatible; AISmartContentBot/1.0; +https://aismartcontent.io)";
const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

async function fetchTO(url, ms = 10000, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

// Scrapea la pagina del producto: descripcion mas rica + URLs de imagen reales.
async function scrapeProductPage(url) {
  const res = await fetchTO(url, 10000);
  if (!res.ok) return null;
  const html = await res.text();
  const $ = load(html);
  const abs = (u) => { try { return new URL(u, url).href; } catch { return null; } };
  let description = "";
  const images = [];
  // JSON-LD Product
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let json = JSON.parse($(el).html() || "{}");
      const arr = Array.isArray(json) ? json : (json["@graph"] || [json]);
      for (const o of arr) {
        const t = o["@type"];
        if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) {
          if (o.description && o.description.length > description.length) description = o.description;
          const im = o.image;
          (Array.isArray(im) ? im : [im]).forEach((x) => { const u = abs(typeof x === "string" ? x : x?.url); if (u) images.push(u); });
        }
      }
    } catch (_) { /* ignore */ }
  });
  // OG fallbacks
  if (!description) description = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
  const og = $('meta[property="og:image"]').attr("content"); if (og) { const u = abs(og); if (u) images.push(u); }
  return { description: (description || "").trim(), images: [...new Set(images)].slice(0, 3) };
}

// Descarga imagenes a product-images bucket y reescribe product_images como 'stored'.
async function storeProductImages(productId, imageUrls) {
  if (!imageUrls?.length) return 0;
  let stored = 0;
  const rows = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const r = await fetchTO(imageUrls[i], 10000);
      if (!r.ok) continue;
      const ctype = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!ctype.startsWith("image/")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200 || buf.length > 5 * 1024 * 1024) continue;
      const ext = EXT_BY_TYPE[ctype] || "jpg";
      const path = `products/${productId}/img_${i}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("product-images").upload(path, buf, { contentType: ctype, upsert: true });
      if (upErr) { console.warn("[enrich] img upload:", upErr.message); continue; }
      const { data: pub } = supabase.storage.from("product-images").getPublicUrl(path);
      if (!pub?.publicUrl) continue;
      rows.push({ product_id: productId, image_url: pub.publicUrl, storage_path: path, image_type: i === 0 ? "principal" : "galeria", image_order: i, bytes: buf.length, mime_type: ctype, download_status: "stored" });
      stored++;
    } catch (e) { /* siguiente */ }
  }
  if (rows.length) {
    // Reemplazar las imagenes externas 'pending' por las almacenadas.
    await supabase.from("product_images").delete().eq("product_id", productId);
    await supabase.from("product_images").insert(rows);
  }
  return stored;
}

async function callAnthropic({ system, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in env");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  return (json?.content?.[0]?.text || "").trim();
}

const SYSTEM_PROMPT = `Eres un experto en marketing y product copywriting. Tu tarea: dado el nombre, descripción y tipo de un producto, generar 5 listas concisas en español:
- beneficios_principales: 3-5 beneficios reales del producto (qué gana el cliente)
- diferenciadores: 2-4 atributos únicos vs. competencia
- casos_de_uso: 3-5 contextos típicos de uso
- caracteristicas_visuales: 3-5 atributos físicos visibles (color, forma, tamaño, textura)
- materiales_composicion: 2-5 materiales/ingredientes principales (si aplica; lista vacía si no)

Reglas:
- Cada item máximo 80 caracteres
- En español neutro, voz comercial pero honesta
- Sin emojis, sin signos !!! o ???
- Si no tienes evidencia para un campo, devuelve lista vacía []
- Output ESTRICTAMENTE JSON, nada antes ni después`;

const SERVICE_SYSTEM_PROMPT = `Eres un experto en marketing de servicios y copywriting B2B/B2C. Tu tarea: dado el nombre, descripción y duración de un servicio, generar 5 listas concisas en español:
- beneficios_principales: 3-5 beneficios reales del servicio (qué resultado gana el cliente)
- diferenciadores: 2-4 atributos únicos vs. competencia
- casos_de_uso: 3-5 contextos/situaciones típicas donde se contrata
- entregables: 2-5 cosas concretas que recibe el cliente (reporte, sesión, activo, soporte)
- metodologia_pasos: 3-6 pasos del proceso, en orden (descubrimiento, ejecución, entrega)

Reglas:
- Cada item máximo 90 caracteres
- En español neutro, voz comercial pero honesta
- Sin emojis, sin signos !!! o ???
- Si no tienes evidencia para un campo, devuelve lista vacía []
- Output ESTRICTAMENTE JSON, nada antes ni después`;

export class EnrichmentPopulator extends BasePopulator {
  constructor() { super("enrichment"); }

  // No tiene bootstrap propio — se invoca producto por producto.
  subjobSequence() { return []; }

  handles() { return ["vera_enrich_product", "vera_enrich_service"]; }

  dispatch(missionType) {
    if (missionType === "vera_enrich_product") return this.enrichProduct;
    if (missionType === "vera_enrich_service") return this.enrichService;
    return null;
  }

  async process(job) {
    const mt = job?.payload?.mission_type;
    if (mt === "vera_enrich_product") return this.enrichProduct(job);
    if (mt === "vera_enrich_service") return this.enrichService(job);
    throw new Error(`enrichment: unknown mission ${mt}`);
  }

  async enrichProduct(job) {
    const productId = job?.payload?.product_id;
    if (!productId) throw new Error("vera_enrich_product: missing product_id");

    const { data: prod, error: prodErr } = await supabase
      .from("products")
      .select("id, nombre_producto, descripcion_producto, tipo_producto, beneficios_principales, diferenciadores, casos_de_uso, caracteristicas_visuales, materiales_composicion, metadata")
      .eq("id", productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!prod) throw new Error(`Product not found: ${productId}`);

    // Scrapeo REAL de la pagina del producto (si tiene URL): descripcion mas rica
    // + descarga de imagenes a storage (permanencia). Best-effort.
    let richDesc = prod.descripcion_producto || "";
    let imagesStored = 0;
    const srcUrl = prod.metadata?.source_url;
    if (srcUrl && /^https?:\/\//i.test(String(srcUrl))) {
      try {
        const scraped = await scrapeProductPage(String(srcUrl));
        if (scraped) {
          if (scraped.description && scraped.description.length > richDesc.length) {
            richDesc = scraped.description;
            await supabase.from("products").update({ descripcion_producto: richDesc.slice(0, 4000) }).eq("id", productId);
          }
          imagesStored = await storeProductImages(productId, scraped.images);
        }
      } catch (e) { console.warn(`[enrich] scrape ${productId}:`, e.message); }
    }

    // Idempotencia: si ya hay benefits + diff + use, no re-procesar (ahorra tokens)
    const hasBenefits = Array.isArray(prod.beneficios_principales) && prod.beneficios_principales.length > 0;
    const hasDiff     = Array.isArray(prod.diferenciadores) && prod.diferenciadores.length > 0;
    const hasUse      = Array.isArray(prod.casos_de_uso) && prod.casos_de_uso.length > 0;
    if (hasBenefits && hasDiff && hasUse) {
      return { ok: true, status: "skipped_already_enriched", product_id: productId, images_stored: imagesStored };
    }

    const userMessage = JSON.stringify({
      nombre:      prod.nombre_producto,
      descripcion: (richDesc || "").slice(0, 1500),
      tipo:        prod.tipo_producto,
      tags_origen: prod.metadata?.shopify_tags || prod.metadata?.tags || null,
      vendor:      prod.metadata?.shopify_vendor || null,
    }, null, 2);

    let parsed;
    try {
      const text = await callAnthropic({ system: SYSTEM_PROMPT, user: userMessage });
      const cleaned = text.replace(/^```json?/i, "").replace(/```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`enrichment LLM/parse failed: ${e.message}`);
    }

    const sanitize = (arr) => Array.isArray(arr)
      ? arr.filter(s => typeof s === "string" && s.trim().length > 0).map(s => s.trim().slice(0, 200))
      : [];

    const update = {
      beneficios_principales:    sanitize(parsed.beneficios_principales),
      diferenciadores:           sanitize(parsed.diferenciadores),
      casos_de_uso:              sanitize(parsed.casos_de_uso),
      caracteristicas_visuales:  sanitize(parsed.caracteristicas_visuales),
      materiales_composicion:    sanitize(parsed.materiales_composicion),
      metadata: {
        ...(prod.metadata || {}),
        enriched_by:    `${MODEL}`,
        enriched_at:    new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };

    const { error: upErr } = await supabase.from("products").update(update).eq("id", productId);
    if (upErr) throw upErr;

    return {
      ok:                       true,
      product_id:                productId,
      benefits_count:            update.beneficios_principales.length,
      differentiators_count:     update.diferenciadores.length,
      use_cases_count:           update.casos_de_uso.length,
      visual_count:              update.caracteristicas_visuales.length,
      materials_count:           update.materiales_composicion.length,
      images_stored:             imagesStored,
      model:                     MODEL,
    };
  }

  async enrichService(job) {
    const serviceId = job?.payload?.service_id;
    if (!serviceId) throw new Error("vera_enrich_service: missing service_id");

    const { data: svc, error: svcErr } = await supabase
      .from("services")
      .select("id, nombre_servicio, descripcion_servicio, duracion_estimada, beneficios_principales, diferenciadores, casos_de_uso, entregables, metodologia_pasos, url_servicio")
      .eq("id", serviceId)
      .maybeSingle();
    if (svcErr) throw svcErr;
    if (!svc) throw new Error(`Service not found: ${serviceId}`);

    // Scrapeo REAL de la pagina del servicio (si tiene URL): descripcion mas rica.
    let richDesc = svc.descripcion_servicio || "";
    const srcUrl = svc.url_servicio;
    if (srcUrl && /^https?:\/\//i.test(String(srcUrl))) {
      try {
        const scraped = await scrapeProductPage(String(srcUrl));
        if (scraped?.description && scraped.description.length > richDesc.length) {
          richDesc = scraped.description;
          await supabase.from("services").update({ descripcion_servicio: richDesc.slice(0, 4000) }).eq("id", serviceId);
        }
      } catch (e) { console.warn(`[enrich] scrape service ${serviceId}:`, e.message); }
    }

    // Idempotencia: si ya hay benefits + diff + use, no re-procesar.
    const hasBenefits = Array.isArray(svc.beneficios_principales) && svc.beneficios_principales.length > 0;
    const hasDiff     = Array.isArray(svc.diferenciadores) && svc.diferenciadores.length > 0;
    const hasUse      = Array.isArray(svc.casos_de_uso) && svc.casos_de_uso.length > 0;
    if (hasBenefits && hasDiff && hasUse) {
      return { ok: true, status: "skipped_already_enriched", service_id: serviceId };
    }

    const userMessage = JSON.stringify({
      nombre:      svc.nombre_servicio,
      descripcion: (richDesc || "").slice(0, 1500),
      duracion:    svc.duracion_estimada || null,
    }, null, 2);

    let parsed;
    try {
      const text = await callAnthropic({ system: SERVICE_SYSTEM_PROMPT, user: userMessage });
      const cleaned = text.replace(/^```json?/i, "").replace(/```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`service enrichment LLM/parse failed: ${e.message}`);
    }

    const sanitize = (arr) => Array.isArray(arr)
      ? arr.filter(s => typeof s === "string" && s.trim().length > 0).map(s => s.trim().slice(0, 200))
      : [];

    const update = {
      beneficios_principales: sanitize(parsed.beneficios_principales),
      diferenciadores:        sanitize(parsed.diferenciadores),
      casos_de_uso:           sanitize(parsed.casos_de_uso),
      entregables:            sanitize(parsed.entregables),
      metodologia_pasos:      sanitize(parsed.metodologia_pasos),
      updated_at: new Date().toISOString(),
    };

    const { error: upErr } = await supabase.from("services").update(update).eq("id", serviceId);
    if (upErr) throw upErr;

    return {
      ok:                    true,
      service_id:            serviceId,
      benefits_count:        update.beneficios_principales.length,
      differentiators_count: update.diferenciadores.length,
      use_cases_count:       update.casos_de_uso.length,
      deliverables_count:    update.entregables.length,
      steps_count:           update.metodologia_pasos.length,
      model:                 MODEL,
    };
  }
}
