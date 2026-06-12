/**
 * x-rest.js — Cliente de la X API v2 (multi-tenant).
 *
 * Cada marca autoriza por OAuth 2.0 (PKCE); su token vive en brand_integrations.
 * X OAuth 2.0 es cliente confidencial: el refresh usa client_id:secret via HTTP
 * Basic. access_token dura ~2h y el refresh_token ROTA (un solo uso, como ML)
 * → SIEMPRE persistimos el nuevo o perdemos el acceso.
 *
 * El `integ` que reciben las funciones es la fila YA DESENCRIPTADA. Se muta en
 * memoria al refrescar.
 */
import { supabase } from "./supabase.js";
import { encryptToken } from "./integration-token-vault.js";

const API_BASE   = "https://api.twitter.com/2";
const TOKEN_URL  = "https://api.twitter.com/2/oauth2/token";
const MAX_RETRIES = 4;
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function buildQs(params) {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) usp.append(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function refreshXToken(integ) {
  const clientId     = process.env.X_CLIENT_ID || "";
  const clientSecret = process.env.X_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) throw new Error("x-rest: missing X_CLIENT_ID/X_CLIENT_SECRET");
  if (!integ.refresh_token) throw new Error(`x-rest: integration ${integ.id} has no refresh_token (needs reconnect)`);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: integ.refresh_token,
      client_id:     clientId,
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    if (res.status === 400 || res.status === 401) {
      await supabase.from("brand_integrations").update({ is_active: false }).eq("id", integ.id).then(() => {}, () => {});
    }
    throw new Error(`x-rest: refresh failed (${res.status}): ${j.error_description || j.error || ""}`);
  }
  const expiresAt = new Date(Date.now() + Number(j.expires_in || 7200) * 1000).toISOString();
  const newRefresh = j.refresh_token || integ.refresh_token;
  await supabase.from("brand_integrations").update({
    access_token:     encryptToken(j.access_token),
    refresh_token:    encryptToken(newRefresh),
    token_expires_at: expiresAt,
    updated_at:       new Date().toISOString(),
  }).eq("id", integ.id);
  integ.access_token = j.access_token;
  integ.refresh_token = newRefresh;
  integ.token_expires_at = expiresAt;
  return j.access_token;
}

async function getValidToken(integ) {
  if (!integ.access_token) return refreshXToken(integ);
  const exp = integ.token_expires_at ? Date.parse(integ.token_expires_at) : 0;
  if (!exp || Date.now() >= exp - EXPIRY_MARGIN_MS) return refreshXToken(integ);
  return integ.access_token;
}

export async function xGet(integ, path, params) {
  const url = path.startsWith("http") ? path + buildQs(params) : `${API_BASE}${path}${buildQs(params)}`;
  let triedRefresh = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const token = await getValidToken(integ);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 401 && !triedRefresh) { triedRefresh = true; await refreshXToken(integ); continue; }
    if (res.status === 429) {
      // X rate limit: respeta x-rate-limit-reset si viene
      const reset = Number(res.headers.get("x-rate-limit-reset") || 0);
      const waitMs = reset ? Math.max(0, reset * 1000 - Date.now()) : Math.min(2000 * attempt, 8000);
      if (attempt >= MAX_RETRIES) throw Object.assign(new Error(`x-rest: rate limited: ${url}`), { status: 429 });
      await sleep(Math.min(waitMs, 15000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`x-rest GET ${url} (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return j;
  }
  throw new Error("x-rest: unreachable");
}

/** /2/users/me con campos de perfil. */
export function getMe(integ) {
  return xGet(integ, "/users/me", {
    "user.fields": "username,name,profile_image_url,public_metrics,verified,description",
  });
}

/**
 * Tweets recientes del usuario (paginado). Devuelve { tweets, mediaByKey }.
 * Excluye retweets/replies para quedarnos con contenido original de la marca.
 */
export async function getRecentTweets(integ, userId, { maxPages = 2, perPage = 100 } = {}) {
  const tweets = [];
  const mediaByKey = {};
  let nextToken = null;
  let pages = 0;
  do {
    const params = {
      max_results:   perPage,
      "tweet.fields": "created_at,public_metrics,entities,lang,attachments",
      expansions:    "attachments.media_keys",
      "media.fields": "url,preview_image_url,type",
      exclude:       "retweets,replies",
    };
    if (nextToken) params.pagination_token = nextToken;
    const data = await xGet(integ, `/users/${userId}/tweets`, params);
    if (Array.isArray(data?.data)) tweets.push(...data.data);
    for (const m of data?.includes?.media || []) mediaByKey[m.media_key] = m;
    nextToken = data?.meta?.next_token || null;
    pages++;
  } while (nextToken && pages < maxPages);
  return { tweets, mediaByKey };
}
