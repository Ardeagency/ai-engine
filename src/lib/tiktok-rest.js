/**
 * tiktok-rest.js — Cliente de la TikTok API v2 (multi-tenant).
 *
 * Cada marca autoriza por OAuth 2.0 (PKCE); su token vive en brand_integrations.
 * TikTok NO usa HTTP Basic: client_key/secret van en el body del refresh.
 * access_token dura ~24h y el refresh_token ROTA (un solo uso) → SIEMPRE
 * persistimos el nuevo o perdemos el acceso.
 *
 * El `integ` que reciben las funciones es la fila YA DESENCRIPTADA. Se muta en
 * memoria al refrescar.
 *
 * Credenciales: TIKTOK_ENV (sandbox|production) elige el par activo, igual que
 * token-refresh.service.js — debe coincidir con el cliente que minteó el token.
 */
import { supabase } from "./supabase.js";
import { encryptToken } from "./integration-token-vault.js";

const API_BASE   = "https://open.tiktokapis.com/v2";
const TOKEN_URL  = "https://open.tiktokapis.com/v2/oauth/token/";
const MAX_RETRIES = 4;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getTikTokCreds() {
  const useSandbox = String(process.env.TIKTOK_ENV || "sandbox").toLowerCase() === "sandbox";
  return useSandbox
    ? { clientKey: process.env.TIKTOK_SANDBOX_CLIENT_KEY, clientSecret: process.env.TIKTOK_SANDBOX_CLIENT_SECRET }
    : { clientKey: process.env.TIKTOK_CLIENT_KEY,         clientSecret: process.env.TIKTOK_CLIENT_SECRET };
}

function buildQs(params) {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) usp.append(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function refreshTikTokToken(integ) {
  const { clientKey, clientSecret } = getTikTokCreds();
  if (!clientKey || !clientSecret) throw new Error("tiktok-rest: missing TIKTOK client credentials");
  if (!integ.refresh_token) throw new Error(`tiktok-rest: integration ${integ.id} has no refresh_token (needs reconnect)`);

  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: integ.refresh_token,
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  const errCode = j?.error || j?.error_code;
  if (!res.ok || !j.access_token || (errCode && errCode !== "ok")) {
    const reason = j?.error_description || errCode || `http_${res.status}`;
    // refresh inválido/expirado → desactivar para forzar reconexión del usuario.
    if (/invalid_grant|invalid_request|expired|revoke/i.test(String(reason))) {
      await supabase.from("brand_integrations").update({ is_active: false }).eq("id", integ.id).then(() => {}, () => {});
    }
    throw new Error(`tiktok-rest: refresh failed (${res.status}): ${reason}`);
  }
  const expiresAt  = new Date(Date.now() + Number(j.expires_in || 86_400) * 1000).toISOString();
  const newRefresh = j.refresh_token || integ.refresh_token;
  await supabase.from("brand_integrations").update({
    access_token:     encryptToken(j.access_token),
    refresh_token:    encryptToken(newRefresh),
    token_expires_at: expiresAt,
    updated_at:       new Date().toISOString(),
  }).eq("id", integ.id);
  integ.access_token     = j.access_token;
  integ.refresh_token    = newRefresh;
  integ.token_expires_at = expiresAt;
  return j.access_token;
}

async function getValidToken(integ) {
  if (!integ.access_token) return refreshTikTokToken(integ);
  const exp = integ.token_expires_at ? Date.parse(integ.token_expires_at) : 0;
  if (!exp || Date.now() >= exp - EXPIRY_MARGIN_MS) return refreshTikTokToken(integ);
  return integ.access_token;
}

/**
 * Request genérico a la TikTok API con retry/401/429.
 * @param {object} integ  — fila desencriptada de brand_integrations
 * @param {"GET"|"POST"} method
 * @param {string} path    — ej "/user/info/" (los fields van en query)
 * @param {object} [opts]  — { query, body }
 */
async function ttRequest(integ, method, path, { query, body } = {}) {
  const url = `${API_BASE}${path}${buildQs(query)}`;
  let triedRefresh = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const token = await getValidToken(integ);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const j = await res.json().catch(() => ({}));
    const errCode = j?.error?.code || j?.error;

    // token inválido → refrescar una vez y reintentar
    if ((res.status === 401 || /access_token_invalid|token.*expired/i.test(String(errCode))) && !triedRefresh) {
      triedRefresh = true;
      await refreshTikTokToken(integ);
      continue;
    }
    // rate limit
    if (res.status === 429 || /rate_limit/i.test(String(errCode))) {
      if (attempt >= MAX_RETRIES) throw Object.assign(new Error(`tiktok-rest: rate limited: ${url}`), { status: 429 });
      await sleep(Math.min(2000 * attempt, 8000));
      continue;
    }
    if (!res.ok || (errCode && errCode !== "ok")) {
      const err = new Error(`tiktok-rest ${method} ${url} (${res.status}): ${JSON.stringify(j?.error || j).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return j;
  }
  throw new Error("tiktok-rest: unreachable");
}

/** /user/info con campos de perfil + stats (lo concedido por los scopes). */
export function getMe(integ) {
  const fields = "open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username,follower_count,likes_count,video_count";
  return ttRequest(integ, "GET", "/user/info/", { query: { fields } });
}

/**
 * Videos propios del usuario (paginado por cursor). Devuelve { videos }.
 * /video/list/ es POST: los fields van en query, el cursor/paginación en el body.
 */
export async function getRecentVideos(integ, { maxPages = 2, perPage = 20 } = {}) {
  const fields = "id,title,video_description,duration,cover_image_url,share_url,embed_link,like_count,comment_count,share_count,view_count,create_time";
  const videos = [];
  let cursor = null;
  let pages = 0;
  do {
    const body = { max_count: Math.min(perPage, 20) };
    if (cursor != null) body.cursor = cursor;
    const data = await ttRequest(integ, "POST", "/video/list/", { query: { fields }, body });
    const batch = data?.data?.videos || [];
    if (Array.isArray(batch)) videos.push(...batch);
    cursor = data?.data?.has_more ? data?.data?.cursor : null;
    pages++;
  } while (cursor != null && pages < maxPages);
  return { videos };
}
