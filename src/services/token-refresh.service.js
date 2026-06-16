/**
 * Token Refresh Service — mantiene vivos los tokens OAuth de brand_integrations.
 *
 * Politica por plataforma:
 *   - Google: refresh activo. Si token_expires_at < now()+24h, llama a
 *     oauth2.googleapis.com/token con el refresh_token y persiste el nuevo
 *     access_token + token_expires_at. Si Google responde invalid_grant
 *     (refresh_token revocado o caducado), marca needs_reauth en metadata.
 *
 *   - Meta (facebook/instagram): los long-lived tokens duran ~60d y NO
 *     soportan refresh server-to-server seguro sin META_APP_ID/SECRET.
 *     Solo emite warning cuando vence en <7d. Si quedan <2d, marca
 *     needs_reauth en metadata para que el frontend muestre banner.
 *
 * Cadencia: cada 6h. Primera corrida 60s despues del boot.
 * Deshabilitar con TOKEN_REFRESH_ENABLED=false.
 */
import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "../lib/integration-token-vault.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
);

const REFRESH_INTERVAL_MS      = 6 * 60 * 60 * 1000;       // 6h
const GOOGLE_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;      // 1d
const META_WARN_WINDOW_MS      = 7 * 24 * 60 * 60 * 1000;  // 7d
const TIKTOK_REFRESH_WINDOW_MS = 12 * 60 * 60 * 1000;      // 12h (access vive 24h)
const GOOGLE_TOKEN_URL         = "https://oauth2.googleapis.com/token";
const TIKTOK_TOKEN_URL         = "https://open.tiktokapis.com/v2/oauth/token/";

let _refreshTimer = null;

// -- Google: refresh activo ---------------------------------------------------
async function refreshGoogleToken(integ) {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, reason: "missing_google_credentials" };
  if (!integ.refresh_token)       return { ok: false, reason: "no_refresh_token" };

  const refreshTokenPlain = decryptToken(integ.refresh_token);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshTokenPlain,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok:          false,
      reason:      json?.error || `http_${res.status}`,
      needsReauth: json?.error === "invalid_grant",
    };
  }

  const newToken  = json.access_token;
  const newExpiry = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();

  await supabase
    .from("brand_integrations")
    .update({
      access_token:     encryptToken(newToken),
      token_expires_at: newExpiry,
      last_sync_at:     new Date().toISOString(),
    })
    .eq("id", integ.id);

  return { ok: true, expires_at: newExpiry };
}

// -- TikTok: refresh activo ---------------------------------------------------
// access_token ~24h; el refresh_token ROTA en cada refresh (un solo uso) y dura
// ~365d → SIEMPRE persistimos el nuevo refresh_token que devuelve TikTok.
function getTikTokCreds() {
  // En fase sandbox los tokens los minteó el cliente del sandbox, así que el
  // refresh DEBE usar las MISMAS credenciales. TIKTOK_ENV (sandbox|production)
  // selecciona el par activo y debe coincidir con el que usa el frontend.
  const useSandbox = String(process.env.TIKTOK_ENV || "sandbox").toLowerCase() === "sandbox";
  return useSandbox
    ? { clientKey: process.env.TIKTOK_SANDBOX_CLIENT_KEY, clientSecret: process.env.TIKTOK_SANDBOX_CLIENT_SECRET }
    : { clientKey: process.env.TIKTOK_CLIENT_KEY,         clientSecret: process.env.TIKTOK_CLIENT_SECRET };
}

async function refreshTikTokToken(integ) {
  const { clientKey, clientSecret } = getTikTokCreds();
  if (!clientKey || !clientSecret) return { ok: false, reason: "missing_tiktok_credentials" };
  if (!integ.refresh_token)        return { ok: false, reason: "no_refresh_token" };

  const refreshTokenPlain = decryptToken(integ.refresh_token);

  const res = await fetch(TIKTOK_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body:    new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: refreshTokenPlain,
    }).toString(),
  });

  const json = await res.json().catch(() => ({}));
  // TikTok v2 puede responder 200 con un objeto de error en el body.
  const errCode = json?.error || json?.error_code;
  if (!res.ok || !json.access_token || (errCode && errCode !== "ok")) {
    const reason = json?.error_description || errCode || `http_${res.status}`;
    const needsReauth = /invalid_grant|invalid_request|expired|revoke/i.test(String(reason));
    return { ok: false, reason, needsReauth };
  }

  const newExpiry = new Date(Date.now() + (json.expires_in || 86_400) * 1000).toISOString();
  const update = {
    access_token:     encryptToken(json.access_token),
    token_expires_at: newExpiry,
    last_sync_at:     new Date().toISOString(),
  };
  // refresh_token ROTA: persistir el nuevo (si TikTok no devolviera uno, se
  // conserva el anterior intacto al no incluir la columna en el update).
  if (json.refresh_token) update.refresh_token = encryptToken(json.refresh_token);

  await supabase.from("brand_integrations").update(update).eq("id", integ.id);
  return { ok: true, expires_at: newExpiry };
}

// -- Marca needs_reauth en metadata ------------------------------------------
async function markNeedsReauth(integrationId, reason) {
  const { data: row } = await supabase
    .from("brand_integrations")
    .select("metadata")
    .eq("id", integrationId)
    .maybeSingle();

  const newMetadata = {
    ...(row?.metadata || {}),
    needs_reauth:      true,
    reauth_reason:     reason,
    reauth_flagged_at: new Date().toISOString(),
  };

  await supabase
    .from("brand_integrations")
    .update({ metadata: newMetadata })
    .eq("id", integrationId);
}

// -- Ciclo principal ----------------------------------------------------------
async function refreshTokensCycle() {
  const now          = Date.now();
  const googleCutoff = new Date(now + GOOGLE_REFRESH_WINDOW_MS).toISOString();
  const metaCutoff   = new Date(now + META_WARN_WINDOW_MS).toISOString();

  // Google: refresh proactivo si vence en <24h
  const { data: googleIntegs, error: gErr } = await supabase
    .from("brand_integrations")
    .select("id, platform, refresh_token, token_expires_at, external_account_name, metadata")
    .eq("is_active", true)
    .in("platform", ["google", "youtube"])
    .lt("token_expires_at", googleCutoff);

  if (gErr) console.warn("token-refresh: error consultando Google integrations -", gErr.message);

  for (const integ of googleIntegs || []) {
    try {
      const r = await refreshGoogleToken(integ);
      const label = integ.external_account_name || integ.id;
      if (r.ok) {
        console.log(`token-refresh [google]: ${label} -> OK (expires ${r.expires_at})`);
      } else {
        console.warn(`token-refresh [google]: ${label} -> FALLO (${r.reason})`);
        if (r.needsReauth) {
          await markNeedsReauth(integ.id, r.reason);
          console.warn(`token-refresh [google]: ${label} marcado needs_reauth`);
        }
      }
    } catch (e) {
      console.warn(`token-refresh [google]: ${integ.id} excepcion - ${e.message}`);
    }
  }

  // TikTok: refresh proactivo si vence en <12h (access vive 24h; refresh ROTA)
  const tiktokCutoff = new Date(now + TIKTOK_REFRESH_WINDOW_MS).toISOString();
  const { data: tiktokIntegs, error: tErr } = await supabase
    .from("brand_integrations")
    .select("id, platform, refresh_token, token_expires_at, external_account_name, metadata")
    .eq("is_active", true)
    .eq("platform", "tiktok")
    .lt("token_expires_at", tiktokCutoff);

  if (tErr) console.warn("token-refresh: error consultando TikTok integrations -", tErr.message);

  for (const integ of tiktokIntegs || []) {
    try {
      const r = await refreshTikTokToken(integ);
      const label = integ.external_account_name || integ.id;
      if (r.ok) {
        console.log(`token-refresh [tiktok]: ${label} -> OK (expires ${r.expires_at})`);
      } else {
        console.warn(`token-refresh [tiktok]: ${label} -> FALLO (${r.reason})`);
        if (r.needsReauth) {
          await markNeedsReauth(integ.id, r.reason);
          console.warn(`token-refresh [tiktok]: ${label} marcado needs_reauth`);
        }
      }
    } catch (e) {
      console.warn(`token-refresh [tiktok]: ${integ.id} excepcion - ${e.message}`);
    }
  }

  // Meta: solo warning si vence en <7d (no hay refresh automatico)
  const { data: metaIntegs, error: mErr } = await supabase
    .from("brand_integrations")
    .select("id, platform, token_expires_at, external_account_name, metadata")
    .eq("is_active", true)
    .in("platform", ["facebook", "instagram"])
    .not("token_expires_at", "is", null)
    .lt("token_expires_at", metaCutoff);

  if (mErr) console.warn("token-refresh: error consultando Meta integrations -", mErr.message);

  for (const integ of metaIntegs || []) {
    const daysLeft = Math.max(
      0,
      Math.round((new Date(integ.token_expires_at).getTime() - now) / 86_400_000),
    );
    const label = integ.external_account_name || integ.id;
    console.warn(
      `token-refresh [meta]: ${label} -> vence en ${daysLeft}d (${integ.token_expires_at}) - ` +
      `Meta no soporta refresh automatico sin META_APP_*; requiere re-auth manual del usuario`,
    );
    if (daysLeft < 2 && !integ.metadata?.needs_reauth) {
      await markNeedsReauth(integ.id, `meta_token_expires_in_${daysLeft}d`);
      console.warn(`token-refresh [meta]: ${label} marcado needs_reauth (vence inminente)`);
    }
  }

  const total = (googleIntegs?.length || 0) + (tiktokIntegs?.length || 0) + (metaIntegs?.length || 0);
  if (total) console.log(`token-refresh: ciclo completo - ${total} integraciones revisadas`);
}

// -- Boot/teardown -----------------------------------------------------------
export function startTokenRefreshService() {
  if (_refreshTimer) return;

  // Primera corrida 60s despues del boot - no bloquear arranque
  setTimeout(() => {
    refreshTokensCycle().catch((e) =>
      console.warn("token-refresh: error inicial -", e.message),
    );
    _refreshTimer = setInterval(() => {
      refreshTokensCycle().catch((e) =>
        console.warn("token-refresh: error ciclo -", e.message),
      );
    }, REFRESH_INTERVAL_MS);
  }, 60_000);

  console.log(
    `token-refresh: scheduler iniciado ` +
    `(cada ${REFRESH_INTERVAL_MS / 3_600_000}h, primera corrida en 60s)`,
  );
}

export function stopTokenRefreshService() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
