/**
 * autonomy.js — Nivel de autonomía por organización.
 *
 * Lee `level_of_autonomy` de la tabla `organizations` y lo mapea a:
 *   phase        → Qué tools puede usar Vera (A/B/C)
 *   consentMode  → Cómo se manejan las acciones de escritura
 *   passTokens   → Qué nivel de acceso a tokens de integración se otorga
 *
 * ┌─────────────┬───────┬──────────────┬──────────────────────────────────┐
 * │   Nivel     │ Phase │ ConsentMode  │ passTokens                       │
 * ├─────────────┼───────┼──────────────┼──────────────────────────────────┤
 * │ restringido │   A   │ block_all    │ none (sin acceso a integraciones) │
 * │ parcial     │   B   │ require      │ read (solo para leer métricas)    │
 * │ total       │   C   │ auto         │ full (acceso completo)            │
 * └─────────────┴───────┴──────────────┴──────────────────────────────────┘
 */
import { supabase } from "./supabase.js";
import { invalidateOrgJwt } from "./org-jwt.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ── Registry de cambios de nivel ──────────────────────────────────────────────
// Cuando el usuario baja el nivel de autonomía, guardamos un aviso aquí.
// En el próximo request de esa org, Vera recibe la notificación y se auto-corrige.
// El aviso se limpia una vez consumido.

/** @type {Map<string, { from: string, to: string, changedAt: number }>} */
const _downgrades = new Map();

/**
 * Registra un cambio de nivel para notificar a Vera en el próximo request.
 * Solo registra cuando el nivel BAJA (total→parcial, parcial→restringido, total→restringido).
 */
export function recordAutonomyChange(organizationId, fromLevel, toLevel) {
  const order = { restringido: 0, parcial: 1, total: 2 };
  if ((order[toLevel] ?? 0) < (order[fromLevel] ?? 0)) {
    _downgrades.set(organizationId, { from: fromLevel, to: toLevel, changedAt: Date.now() });
  } else {
    // Si sube, solo limpiar el aviso anterior (si lo hubiera)
    _downgrades.delete(organizationId);
  }
}

/**
 * Consume y retorna el aviso de cambio de nivel para una org.
 * Solo retorna una vez — luego lo limpia.
 */
export function consumeAutonomyChangeNotice(organizationId) {
  const notice = _downgrades.get(organizationId);
  if (notice) _downgrades.delete(organizationId);
  return notice ?? null;
}

/** @type {Map<string, { data: OrgAutonomy, expiresAt: number }>} */
const _cache = new Map();

/**
 * @typedef {Object} OrgAutonomy
 * @property {"restringido"|"parcial"|"total"} level
 * @property {"A"|"B"|"C"} phase
 * @property {"block_all"|"require"|"auto"} consentMode
 * @property {"none"|"read"|"full"} passTokens
 */

/** @type {Record<string, OrgAutonomy>} */
const LEVEL_MAP = {
  restringido: {
    level: "restringido",
    phase: "A",
    consentMode: "block_all",
    passTokens: "none",
  },
  parcial: {
    level: "parcial",
    phase: "B",
    consentMode: "require",
    passTokens: "read",
  },
  total: {
    level: "total",
    phase: "C",
    consentMode: "auto",
    passTokens: "full",
  },
};

const DEFAULT_AUTONOMY = LEVEL_MAP.restringido;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Devuelve la configuración de autonomía de una org.
 * Cachea el resultado 5 minutos para no golpear la DB en cada mensaje.
 *
 * @param {string} organizationId
 * @returns {Promise<OrgAutonomy>}
 */
export async function getOrgAutonomy(organizationId) {
  const cached = _cache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("level_of_autonomy, name")
      .eq("id", organizationId)
      .maybeSingle();

    if (error) throw error;

    const raw     = data?.level_of_autonomy ?? "restringido";
    const orgName = data?.name ?? "tu organización";
    const base    = LEVEL_MAP[raw] ?? DEFAULT_AUTONOMY;
    const result  = { ...base, orgName };

    _cache.set(organizationId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (e) {
    console.warn(`autonomy: no se pudo leer la org ${organizationId}:`, e.message);
    return { ...DEFAULT_AUTONOMY, orgName: "tu organización" };
  }
}

/**
 * Invalida el cache de autonomía de una org.
 * Llamar cuando el usuario cambia su `level_of_autonomy`.
 *
 * @param {string} organizationId
 */
export function invalidateAutonomyCache(organizationId) {
  _cache.delete(organizationId);
  invalidateOrgJwt(organizationId);
}

/**
 * Retorna el mensaje explicativo para el usuario cuando su nivel
 * no permite ejecutar una acción.
 *
 * @param {string} level
 * @param {string} actionDescription
 * @returns {string}
 */
/**
 * Mensaje que ai-engine devuelve a OpenClaw cuando bloquea una acción de escritura.
 * OpenClaw lo recibe como respuesta del sistema y lo adapta para el usuario.
 *
 * @param {string} level       — "restringido" | "parcial"
 * @param {string} orgName     — nombre de la organización
 * @param {string} [action]    — descripción de la acción intentada
 * @returns {string}
 */
export function getBlockedByAutonomyMessage(level, orgName = "tu organización", action = "publicar contenido") {
  if (level === "restringido") {
    return (
      `**${orgName}** no me ha dado permisos para ${action} de forma autónoma.\n\n` +
      `Actualmente estoy en modo **restringido** — puedo preparar y redactar contenido, ` +
      `pero no ejecutar ninguna acción. Para darme más autonomía, ve a ` +
      `**Configuración → Organización → Nivel de autonomía** y cámbialo a *parcial* o *total*.\n\n` +
      `¿Quieres que deje el contenido listo para que lo publiques tú manualmente?`
    );
  }

  if (level === "parcial") {
    return (
      `**${orgName}** no me ha dado accesos totales para ${action} de forma autónoma.\n\n` +
      `Estoy en modo **parcial** — puedo preparar y programar contenido, ` +
      `pero la publicación final requiere tu aprobación. ` +
      `Para que pueda publicar sin pedirte confirmación, ve a ` +
      `**Configuración → Organización → Nivel de autonomía** y cámbialo a *total*.\n\n` +
      `He dejado el contenido listo — usa el botón **Publicar** para enviarlo cuando quieras.`
    );
  }

  return `No tengo permisos para ${action} en este momento.`;
}
