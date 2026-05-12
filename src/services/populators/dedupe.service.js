/**
 * dedupe.service.js
 *
 * Detecta si un producto que llega de una plataforma externa ya existe en
 * `products` para el mismo brand_container, evitando duplicar. Si lo encuentra,
 * registra el match en `external_resource_map` y deja audit en `products_dedupe_log`.
 *
 * Estrategia de match (en orden):
 *   1. external_resource_map exact (mismo (platform, external_id)) → no es dup, es re-sync.
 *   2. Otra plataforma + mismo external_id (raro pero posible: SKU compartido) → match fuerte.
 *   3. Nombre normalizado idéntico dentro del brand_container → match fuerte.
 *   4. Levenshtein normalizado >= 0.88 sobre nombre normalizado → match medio (manual_review si <0.95).
 *
 * No usa LLM en background (regla del usuario).
 */
import { supabase } from "../../lib/supabase.js";

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein normalizado (1.0 = idéntico, 0 = totalmente distinto).
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.5) return 0;
  const dp = new Uint16Array((n + 1) * 2);
  let prev = 0, curr = 1;
  for (let j = 0; j <= n; j++) dp[prev * (n + 1) + j] = j;
  for (let i = 1; i <= m; i++) {
    dp[curr * (n + 1)] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[curr * (n + 1) + j] = Math.min(
        dp[prev * (n + 1) + j] + 1,
        dp[curr * (n + 1) + (j - 1)] + 1,
        dp[prev * (n + 1) + (j - 1)] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  const dist = dp[prev * (n + 1) + n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/**
 * Busca match candidato. Devuelve:
 *   { decision: 'created' | 'linked_existing' | 'manual_review',
 *     matched_product_id, similarity_score, match_reason }
 */
export async function findMatchingProduct({ brandContainerId, name, externalId, platform }) {
  // 1. Mismo external_id en otra plataforma (caso raro pero posible)
  if (externalId) {
    const { data: byExt } = await supabase
      .from("external_resource_map")
      .select("internal_id, external_platform")
      .eq("brand_container_id", brandContainerId)
      .eq("internal_table",     "products")
      .eq("external_id",        String(externalId))
      .neq("external_platform", platform)
      .not("internal_id",       "is", null)
      .limit(1);
    if (byExt && byExt.length > 0) {
      return {
        decision:         "linked_existing",
        matched_product_id: byExt[0].internal_id,
        similarity_score:  1.0,
        match_reason:      `same external_id on ${byExt[0].external_platform}`,
      };
    }
  }

  // 2/3. Match por nombre dentro del brand_container
  const normalized = normalizeName(name);
  if (!normalized) {
    return { decision: "created", matched_product_id: null, similarity_score: 0, match_reason: "no_name_to_match" };
  }

  const { data: candidates } = await supabase
    .from("products")
    .select("id, nombre_producto")
    .eq("brand_container_id", brandContainerId)
    .limit(500);

  let best = { product_id: null, score: 0, name: null };
  for (const c of candidates || []) {
    const sim = similarity(normalized, normalizeName(c.nombre_producto));
    if (sim > best.score) best = { product_id: c.id, score: sim, name: c.nombre_producto };
  }

  if (best.score >= 0.95) {
    return {
      decision:         "linked_existing",
      matched_product_id: best.product_id,
      similarity_score:  Number(best.score.toFixed(3)),
      match_reason:      `name match >=0.95 against "${best.name}"`,
    };
  }
  if (best.score >= 0.88) {
    return {
      decision:         "manual_review",
      matched_product_id: best.product_id,
      similarity_score:  Number(best.score.toFixed(3)),
      match_reason:      `name match 0.88-0.95 against "${best.name}"`,
    };
  }

  return {
    decision:         "created",
    matched_product_id: null,
    similarity_score:  Number(best.score.toFixed(3)),
    match_reason:      "no_strong_match",
  };
}

/**
 * Registra el resultado en products_dedupe_log para audit.
 */
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
