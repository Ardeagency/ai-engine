/**
 * dedupe.service.js
 *
 * Decide que hacer con un listado que llega de una plataforma externa
 * (Mercado Libre, Shopify, Woo, Amazon…): crear producto, enlazarlo a uno que ya
 * existe, sumarlo como presentacion, mandarlo a revision o descartarlo.
 *
 * Un marketplace no publica productos, publica LISTADOS. El mismo producto
 * aparece como "Crema De Almendras 240g", "Crema De Almendra Wakeup", "Caja
 * Energy Water 600ml X 12" y "Kit Proteina + Shaker". Comparar titulos completos
 * con Levenshtein no distingue nada de eso: por eso el catalogo de WAKEUP llego a
 * 77 filas para 16 productos reales (limpieza 2026-07-22).
 *
 * Orden de decision:
 *   1. external_resource_map exacto (misma plataforma + external_id) -> re-sync.
 *   2. product_ingest_blocklist -> el equipo ya dijo que ese listado no es
 *      producto: se descarta sin recrearlo.
 *   3. Identificadores duros (GTIN/EAN/barcode, SKU) -> match fuerte y
 *      ATRAVIESA PLATAFORMAS: es lo que hace que conectar Shopify enlace con lo
 *      que ya trajo Mercado Libre en vez de duplicar.
 *   4. Clasificacion del titulo: pack o bundle -> no es producto. Se enlaza al
 *      producto base si se puede identificar, y se descarta como fila propia.
 *   5. Nucleo del nombre (sin marca, sin tamano, sin cantidades, sin reclamos):
 *      igual -> mismo producto. Si cambia el tamano, es una PRESENTACION nueva.
 *   6. Nucleo parecido (0.8-1) -> revision manual.
 *
 * Todo el match es por brand_container, nunca por plataforma: un producto es de
 * la marca, no del canal donde se publica.
 *
 * Sin LLM (regla del usuario): analisis lexico determinista y auditable.
 */
import { supabase } from "../../lib/supabase.js";
import {
  parseListing, normalizeName, coreSimilarity, claimsOnlyContainment,
} from "./product-classifier.service.js";

const UMBRAL_ENLACE   = 0.80;   // nucleos casi iguales -> mismo producto
const UMBRAL_REVISION = 0.62;   // parecidos -> que lo mire una persona

/** Nombre de la marca, para poder sacarlo de los titulos. Cacheado por contenedor. */
const cacheMarca = new Map();
async function nombreDeMarca(brandContainerId) {
  if (cacheMarca.has(brandContainerId)) return cacheMarca.get(brandContainerId);
  const { data } = await supabase
    .from("brand_containers")
    .select("nombre_marca")
    .eq("id", brandContainerId)
    .maybeSingle();
  const nombre = data?.nombre_marca || "";
  cacheMarca.set(brandContainerId, nombre);
  return nombre;
}

/** Reglas de bloqueo del contenedor: listados que el equipo ya descarto. */
async function reglasDeBloqueo(brandContainerId) {
  const { data } = await supabase
    .from("product_ingest_blocklist")
    .select("external_platform, external_id, nombre_normalizado, motivo, nota")
    .eq("brand_container_id", brandContainerId);
  return data || [];
}

function coincideBloqueo(reglas, { platform, externalId, name }) {
  const norm = normalizeName(name);
  for (const r of reglas) {
    if (r.external_id && String(r.external_id) === String(externalId) &&
        (!r.external_platform || r.external_platform === platform)) return r;
    if (r.nombre_normalizado && r.nombre_normalizado === norm) return r;
  }
  return null;
}

/**
 * Match por identificador duro. Es el camino ideal cuando existe: dos canales
 * que venden el mismo SKU comparten codigo de barras aunque los titulos no se
 * parezcan en nada.
 */
async function matchPorIdentificador({ brandContainerId, identifiers }) {
  const valores = [identifiers?.barcode, identifiers?.gtin, identifiers?.sku]
    .filter((v) => v && String(v).trim().length >= 6)
    .map((v) => String(v).trim());
  if (!valores.length) return null;

  const { data: variantes } = await supabase
    .from("product_variants")
    .select("product_id, sku, barcode, products!inner(brand_container_id)")
    .eq("products.brand_container_id", brandContainerId)
    .or(valores.map((v) => `sku.eq.${v},barcode.eq.${v}`).join(","))
    .limit(1);
  if (variantes && variantes.length) {
    return { product_id: variantes[0].product_id, valor: variantes[0].barcode || variantes[0].sku };
  }
  return null;
}

/** Candidatos del contenedor con su nucleo analizado y sus presentaciones actuales. */
async function candidatos(brandContainerId, marca) {
  const { data } = await supabase
    .from("products")
    .select("id, nombre_producto, product_variants(variant_name, peso, peso_unidad)")
    .eq("brand_container_id", brandContainerId)
    .limit(1000);
  return (data || []).map((p) => ({
    id: p.id,
    nombre: p.nombre_producto,
    parsed: parseListing(p.nombre_producto, { brand: marca }),
    presentaciones: p.product_variants || [],
  }));
}

/** ¿El producto ya tiene esta presentacion? Compara por peso normalizado y por etiqueta. */
function yaTienePresentacion(cand, size) {
  if (!size) return true;   // sin tamano no hay presentacion que agregar
  const etiqueta = normalizeName(size.label);
  return (cand.presentaciones || []).some((v) => {
    if (v.peso != null && v.peso_unidad === size.unit && Math.abs(Number(v.peso) - size.value) < 1) return true;
    return normalizeName(v.variant_name || "").includes(etiqueta);
  }) || (cand.parsed.size && cand.parsed.size.unit === size.unit && Math.abs(cand.parsed.size.value - size.value) < 1);
}

function mejorCandidato(cands, parsed) {
  let mejor = { cand: null, score: 0, porReclamos: false };
  for (const c of cands) {
    const s = coreSimilarity(c.parsed.coreTokens, parsed.coreTokens);
    const reclamos = claimsOnlyContainment(c.parsed.coreTokens, parsed.coreTokens);
    const efectivo = reclamos ? Math.max(s, UMBRAL_ENLACE) : s;
    if (efectivo > mejor.score) mejor = { cand: c, score: efectivo, porReclamos: reclamos, crudo: s };
  }
  return mejor;
}

/**
 * @returns {{
 *   decision: 'created'|'linked_existing'|'manual_review'|'skipped_pack'|'skipped_bundle'|'blocked',
 *   matched_product_id: string|null,
 *   similarity_score: number,
 *   match_reason: string,
 *   presentation: {label:string, size:object|null}|null,   // presentacion nueva del mismo producto
 *   listing_kind: 'producto'|'pack'|'bundle'
 * }}
 */
export async function findMatchingProduct({ brandContainerId, name, externalId, platform, identifiers }) {
  const base = { matched_product_id: null, similarity_score: 0, presentation: null, listing_kind: "producto" };

  // 2. Bloqueado por el equipo
  const reglas = await reglasDeBloqueo(brandContainerId);
  const bloqueo = coincideBloqueo(reglas, { platform, externalId, name });
  if (bloqueo) {
    return { ...base, decision: "blocked", similarity_score: 1,
             match_reason: `bloqueado (${bloqueo.motivo})${bloqueo.nota ? `: ${bloqueo.nota}` : ""}` };
  }

  const marca  = await nombreDeMarca(brandContainerId);
  const parsed = parseListing(name, { brand: marca });
  base.listing_kind = parsed.kind;

  // 3. Identificador duro (atraviesa plataformas)
  const porId = await matchPorIdentificador({ brandContainerId, identifiers });
  if (porId) {
    return { ...base, decision: "linked_existing", matched_product_id: porId.product_id,
             similarity_score: 1, match_reason: `mismo identificador (${porId.valor})` };
  }

  const cands = await candidatos(brandContainerId, marca);

  // 4. Pack o bundle: no es un producto. Se intenta apuntar al producto base.
  if (parsed.kind !== "producto") {
    const m = mejorCandidato(cands, parsed);
    const conBase = m.cand && m.score >= UMBRAL_ENLACE;
    return {
      ...base,
      decision: parsed.kind === "pack" ? "skipped_pack" : "skipped_bundle",
      matched_product_id: conBase ? m.cand.id : null,
      similarity_score:   Number((m.score || 0).toFixed(3)),
      match_reason: `${parsed.kind} (${parsed.reasons.join(", ")})` +
        (conBase ? ` — presentacion de "${m.cand.nombre}"` : " — sin producto base identificable"),
    };
  }

  if (!parsed.coreTokens.length) {
    return { ...base, decision: "created", match_reason: "titulo sin nucleo aprovechable" };
  }

  // 5/6. Match por nucleo
  const m = mejorCandidato(cands, parsed);
  if (m.cand && m.score >= UMBRAL_ENLACE) {
    const tamNuevo = parsed.size;
    const esNueva  = tamNuevo && !yaTienePresentacion(m.cand, tamNuevo);

    return {
      ...base,
      decision: "linked_existing",
      matched_product_id: m.cand.id,
      similarity_score:   Number(m.score.toFixed(3)),
      presentation: esNueva ? { label: tamNuevo.label, size: tamNuevo } : null,
      match_reason: m.porReclamos
        ? `mismo producto que "${m.cand.nombre}" (solo cambian reclamos de etiqueta)`
        : `mismo nucleo que "${m.cand.nombre}"` +
          (esNueva ? ` — presentacion nueva ${tamNuevo.label}` : ""),
    };
  }

  if (m.cand && m.score >= UMBRAL_REVISION) {
    return { ...base, decision: "manual_review", matched_product_id: m.cand.id,
             similarity_score: Number(m.score.toFixed(3)),
             match_reason: `parecido a "${m.cand.nombre}" (${m.score.toFixed(2)}), decidelo una persona` };
  }

  return { ...base, decision: "created", similarity_score: Number((m.score || 0).toFixed(3)),
           match_reason: "sin coincidencia en el catalogo de la marca" };
}

/** Registra el resultado en products_dedupe_log para audit. */
export async function logDedupeDecision({
  brandContainerId, organizationId, productId, externalPlatform, externalId,
  externalName, decision, matchedAgainstProductId, similarityScore, matchReason, rawPayload,
}) {
  await supabase.from("products_dedupe_log").insert({
    brand_container_id:        brandContainerId,
    organization_id:           organizationId,
    product_id:                productId,
    external_platform:         externalPlatform,
    external_id:               String(externalId),
    external_name:             externalName,
    decision,
    matched_against_product_id: matchedAgainstProductId,
    similarity_score:          similarityScore,
    match_reason:              matchReason,
    raw_payload:               rawPayload || null,
  });
}
