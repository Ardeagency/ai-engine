/**
 * org-jwt.js — JWTs org-scoped para Vera (Opción A).
 *
 * ai-engine firma un JWT con el JWT_SECRET de Supabase.
 * Claims: { sub: "vera_org_<id>", organization_id: "<uuid>", role: "authenticated" }
 *
 * is_org_member() acepta estos claims → todas las RLS policies pasan.
 * No se crean usuarios reales en Supabase Auth.
 *
 * Uso:
 *   const client = await createOrgClient(organizationId);  // cliente RLS-scoped
 *   const jwt    = await getOrgJwt(organizationId);         // solo el token
 */
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET        = process.env.SUPABASE_JWT_SECRET;

// Renovar token 5 min antes de expirar (tokens duran 1h)
const JWT_TTL_MS   = 55 * 60 * 1000;
const JWT_EXPIRY   = "1h";

// Cache: { jwt: string, expiresAt: number }
const _jwtCache = new Map();

// Limpieza periódica — evita memory leak en servidores con muchas orgs
setInterval(() => {
  const now = Date.now();
  for (const [orgId, entry] of _jwtCache.entries()) {
    if (now >= entry.expiresAt) _jwtCache.delete(orgId);
  }
}, 10 * 60 * 1000); // cada 10 minutos

// ── JWT generation ─────────────────────────────────────────────────────────────

/**
 * Genera (o devuelve del cache) un JWT org-scoped firmado con el JWT_SECRET de Supabase.
 * @param {string} organizationId
 * @returns {Promise<string>}
 */
export async function getOrgJwt(organizationId) {
  const cached = _jwtCache.get(organizationId);
  if (cached && Date.now() < cached.expiresAt) return cached.jwt;

  if (!JWT_SECRET) {
    throw new Error(
      "SUPABASE_JWT_SECRET no está configurado. " +
      "Agrégalo en .env — lo encuentras en Supabase Dashboard → Project Settings → API → JWT Settings."
    );
  }

  const secret = new TextEncoder().encode(JWT_SECRET);

  const jwt = await new SignJWT({
    organization_id: organizationId,
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`vera_org_${organizationId}`)
    .setIssuedAt()
    .setIssuer("supabase")
    .setAudience("authenticated")
    .setExpirationTime(JWT_EXPIRY)
    .sign(secret);

  _jwtCache.set(organizationId, { jwt, expiresAt: Date.now() + JWT_TTL_MS });
  return jwt;
}

/**
 * Crea un cliente Supabase con RLS completamente scoped a la organización.
 * Usa la clave anon + JWT firmado (NO la service key — respeta RLS).
 * @param {string} organizationId
 * @returns {Promise<import("@supabase/supabase-js").SupabaseClient>}
 */
export async function createOrgClient(organizationId) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL o SUPABASE_ANON_KEY no configurados.");
  }

  const jwt = await getOrgJwt(organizationId);

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Invalida el JWT cacheado de una org (útil cuando cambia el level_of_autonomy o se rota el secret).
 * @param {string} organizationId
 */
export function invalidateOrgJwt(organizationId) {
  _jwtCache.delete(organizationId);
}
