/**
 * userAuth middleware — Bearer JWT del usuario (no admin token).
 *
 * Pone req.user = { id, email, ... } si el token es válido.
 * Responde 401 si falta o es inválido.
 *
 * Uso típico: rutas user-facing que requieren saber QUIÉN es el usuario
 * (no solo que la llamada viene del frontend autenticado).
 */
import {
  getBearerToken,
  fetchUserFromAccessToken,
} from "../lib/chat-security.js";

export async function userAuthMiddleware(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }
    const user = await fetchUserFromAccessToken(token);
    if (!user?.id) {
      return res.status(401).json({ error: "Invalid session" });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: e?.message || "Auth failed" });
  }
}
