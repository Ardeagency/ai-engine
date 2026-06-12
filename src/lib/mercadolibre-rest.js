/**
 * mercadolibre-rest.js — Cliente REST de la API de Mercado Libre.
 *
 * Responsabilidades:
 *   - Mantener un access_token válido por integración. El token de ML expira en
 *     ~6h; cuando está por vencer (o un 401 lo confirma) se refresca con el
 *     refresh_token. OJO: el refresh_token de ML es DE UN SOLO USO — cada refresh
 *     devuelve uno nuevo e invalida el anterior, así que SIEMPRE persistimos el
 *     nuevo (encriptado) o perdemos el acceso.
 *   - GET con backoff básico ante 429.
 *   - Pull de inventario completo vía search_type=scan (maneja cualquier tamaño,
 *     no tiene el tope de offset 1000 del search normal).
 *   - Multiget de items (/items?ids=, máx 20 por llamada) + descripciones.
 *
 * El `integ` que reciben las funciones es la fila de brand_integrations YA
 * DESENCRIPTADA (la entrega base.populator.getIntegration). Se muta en memoria
 * cuando se refresca el token.
 */
import { supabase } from "./supabase.js";
import { encryptToken } from "./integration-token-vault.js";

const API_BASE   = "https://api.mercadolibre.com";
const TOKEN_URL  = "https://api.mercadolibre.com/oauth/token";
const MAX_RETRIES = 5;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // refrescar 5 min antes de expirar

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function buildQs(params) {
  if (!params || !Object.keys(params).length) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/**
 * Refresca el access_token usando el refresh_token y PERSISTE el nuevo par
 * (access + refresh rotado + expiry) encriptado. Muta `integ` en memoria.
 */
async function refreshAccessToken(integ) {
  const appId     = process.env.MELI_APP_ID || "";
  const appSecret = process.env.MELI_APP_SECRET || "";
  if (!appId || !appSecret) throw new Error("meli-rest: missing MELI_APP_ID/MELI_APP_SECRET");
  if (!integ.refresh_token) throw new Error(`meli-rest: integration ${integ.id} has no refresh_token (needs reconnect)`);

  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     appId,
      client_secret: appSecret,
      refresh_token: integ.refresh_token,
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // refresh_token inválido/usado → marcar para reconexión manual
    if (res.status === 400 || res.status === 401) {
      await supabase.from("brand_integrations")
        .update({ is_active: false })
        .eq("id", integ.id)
        .then(() => {}, () => {});
    }
    throw new Error(`meli-rest: refresh failed (${res.status}): ${j.message || j.error || ""}`);
  }

  const expiresAt = new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString();
  const newRefresh = j.refresh_token || integ.refresh_token;

  await supabase.from("brand_integrations").update({
    access_token:     encryptToken(j.access_token),
    refresh_token:    encryptToken(newRefresh),
    token_expires_at: expiresAt,
    updated_at:       new Date().toISOString(),
  }).eq("id", integ.id);

  // Mutar en memoria (valores en claro para el resto del run)
  integ.access_token     = j.access_token;
  integ.refresh_token    = newRefresh;
  integ.token_expires_at = expiresAt;
  return j.access_token;
}

/** Devuelve un access_token válido, refrescando si está vencido o por vencer. */
async function getValidToken(integ) {
  if (!integ.access_token) return refreshAccessToken(integ);
  const exp = integ.token_expires_at ? Date.parse(integ.token_expires_at) : 0;
  if (!exp || Date.now() >= exp - EXPIRY_MARGIN_MS) return refreshAccessToken(integ);
  return integ.access_token;
}

/**
 * GET autenticado contra la API de ML. Refresca ante 401, backoff ante 429.
 */
export async function meliGet(integ, path, params) {
  const url = path.startsWith("http") ? path + buildQs(params) : `${API_BASE}${path}${buildQs(params)}`;
  let triedRefresh = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const token = await getValidToken(integ);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });

    if (res.status === 401 && !triedRefresh) {
      triedRefresh = true;
      await refreshAccessToken(integ);
      continue;
    }
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error(`meli-rest: rate limited after ${MAX_RETRIES} attempts: ${url}`);
      await sleep(Math.min(1000 * attempt, 8000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`meli-rest GET ${url} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
  }
  throw new Error("meli-rest: unreachable");
}

/**
 * Trae TODOS los ids de publicaciones del vendedor vía scan (sin tope de offset).
 * @returns {Promise<{ ids: string[], total: number, truncated: boolean }>}
 */
export async function meliGetAllItemIds(integ, sellerId, opts = {}) {
  const limit    = opts.limit || 100;
  const maxItems = opts.maxItems || 5000;
  const ids = [];
  let scrollId = null;
  let total = 0;
  let pages = 0;
  const maxPages = Math.ceil(maxItems / limit) + 2;

  do {
    const params = scrollId
      ? { search_type: "scan", scroll_id: scrollId, limit }
      : { search_type: "scan", limit };
    const data = await meliGet(integ, `/users/${sellerId}/items/search`, params);
    const results = Array.isArray(data?.results) ? data.results : [];
    total = data?.paging?.total ?? total;
    scrollId = data?.scroll_id || null;
    if (!results.length) break;
    ids.push(...results);
    pages++;
  } while (scrollId && ids.length < maxItems && pages < maxPages);

  return { ids: ids.slice(0, maxItems), total, truncated: ids.length >= maxItems && ids.length < total };
}

/**
 * Multiget de items (máx 20 ids por llamada). Devuelve los bodies con code 200.
 */
export async function meliMultiGetItems(integ, ids) {
  if (!ids?.length) return [];
  const data = await meliGet(integ, "/items", { ids: ids.slice(0, 20).join(",") });
  if (!Array.isArray(data)) return [];
  return data.filter((entry) => entry?.code === 200 && entry?.body).map((entry) => entry.body);
}

/** Descripción en texto plano de un item (recurso aparte en ML). Best-effort. */
export async function meliGetDescription(integ, itemId) {
  try {
    const d = await meliGet(integ, `/items/${itemId}/description`);
    return (d?.plain_text || d?.text || "").trim() || null;
  } catch {
    return null;
  }
}
