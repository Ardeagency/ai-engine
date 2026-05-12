/**
 * Brand Resolver — auto-descubre el brand_container_id a partir de organizationId.
 *
 * Principio: ningún caller (OpenClaw, MCP server, tool.dispatcher) necesita saber
 * el UUID interno del brand container. Si no se pasa, este módulo lo resuelve
 * consultando brand_containers filtrando por organization_id.
 *
 * Si la org tiene múltiples brands, se usa el primero (más antiguo / creado primero).
 * Si en el futuro se necesita seleccionar una brand específica, getBrandContainers
 * debe llamarse primero y pasarse el id elegido explícitamente.
 *
 * Cache per-org en memoria (TTL 5 minutos) para no hacer una query extra en cada tool call.
 */
import { supabase } from "./supabase.js";

const _cache = new Map(); // orgId → { id, nombre_marca, expiresAt }
const TTL_MS = 5 * 60 * 1000;

/**
 * Resuelve el brand_container_id para una organización.
 * Si brandContainerId ya se pasó y es un UUID válido perteneciente a la org, lo devuelve.
 * Si es null/undefined/inválido, obtiene el primer brand_container de la org.
 *
 * @param {string|null} brandContainerId  - ID explícito (opcional)
 * @param {string}      organizationId    - UUID de la organización (obligatorio)
 * @returns {Promise<{ id: string, nombre_marca: string }>}
 */
export async function resolveBrandContainer(brandContainerId, organizationId) {
  if (!organizationId) {
    throw Object.assign(
      new Error("organizationId es obligatorio para resolver el brand container"),
      { statusCode: 400 }
    );
  }

  // Si se pasó un ID explícito con formato UUID correcto, verificar que pertenece a la org
  if (brandContainerId && isValidUuid(brandContainerId)) {
    const { data } = await supabase
      .from("brand_containers")
      .select("id, nombre_marca")
      .eq("id", brandContainerId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (data) return data;
    // Si no pertenece a la org, caer al auto-discover (no lanzar error)
  }

  // Auto-discover: buscar primer brand_container de la org
  const cached = _cache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) {
    return { id: cached.id, nombre_marca: cached.nombre_marca };
  }

  const { data, error } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw Object.assign(
      new Error(
        "Esta organización no tiene ninguna marca configurada. " +
        "El usuario debe crear al menos una marca en la plataforma."
      ),
      { statusCode: 404, noBrand: true }
    );
  }

  _cache.set(organizationId, { ...data, expiresAt: Date.now() + TTL_MS });
  return { id: data.id, nombre_marca: data.nombre_marca };
}

/**
 * Invalida el caché de una org (llamar cuando se crea/elimina un brand container).
 */
export function invalidateBrandCache(organizationId) {
  _cache.delete(organizationId);
}

function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}
