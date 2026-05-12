# 🟢 17 archivos `.bak.*` sueltos en `src/`

**Detectado:** 2026-05-11
**Severidad:** cosmética — solo ensucia búsquedas

## Síntoma

17+ archivos backup de refactors históricos en `/root/ai-engine/src/` y subdirectorios. Etiquetas observadas: `ops006`, `entrega-a`, `entrega-a5`, `entrega-b`, `bug001`, `feat014`, `feat015`, `markdown-fix`, `before-shopify`, `before-shopify-phase2`, `before-multiplatform-populators`, `shopify-routes-removed`.

Además: `/root/.pm2/dump.pm2.bak` (residuo del PM2 huérfano eliminado 2026-05-11).

## Impacto

- Ruido en `grep -r` (resultados duplicados pre/post refactor)
- Confusión al navegar el repo
- Espacio: <10 MB total, irrelevante

## Fix

```
find /root/ai-engine/src/ -name '*.bak.*' -delete
rm /root/.pm2/dump.pm2.bak
```

Reversible solo desde backups del servidor. Verificar antes que los refactors etiquetados ya están consolidados (lo están — todos los `.bak` tienen contraparte `.js` actual).

## Estado

⏸️ Pendiente. Acción trivial cuando se autorice.
