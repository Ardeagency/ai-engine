/**
 * integration-token-vault.js (ESM — ai-engine)
 * Espejo del helper en functions/lib/integration-token-vault.js (CommonJS).
 * Mantener AMBOS sincronizados: cualquier cambio aquí debe replicarse allá.
 */
import crypto from "node:crypto";

const ALGO     = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ENV  = "INTEGRATION_TOKEN_KEY";
const PREFIX   = "enc_v1:";

let _cachedKey = null;
function getKey() {
  if (_cachedKey) return _cachedKey;
  const b64 = process.env[KEY_ENV];
  if (!b64) throw new Error(`${KEY_ENV} env var missing`);
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`${KEY_ENV} must decode to 32 bytes (got ${key.length})`);
  _cachedKey = key;
  return key;
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptToken(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + Buffer.concat([ct, tag]).toString("base64");
}

export function decryptToken(stored) {
  if (stored == null) return stored;
  if (!isEncrypted(stored)) return stored;
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error("Invalid encrypted token format");
  const iv = Buffer.from(parts[0], "base64");
  const blob = Buffer.from(parts[1], "base64");
  if (blob.length < TAG_BYTES + 1) throw new Error("Encrypted blob too short");
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct  = blob.subarray(0, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function decryptIntegrationRow(row) {
  if (!row || typeof row !== "object") return row;
  if (row.access_token != null)  row.access_token  = decryptToken(row.access_token);
  if (row.refresh_token != null) row.refresh_token = decryptToken(row.refresh_token);
  return row;
}

export function encryptIntegrationPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.access_token  != null) payload.access_token  = encryptToken(payload.access_token);
  if (payload.refresh_token != null) payload.refresh_token = encryptToken(payload.refresh_token);
  return payload;
}
