/**
 * Integration Token — obtiene tokens activos de integraciones OAuth.
 *
 * SEGURIDAD:
 *   - Usa el service key (bypass RLS) para leer access_token/refresh_token.
 *   - Los tokens NUNCA se retornan a OpenClaw directamente.
 *   - Solo las herramientas de social.tools.js consumen esta función internamente.
 *   - Si la org no tiene nivel "parcial" o "total", las tools no se habilitan (tool-phases.js).
 */
import { supabase } from "./supabase.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Obtiene la integración activa para una plataforma y brand_container.
 * Si brandContainerId no se pasa (o es null), auto-descubre el primer
 * brand_container de la organización que tenga la integración activa.
 *
 * @param {string|null} brandContainerId  — opcional; null = auto-descubrir
 * @param {string} organizationId
 * @param {"google"|"facebook"|"instagram"|"youtube"} platform — debe coincidir con brand_integrations.platform en la DB
 * @returns {Promise<{ access_token: string, refresh_token?: string, token_expires_at?: string, metadata?: object }>}
 */
export async function getIntegrationToken(brandContainerId, organizationId, platform) {
  let resolvedContainerId = brandContainerId;

  if (!resolvedContainerId) {
    // Auto-descubrir: buscar el primer brand_container de la org que tenga
    // una integración activa con la plataforma solicitada.
    const { data: found } = await supabase
      .from("brand_integrations")
      .select("brand_container_id, brand_containers!inner(organization_id)")
      .eq("platform", platform)
      .eq("is_active", true)
      .eq("brand_containers.organization_id", organizationId)
      .limit(1)
      .maybeSingle();

    if (!found?.brand_container_id) {
      throw Object.assign(
        new Error(
          `No hay una integración activa con ${platform} para esta organización. ` +
          `El usuario debe conectar la cuenta en la configuración de la marca.`
        ),
        { statusCode: 404, noIntegration: true }
      );
    }
    resolvedContainerId = found.brand_container_id;
  } else {
    // Verificar que el brand_container pertenece a la organización
    const { data: bc } = await supabase
      .from("brand_containers")
      .select("id")
      .eq("id", resolvedContainerId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!bc) {
      throw Object.assign(
        new Error(`brand_container no encontrado para esta organización`),
        { statusCode: 404 }
      );
    }
  }

  // Buscar integración activa para la plataforma
  const { data: integ, error } = await supabase
    .from("brand_integrations")
    .select("id, platform, access_token, refresh_token, token_expires_at, metadata, is_active")
    .eq("brand_container_id", resolvedContainerId)
    .eq("platform", platform)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;

  if (!integ?.access_token) {
    throw Object.assign(
      new Error(
        `No hay una integración activa con ${platform} para esta marca. ` +
        `El usuario debe conectar la cuenta en la configuración de la marca.`
      ),
      { statusCode: 404, noIntegration: true }
    );
  }

  // Refrescar token de Google si está por vencer (< 5 minutos)
  if (platform === "google" || platform === "google_analytics" || platform === "youtube") {
    const token = await _refreshGoogleIfNeeded(integ);
    return { ...integ, access_token: token };
  }

  return integ;
}

/**
 * Refresca el token de Google si está por vencer.
 * Actualiza la DB si se refrescó.
 */
async function _refreshGoogleIfNeeded(integ) {
  if (!integ.token_expires_at || !integ.refresh_token) return integ.access_token;

  const expiresAt = new Date(integ.token_expires_at).getTime();
  const fiveMinutes = 5 * 60 * 1000;

  if (Date.now() < expiresAt - fiveMinutes) return integ.access_token;

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn("[integration-token] GOOGLE_CLIENT_ID/SECRET no configurados — usando token existente");
    return integ.access_token;
  }

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: integ.refresh_token,
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.error_description || json?.error || "Token refresh failed";
      // invalid_grant = el refresh token fue revocado o expiró (>6 meses sin uso)
      if (json?.error === "invalid_grant") {
        throw Object.assign(
          new Error(
            "El acceso a Google Analytics venció y necesita ser re-autorizado. " +
            "El usuario debe ir a Configuración → Integraciones y volver a conectar su cuenta de Google."
          ),
          { needsReauth: true }
        );
      }
      throw new Error(errMsg);
    }

    const newToken   = json.access_token;
    const newExpiry  = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();

    await supabase
      .from("brand_integrations")
      .update({ access_token: newToken, token_expires_at: newExpiry })
      .eq("id", integ.id);

    return newToken;
  } catch (e) {
    console.warn("[integration-token] Google token refresh error:", e.message);
    // Si el token expiró Y no podemos refrescarlo, lanzar error claro en lugar de usar token muerto
    const tokenExpired = integ.token_expires_at && Date.now() >= new Date(integ.token_expires_at).getTime();
    if (tokenExpired || e.needsReauth) {
      throw Object.assign(
        new Error(
          e.needsReauth
            ? e.message
            : "El token de Google Analytics expiró y no se pudo renovar automáticamente. " +
              "El usuario debe ir a Configuración → Integraciones y volver a conectar su cuenta de Google."
        ),
        { needsReauth: true }
      );
    }
    return integ.access_token;
  }
}
