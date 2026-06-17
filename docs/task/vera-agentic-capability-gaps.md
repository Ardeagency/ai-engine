# 🟡 Vera: brechas de capacidad agéntica

**Actualizado:** 2026-06-16 — ✅ research web (Tavily) y ✅ generación de archivos.

| Capacidad | Estado |
|---|---|
| Búsqueda web abierta (web_search) | ✅ `webSearch` (Tavily) — Fase B |
| Leer URL arbitraria (web_fetch)   | ✅ `webFetch` (Tavily) — Fase B |
| Leer archivos adjuntos (PDF/Word/Excel/img/audio) | ✅ ya existía (media-processor) |
| **Generar archivos de marca** | ✅ `createArtifact`: PDF (informe/análisis), deck PDF (presentación), PNG (infografía), XLSX/CSV (tablas), DOCX (Word) |
| Browser / browsing libre          | ⚠️ solo scraper predefinido |
| Visión / multimodal NATIVO (input)| ⚠️ hoy gpt-4o describe→texto; falta que Claude vea directo |
| Ejecutar código / sandbox         | ❌ pendiente |
| Sub-agentes                       | ❌ pendiente |
| Memoria persistente largo plazo   | ⚠️ parcial |
| MCP en vivo de terceros           | ⚠️ solo MCP propio |

## Resuelto 2026-06-16 — generación de archivos

- `src/services/artifact-renderer.service.js` (motor: brand kit + plantillas +
  Playwright PDF/PNG + SheetJS XLSX/CSV + docx) y `src/tools/artifact.tools.js`
  (`createArtifact` + `listArtifacts`).
- Principio: Vera aporta CONTENIDO (markdown/datos); el motor RENDERIZA con
  colores/tipografía/tono de la marca (fallback profesional si la marca no tiene tokens).
- Persiste en bucket público `vera-artifacts` + tabla `vera_artifacts`. Devuelve URL.
- Wiring: dispatcher (timeout 60s, requiresConsent:false BAJO), validator, catalog,
  Fase B/C, activity-emitter. Verificado E2E: PDF/PNG/XLSX/DOCX OK para IGNIS.
- Deps nuevas: `marked`, `docx` (xlsx + playwright ya estaban).

## Pendiente (siguiente fase)

1. **Frontend galería de artefactos** (panel del chat consume `vera_artifacts` +
   descarga real por formato). Falta policy RLS de lectura por org en `vera_artifacts`
   (hoy RLS service-only). Es la mitad B del trabajo.
2. **Multimodal nativo** (Claude ve imágenes directo, sin gpt-4o intermedio).
