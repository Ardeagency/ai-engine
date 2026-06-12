/**
 * googleads-rest.js — Cliente REST de la Google Ads API (multi-tenant).
 *
 * A diferencia de la skill Python (que usa el refresh_token de ARDE para sus
 * cuentas), aqui cada CLIENTE autoriza por OAuth (scope adwords) y su token
 * vive en brand_integrations. El Developer Token de ARDE es la llave de acceso
 * a la API; el token OAuth del cliente determina a QUE cuentas se entra.
 *
 * Headers en cada request:
 *   - developer-token:   GOOGLE_ADS_DEVELOPER_TOKEN (de ARDE, compartido)
 *   - Authorization:     Bearer <access_token del cliente>
 *   - login-customer-id: cuenta "a traves de la cual" se opera (MCC o la propia)
 *
 * Token OAuth de Google dura ~1h; se refresca con GOOGLE_CLIENT_ID/SECRET +
 * el refresh_token del cliente (Google NO rota el refresh_token, se conserva).
 */
import { supabase } from "./supabase.js";
import { encryptToken } from "./integration-token-vault.js";

const API_VERSION  = process.env.GOOGLE_ADS_API_VERSION || "v21";
const API_BASE     = `https://googleads.googleapis.com/${API_VERSION}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRIES = 4;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function digitsOnly(s) { return String(s || "").replace(/\D/g, ""); }

async function refreshGoogleToken(integ) {
  const clientId     = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) throw new Error("googleads-rest: missing GOOGLE_CLIENT_ID/SECRET");
  if (!integ.refresh_token) throw new Error(`googleads-rest: integration ${integ.id} has no refresh_token (needs reconnect)`);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: integ.refresh_token,
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    if (res.status === 400 || res.status === 401) {
      await supabase.from("brand_integrations").update({ is_active: false }).eq("id", integ.id).then(() => {}, () => {});
    }
    throw new Error(`googleads-rest: refresh failed (${res.status}): ${j.error_description || j.error || ""}`);
  }
  const expiresAt = new Date(Date.now() + Number(j.expires_in || 3600) * 1000).toISOString();
  // Google conserva el refresh_token; solo persistimos el nuevo access + expiry.
  await supabase.from("brand_integrations").update({
    access_token:     encryptToken(j.access_token),
    token_expires_at: expiresAt,
    updated_at:       new Date().toISOString(),
  }).eq("id", integ.id);
  integ.access_token = j.access_token;
  integ.token_expires_at = expiresAt;
  return j.access_token;
}

async function getValidToken(integ) {
  if (!integ.access_token) return refreshGoogleToken(integ);
  const exp = integ.token_expires_at ? Date.parse(integ.token_expires_at) : 0;
  if (!exp || Date.now() >= exp - EXPIRY_MARGIN_MS) return refreshGoogleToken(integ);
  return integ.access_token;
}

function baseHeaders(token, loginCustomerId) {
  const h = {
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
    Authorization:     `Bearer ${token}`,
    "Content-Type":    "application/json",
  };
  const lc = digitsOnly(loginCustomerId || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "");
  if (lc) h["login-customer-id"] = lc;
  return h;
}

/** Lista los customer ids (sin dashes) que el token del cliente puede ver. */
export async function listAccessibleCustomers(integ) {
  const token = await getValidToken(integ);
  const res = await fetch(`${API_BASE}/customers:listAccessibleCustomers`, {
    method: "GET",
    headers: baseHeaders(token),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`googleads-rest listAccessibleCustomers (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
  return (j.resourceNames || []).map((rn) => String(rn).split("/").pop());
}

/**
 * Ejecuta una query GAQL via searchStream sobre un customer.
 * @returns {Promise<object[]>} filas (results) acumuladas.
 */
export async function searchStream(integ, customerId, gaql, { loginCustomerId } = {}) {
  const cid = digitsOnly(customerId);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const token = await getValidToken(integ);
    const res = await fetch(`${API_BASE}/customers/${cid}/googleAds:searchStream`, {
      method:  "POST",
      headers: baseHeaders(token, loginCustomerId || cid),
      body:    JSON.stringify({ query: gaql }),
    });

    if (res.status === 401 && attempt < MAX_RETRIES) { await refreshGoogleToken(integ); continue; }
    if (res.status === 429 && attempt < MAX_RETRIES) { await sleep(Math.min(1000 * attempt, 6000)); continue; }

    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`googleads-rest searchStream cust=${cid} (${res.status}): ${JSON.stringify(j).slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    // searchStream devuelve un array de batches; cada batch tiene .results
    const batches = Array.isArray(j) ? j : [j];
    const rows = [];
    for (const b of batches) if (Array.isArray(b?.results)) rows.push(...b.results);
    return rows;
  }
  throw new Error("googleads-rest: searchStream unreachable");
}

/**
 * GET autenticado generico a cualquier API de Google (YouTube Data, Analytics,
 * etc.) usando el token de la integracion google con refresh transparente.
 */
export async function googleGet(integ, url, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null) usp.append(k, String(v));
  const full = usp.toString() ? `${url}?${usp}` : url;
  let triedRefresh = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const token = await getValidToken(integ);
    const res = await fetch(full, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && !triedRefresh) { triedRefresh = true; await refreshGoogleToken(integ); continue; }
    if (res.status === 429 && attempt < MAX_RETRIES) { await sleep(Math.min(1000 * attempt, 6000)); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`googleGet ${full} (${res.status}): ${JSON.stringify(j).slice(0, 220)}`);
    return j;
  }
  throw new Error("googleGet: unreachable");
}
