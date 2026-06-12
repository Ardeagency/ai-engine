# 🟢 Deprecar parser de markers `[[TOOL:...]]` (post-validación MCP)

**Origen:** resto vivo de `migrate-to-mcp.md` (Entrega B) — eliminado 2026-06-12 al confirmar activación.
**Severidad:** baja — coexistencia funciona, solo es deuda de simplificación.

## Estado de la migración MCP (verificado 2026-06-12)

- Código Entrega B: ✅ completo desde 2026-05-08 (`/mcp/health|list-tools|dispatch` + `src/mcp/ai-engine-tools.js`).
- Org-servers existentes: ✅ el único org-server vivo (IGNIS, re-provisionado 2026-06-09 con el
  cloud-init nuevo) tiene el MCP registrado y lo está usando: requests periódicos a
  `/mcp/health` y `/mcp/list-tools` visibles en journal de ai-engine (2026-06-12 15:29, 15:43).
- Esquemas MCP corregidos en `4d870f9` (2026-06-10).
- Orgs nuevas: nacen con MCP (provisioner lo inyecta en cloud-init).

## Lo que falta

1. **Validación E2E con chat real**: aún no se observa ningún `POST /mcp/dispatch` en logs —
   Vera estuvo bloqueada por saldo Anthropic agotado (ver memoria 2026-06-10). Tras recargar
   saldo: pedir a Vera en chat "lista mis productos" y confirmar `mcp:getProducts` en journal.
2. **Tras ~1 semana de MCP estable**: eliminar el parser regex de markers `[[TOOL:nombre|param:valor]]`
   en `src/services/openclaw.adapter.js`. Ambos canales pasan por el mismo `dispatchTool`,
   así que la remoción es solo limpieza, sin cambio de garantías.

## Por qué no se hace ya

El parser de markers es el fallback si el MCP server local del org-server falla
(`/opt/ai-engine-mcp/.env` corrupto, etc.). Se quita solo cuando MCP esté validado E2E.
