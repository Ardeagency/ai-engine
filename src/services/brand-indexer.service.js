/**
 * Brand Indexer Service — pobla ai_brand_vectors con embeddings de la marca.
 *
 * Fuentes indexadas:
 *   • brand_profiles      — secciones de identidad (filosofia, mision, etc.)
 *   • brand_containers    — DNA verbal/visual, propuesta_valor, palabras_clave
 *   • brand_entities      — descripciones de entidades de marca
 *   • products / services — catálogo
 *   • brand_assets        — futura extensión (texto extraído de PDFs/docs)
 *
 * Modelo: OpenAI text-embedding-3-large con dimensions=1536 (Matryoshka).
 * Justificación: bilingüe ES+EN nativo, mejor recall semántico que MiniLM
 * para texto conceptual de marca creativa. Costo ~$0.13 / 1M tokens — para
 * Arde, indexar todo cuesta ~$0.0013 (un mil-ésimo de centavo de dólar).
 *
 * Optimización idempotencia: hash SHA-256 del contenido en metadata.content_hash.
 * Si el hash existe ya en DB → no se llama a OpenAI (cero costo en re-runs).
 *
 * NO es Vera ni LLM de razonamiento. Es un encoder de texto → vector.
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

const OPENAI_KEY  = process.env.OPENAI_API_KEY;
const EMBED_MODEL = "text-embedding-3-large";
const EMBED_DIM   = 1536; // matchea ai_brand_vectors.embedding (Matryoshka truncation)
const MAX_CHARS   = 30000; // ~7500 tokens, dentro del límite del modelo (8191)

function _sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Error tipado para que el caller pueda abortar el run completo (circuit-breaker):
// si la quota mensual está agotada, reintentar los chunks restantes es inútil.
class QuotaExhaustedError extends Error {
  constructor(msg) { super(msg); this.name = "QuotaExhaustedError"; }
}

const EMBED_MAX_RETRIES = 3;     // reintentos ante 429 de rate-limit / 5xx
const EMBED_BACKOFF_MS  = 2_000; // base exponencial: 2s, 4s, 8s

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _embed(text) {
  let lastErr = null;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    if (attempt > 0) await _sleep(EMBED_BACKOFF_MS * 2 ** (attempt - 1));

    let res;
    try {
      res = await fetch("https://api.openai.com/v1/embeddings", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model:      EMBED_MODEL,
          input:      text.slice(0, MAX_CHARS),
          dimensions: EMBED_DIM,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastErr = new Error(`OpenAI embeddings network: ${e.message}`); // timeout/red → reintentable
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      return json.data?.[0]?.embedding;
    }

    const err = await res.text();

    // 429 con insufficient_quota = saldo/quota mensual agotada → no reintentar nada.
    if (res.status === 429 && err.includes("insufficient_quota")) {
      throw new QuotaExhaustedError(`OpenAI quota agotada: ${err.slice(0, 200)}`);
    }

    // 429 rate-limit o 5xx → reintentable con backoff (respeta Retry-After si viene).
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`OpenAI embeddings ${res.status}: ${err.slice(0, 200)}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (retryAfter > 0 && attempt < EMBED_MAX_RETRIES) await _sleep(Math.min(retryAfter, 30) * 1000);
      continue;
    }

    // 4xx restantes (400 input inválido, 401, etc.) → error permanente, sin retry.
    throw new Error(`OpenAI embeddings ${res.status}: ${err.slice(0, 200)}`);
  }
  throw lastErr || new Error("OpenAI embeddings: agotados los reintentos");
}

function _chunkText(text, maxChars = MAX_CHARS) {
  if (!text || text.length <= maxChars) return [text || ""];
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChars) {
      if (current) chunks.push(current);
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function _indexSource({ orgId, brandId, bucket, path, type, content }) {
  if (!content || content.trim().length < 10) return { inserted: 0, skipped: 0, embed_errors: 0, db_errors: 0, last_error: null };

  const chunks = _chunkText(content);
  let inserted = 0, skipped = 0, embedErrors = 0, dbErrors = 0;
  let lastError = null;

  const { data: existing } = await supabase
    .from("ai_brand_vectors")
    .select("id, chunk_index, metadata")
    .eq("brand_container_id", brandId)
    .eq("source_bucket", bucket)
    .eq("source_path", path);

  const existingByIndex = new Map((existing || []).map((r) => [r.chunk_index, r]));

  for (const e of existing || []) {
    if (e.chunk_index >= chunks.length) {
      await supabase.from("ai_brand_vectors").delete().eq("id", e.id);
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk     = chunks[i];
    const hash      = _sha256(chunk);
    const prev      = existingByIndex.get(i);
    const prevHash  = prev?.metadata?.content_hash;

    if (prev && prevHash === hash) {
      skipped++;
      continue;
    }

    let embedding;
    try {
      embedding = await _embed(chunk);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e; // breaker: aborta el run, no martilla el resto
      embedErrors++;
      lastError = e.message;
      console.warn(`[brand-indexer] embed falló ${bucket}/${path}#${i}: ${e.message}`);
      continue;
    }

    const row = {
      organization_id:    orgId,
      brand_container_id: brandId,
      source_bucket:      bucket,
      source_path:        path,
      source_type:        type,
      chunk_index:        i,
      content:            chunk,
      embedding,
      metadata: {
        content_hash: hash,
        char_count:   chunk.length,
        model:        EMBED_MODEL,
        dimensions:   EMBED_DIM,
        indexed_at:   new Date().toISOString(),
      },
    };

    if (prev) {
      const { error } = await supabase.from("ai_brand_vectors").update(row).eq("id", prev.id);
      if (error) { dbErrors++; lastError = error.message; console.warn(`[brand-indexer] update ${bucket}/${path}#${i}: ${error.message}`); }
      else inserted++;
    } else {
      const { error } = await supabase.from("ai_brand_vectors").insert(row);
      if (error) { dbErrors++; lastError = error.message; console.warn(`[brand-indexer] insert ${bucket}/${path}#${i}: ${error.message}`); }
      else inserted++;
    }
  }
  return { inserted, skipped, embed_errors: embedErrors, db_errors: dbErrors, last_error: lastError };
}

function _composeProductText(p) {
  return [
    `Producto: ${p.nombre_producto}`,
    p.descripcion_producto,
    p.beneficios_principales?.length     && `Beneficios: ${p.beneficios_principales.join(", ")}`,
    p.diferenciadores?.length            && `Diferenciadores: ${p.diferenciadores.join(", ")}`,
    p.casos_de_uso?.length               && `Casos de uso: ${p.casos_de_uso.join(", ")}`,
    p.materiales_composicion?.length     && `Materiales: ${p.materiales_composicion.join(", ")}`,
    p.url_producto                       && `URL: ${p.url_producto}`,
  ].filter(Boolean).join("\n");
}

function _composeServiceText(s) {
  return [
    `Servicio: ${s.nombre_servicio}`,
    s.descripcion_servicio,
    s.beneficios_principales?.length && `Beneficios: ${s.beneficios_principales.join(", ")}`,
    s.diferenciadores?.length        && `Diferenciadores: ${s.diferenciadores.join(", ")}`,
    s.entregables?.length            && `Entregables: ${s.entregables.join(", ")}`,
    s.metodologia_pasos?.length      && `Metodología: ${s.metodologia_pasos.join(" → ")}`,
  ].filter(Boolean).join("\n");
}

function _composeEntityText(e) {
  return [
    `${e.entity_type}: ${e.name}`,
    e.description,
    e.price && `Precio: ${e.price} ${e.currency || "USD"}`,
  ].filter(Boolean).join("\n");
}

export async function runBrandIndexer(brandContainerId, organizationId) {
  try {
    return await _runBrandIndexer(brandContainerId, organizationId);
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      // Run abortado limpio: 1 sola llamada fallida en vez de N. Revive solo al recargar quota.
      console.warn(`[brand-indexer] run abortado por quota: ${e.message}`);
      return { indexed: 0, skipped_unchanged: 0, embed_errors: 1, db_errors: 0, breakdown: {}, error: `openai_quota_exhausted: ${e.message.slice(0, 200)}` };
    }
    throw e;
  }
}

async function _runBrandIndexer(brandContainerId, organizationId) {
  if (!OPENAI_KEY) {
    return { error: "OPENAI_API_KEY no configurada", indexed: 0, skipped: 0 };
  }

  let totalIns = 0, totalSkip = 0, totalEmbedErrors = 0, totalDbErrors = 0;
  let lastError = null;
  const breakdown = {};
  const accumulate = (r) => {
    totalIns += r.inserted; totalSkip += r.skipped;
    totalEmbedErrors += (r.embed_errors || 0);
    totalDbErrors    += (r.db_errors    || 0);
    if (r.last_error) lastError = r.last_error;
  };

  const { data: profiles } = await supabase
    .from("brand_profiles")
    .select("id, section, content")
    .eq("brand_container_id", brandContainerId);
  for (const p of profiles || []) {
    const r = await _indexSource({
      orgId:   organizationId,
      brandId: brandContainerId,
      bucket:  "brand_profiles",
      path:    p.id,
      type:    p.section || "profile",
      content: p.content,
    });
    accumulate(r);
  }
  breakdown.brand_profiles = profiles?.length || 0;

  const { data: bc } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca, propuesta_valor, mision_vision, arquetipo, nicho_core, sub_nichos, palabras_clave, palabras_prohibidas, objetivos_estrategicos, verbal_dna, visual_dna, idiomas_contenido, mercado_objetivo")
    .eq("id", brandContainerId)
    .maybeSingle();

  if (bc) {
    const dnaFields = [
      { type: "propuesta_valor",     text: bc.propuesta_valor },
      { type: "mision_vision",       text: bc.mision_vision },
      { type: "arquetipo_y_nicho",   text: [
          bc.arquetipo && `Arquetipo: ${bc.arquetipo}`,
          bc.nicho_core && `Nicho core: ${bc.nicho_core}`,
          bc.sub_nichos?.length && `Sub-nichos: ${bc.sub_nichos.join(", ")}`,
        ].filter(Boolean).join("\n") },
      { type: "palabras_clave",      text: (bc.palabras_clave || []).join(", ") },
      { type: "palabras_prohibidas", text: (bc.palabras_prohibidas || []).join(", ") },
      { type: "objetivos",           text: (bc.objetivos_estrategicos || []).join("\n") },
      { type: "verbal_dna",          text: bc.verbal_dna && Object.keys(bc.verbal_dna).length ? JSON.stringify(bc.verbal_dna, null, 2) : "" },
      { type: "visual_dna",          text: bc.visual_dna && Object.keys(bc.visual_dna).length ? JSON.stringify(bc.visual_dna, null, 2) : "" },
      { type: "mercado_y_idiomas",   text: [
          bc.mercado_objetivo?.length && `Mercados: ${bc.mercado_objetivo.join(", ")}`,
          bc.idiomas_contenido?.length && `Idiomas: ${bc.idiomas_contenido.join(", ")}`,
        ].filter(Boolean).join("\n") },
    ];
    let dnaIndexed = 0;
    for (const f of dnaFields) {
      if (!f.text || f.text.length < 10) continue;
      const r = await _indexSource({
        orgId:   organizationId,
        brandId: brandContainerId,
        bucket:  "brand_containers",
        path:    `${bc.id}#${f.type}`,
        type:    f.type,
        content: f.text,
      });
      accumulate(r);
      dnaIndexed++;
    }
    breakdown.brand_dna_fields = dnaIndexed;
  }

  const { data: entities } = await supabase
    .from("brand_entities")
    .select("id, entity_type, name, description, price, currency")
    .eq("organization_id", organizationId);
  for (const e of entities || []) {
    const r = await _indexSource({
      orgId:   organizationId,
      brandId: brandContainerId,
      bucket:  "brand_entities",
      path:    e.id,
      type:    e.entity_type,
      content: _composeEntityText(e),
    });
    accumulate(r);
  }
  breakdown.brand_entities = entities?.length || 0;

  const { data: products } = await supabase
    .from("products")
    .select("id, nombre_producto, descripcion_producto, beneficios_principales, diferenciadores, casos_de_uso, materiales_composicion, url_producto")
    .eq("organization_id", organizationId);
  for (const p of products || []) {
    const r = await _indexSource({
      orgId:   organizationId,
      brandId: brandContainerId,
      bucket:  "products",
      path:    p.id,
      type:    "product",
      content: _composeProductText(p),
    });
    accumulate(r);
  }
  breakdown.products = products?.length || 0;

  const { data: services } = await supabase
    .from("services")
    .select("id, nombre_servicio, descripcion_servicio, beneficios_principales, diferenciadores, entregables, metodologia_pasos")
    .eq("organization_id", organizationId);
  for (const s of services || []) {
    const r = await _indexSource({
      orgId:   organizationId,
      brandId: brandContainerId,
      bucket:  "services",
      path:    s.id,
      type:    "service",
      content: _composeServiceText(s),
    });
    accumulate(r);
  }
  breakdown.services = services?.length || 0;

  const totalSources = (breakdown.brand_profiles || 0) + (breakdown.brand_dna_fields || 0)
                     + (breakdown.brand_entities || 0) + (breakdown.products || 0) + (breakdown.services || 0);
  let error = null;
  if (totalIns === 0 && totalSkip === 0 && totalSources > 0) {
    if (totalEmbedErrors > 0) {
      error = `embeddings_failed_all (${totalEmbedErrors} embed errors): ${(lastError || "").slice(0, 200)}`;
    } else if (totalDbErrors > 0) {
      error = `db_writes_failed_all (${totalDbErrors} db errors): ${(lastError || "").slice(0, 200)}`;
    } else {
      error = "no_indexable_content (sources fetched but textos < 10 chars)";
    }
  } else if (totalEmbedErrors > 0 || totalDbErrors > 0) {
    error = `partial: embed_errors=${totalEmbedErrors}, db_errors=${totalDbErrors}, last=${(lastError || "").slice(0, 100)}`;
  }

  return {
    indexed:           totalIns,
    skipped_unchanged: totalSkip,
    embed_errors:      totalEmbedErrors,
    db_errors:         totalDbErrors,
    breakdown,
    error,
  };
}
