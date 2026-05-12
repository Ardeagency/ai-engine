# 🔴 BUG CRÍTICO — `getIntegrationToken()` no descifra tokens del vault

**Detectado:** 2026-05-11
**Severidad:** alta — bloquea 5 sensores de inteligencia diaria

## Síntoma

5 de 13 sensores activos del ai-engine fallan en cada ejecución:

| Sensor | Cuenta | Error |
|---|---|---|
| `meta_page_insights` | Arde Brands | `Meta API: Invalid OAuth access token - Cannot parse access token` |
| `meta_posts` | Arde Brands | idem |
| `meta_audience_demographics` | (org) | idem |
| `ga4_analytics` | info@ardeagency.com | `needs_reauth` (Google rechaza el refresh) |
| `ga4_audience_demographics` | info@ardeagency.com | idem |

Errores iniciaron **2026-05-09**, día siguiente al cierre del P0 de seguridad (`AES-256-GCM tokens at rest`, 2026-05-08).

## Causa raíz

`src/lib/integration-token.js::getIntegrationToken()` lee `brand_integrations.access_token` / `refresh_token` y los devuelve **sin descifrar**. No importa el vault.

Estado en DB confirmado:
```
facebook   AT: ENCRYPTED (308 chars)
google     AT: ENCRYPTED  RT: ENCRYPTED
shopify    AT: ENCRYPTED
```

El consumidor (`src/tools/social.tools.js`) pasa `integ.access_token` directo a `metaGet()` / `gaGet()` → Meta y Google reciben el ciphertext `enc_v1:...` y lo rechazan.

Bug derivado: `_refreshGoogleIfNeeded()` también usa `integ.refresh_token` cifrado contra el endpoint `/token` de Google → `invalid_grant` → `needsReauth` falso (el refresh_token sí está bueno, solo está cifrado).

## Fix propuesto

Un solo archivo: `src/lib/integration-token.js`. Tres cambios:

1. `import { decryptToken, encryptToken } from "./integration-token-vault.js";`
2. En `getIntegrationToken()`, antes del bloque de refresh, agregar:
   ```js
   integ.access_token  = decryptToken(integ.access_token);
   integ.refresh_token = decryptToken(integ.refresh_token);
   ```
3. En `_refreshGoogleIfNeeded()`, al UPDATE:
   ```js
   .update({ access_token: encryptToken(newToken), token_expires_at: newExpiry })
   ```

El vault es idempotente y backwards-compatible (`decryptToken(plaintext)` devuelve plaintext, `encryptToken(ya_cifrado)` no recifra). No requiere migración de datos.

## Verificación post-fix

1. `systemctl restart ai-engine`
2. Forzar `next_run_at = now()` en los 5 triggers
3. `journalctl -u ai-engine -f` → confirmar que los 5 sensores pasan a `success`

## Estado

⏸️ Pendiente de aplicar. Fix definido y revisado. Esperando OK del usuario.

## Relacionados

- `project_security_baseline` (memoria) — la migración AES que disparó el bug
- Otros consumidores del vault que SÍ lo usan: `token-refresh.service.js`, `campaign-performance.service.js`, `populators/base.populator.js`
