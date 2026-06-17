# HTML/CSS para print + Playwright + validación (referencia técnica)

Cómo hacer que el HTML generado por el LLM se renderice a un PDF/PNG pulido y fiable con headless Chromium (Playwright). Fuentes: Playwright docs, CSS Paged Media, Smashing *Designing for Print with CSS*, paged.js, OpenAI prompt/structured-outputs docs.

## 1. `@page` — tamaño, orientación, márgenes

```css
@media print {
  @page { size: A4; margin: 18mm 16mm; }       /* o Letter | A3 | "210mm 297mm" */
  /* landscape: @page { size: A4 landscape; } */
}
```
- `size` acepta nombre (`A4`, `Letter`, `A3`, `Legal`) ± `landscape`/`portrait`, o dimensiones explícitas (`size: 1280px 720px;`).
- **Para que Playwright respete el `@page size` del CSS hay que pasar `preferCSSPageSize: true`.** Si no, ganan `format`/`width`/`height` de Playwright y el contenido se escala.
- Los márgenes de `@page` y los de la opción `margin` de Playwright son excluyentes — elige una fuente de verdad.
- Usa unidades absolutas (`mm`, `cm`, `in`, `pt`) para geometría de página.

## 2. Saltos de página

Propiedades modernas `break-before/after/inside`; emite TAMBIÉN los alias `page-break-*` (Chromium los honra más):
```css
@media print {
  .slide   { break-after: page;  page-break-after: always; }
  .chapter { break-before: page; page-break-before: always; }
  .card, .kpi, table, tr, figure, .avoid-break {
    break-inside: avoid; page-break-inside: avoid;
  }
  h2, h3 { break-after: avoid; }      /* el heading no se separa de su contenido */
  p { orphans: 3; widows: 3; }
}
```
`break-inside: avoid` es el fix #1 de cortes feos en cards/tablas — **pero solo funciona si el elemento cabe en una página**.

## 3. Imprimir colores y fondos (crítico)

Chromium quita fondos por defecto para ahorrar tinta. Para forzar fondos de marca:
```css
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
```
**Y** pasar `printBackground: true` a `page.pdf()`. **Ambos** son necesarios. Aplícalo en `*` (un fallo común es ponerlo solo en `body`).

## 4. Fuentes deben cargar antes de renderizar

`load`/`domcontentloaded` NO esperan webfonts → PDF en fuente fallback. Dos capas:
1. **Incrusta** las fuentes: `@font-face` con `src: url(data:font/woff2;base64,…) format('woff2')` + `font-display: block`. Autocontenido, sin race de red, sin URLs inventadas. (Google Fonts vía `<link>` es aceptable pero más lento y es un punto de fallo.)
2. **Espera** `await page.evaluate(() => document.fonts.ready)` tras `networkidle`.

## 5. Flags de `page.pdf()` (Chromium only)

| Opción | Default | Nota |
|---|---|---|
| `printBackground` | false | **true** para fondos/colores (con `print-color-adjust: exact`). |
| `preferCSSPageSize` | false | **true** para honrar `@page { size }`. |
| `format` | "Letter" | A4/A3/Letter/Legal/Tabloid. Prioritario sobre width/height. |
| `landscape` | false | Orientación. |
| `scale` | 1 | 0.1–2. |
| `width`/`height` | — | Dims explícitas ("297mm","1280px"). Override `format`. |
| `margin` | 0 | `{top,bottom,left,right}` con unidades. |
| `displayHeaderFooter` | false | Activa header/footer templates. |
| `headerTemplate`/`footerTemplate` | — | HTML inline (contexto aislado: el CSS de la página NO aplica; inline todo; font-size por defecto 0). Clases `.pageNumber`/`.totalPages`/`.title`/`.date`. Reserva `margin.top/bottom` o se recortan. |

**Llamada base:**
```js
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
```

## 6. Headers/footers sin colisión

- **Chromium nativo NO soporta margin boxes** (`@top-center`, `counter(page)` en CSS) ni `position: running()`. Eso requiere **paged.js** (polyfill que pagina en el navegador y sí implementa margin boxes, named strings, contadores y fragmentación controlada). Si quieres headers corridos por contenido o "Página X de Y" desde CSS, carga paged.js antes de `page.pdf()`.
- Alternativa nativa simple (recomendada): `displayHeaderFooter` + `headerTemplate`/`footerTemplate` de Playwright. Renderizan en el margen → **nunca chocan con el cuerpo**.
- `position: fixed` como header repetido funciona pero es frágil (overlap, z-index, sin contador) — **evítalo** (es la causa del footer encimado en el PDF malo).

## 7. Deck 16:9 (cada slide = una página completa)

```css
@media print {
  @page { size: 1280px 720px; margin: 0; }
  .slide {
    width: 1280px; height: 720px; overflow: hidden;   /* sin página fantasma */
    break-after: page; page-break-after: always;
    box-sizing: border-box; padding: 64px;
    display: flex; flex-direction: column; justify-content: center;
  }
  .slide:last-child { break-after: auto; }             /* sin página final en blanco */
}
```
```js
await page.pdf({ printBackground: true, preferCSSPageSize: true });
```
Pitfall conocido: contenido cortado abajo / página en blanco extra. Causas: suma de márgenes > página, redondeo sub-pixel, `break-after` forzado en el último elemento. Mitiga con `overflow:hidden`, `break-after:auto` en el último, `margin:0` cuando el slide controla su padding.

## 8. Infografía PNG (screenshot de un elemento)

```js
const ctx = await browser.newContext({ deviceScaleFactor: 2 });   // retina
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const el = page.locator('#infographic');                          // bounding box exacto
const png = await el.screenshot({ type: 'png' });
```
- `locator.screenshot()` captura solo ese elemento (sin whitespace). Más fiable que `fullPage`.
- Screenshots usan media **screen**, no print → `@media print` no aplica. Diseña en CSS normal y da tamaño fijo al root (ej. 1080×1350).

## 9. Contrato de salida (tu HTML)

- Emite un único documento HTML5 completo: de `<!DOCTYPE html>` a `</html>`, sin fences markdown ni comentarios alrededor.
- Autocontenido: todo el CSS en un único `<style>` en `<head>`. Sin stylesheets/JS externos (salvo `<link>` de Google Fonts o `@font-face` base64). Ninguna URL de imagen/fuente/asset que no esté en el kit de marca. Gráficos decorativos → SVG/CSS inline. Nunca inventes una URL de imagen.

## 10. Auto-validación antes de dar por bueno el archivo

1. **Estructural:** `<!DOCTYPE html>` + `<html>…</html>`, sin etiquetas rotas.
2. **Assets:** ningún `src=`/`url(` que no sea `data:` o una URL del kit (combate el fallo dominante: assets inventados).
3. **Conformidad de marca:** todos los hex/`rgb()` están en `{paleta de marca} ∪ {neutros derivados}`; solo fuentes de marca, sin otra `font-family`.
4. **Print-readiness:** `print-color-adjust:exact` en `*` y un `@page` (o las opciones de render correctas).
5. **Layout:** ninguna página/slide desborda (contenido recortado) ni queda vacía/medio vacía.

## 11. Modos de fallo → prevención

| Fallo | Causa | Prevención |
|---|---|---|
| Assets inventados (img/font rota) | URLs inventadas | prohibir externos; solo SVG/CSS inline o URIs del kit; validar |
| Colores/fondos no imprimen | ahorro de tinta | `print-color-adjust: exact` en `*` + `printBackground: true` |
| Fuente fallback | fuentes no cargadas | `@font-face` base64 + `font-display:block` + `document.fonts.ready` + `networkidle` |
| Contenido cortado / página en blanco | overflow, sub-pixel, break forzado en el último | `overflow:hidden`, `break-after:auto` en `:last-child`, `preferCSSPageSize` |
| Cortes a media tabla/card | sin control de break | `break-inside:avoid` |
| Clipping horizontal | contenido ancho no-quebrable | `overflow-wrap:anywhere`, `table-layout:fixed` |
| HTML inválido/truncado | truncamiento, fences | `max_tokens` generoso; recortar fences; validar parse |
| Colores off-brand | improvisar color | tokens `:root` + revisar los hex usados |

## 12. Corregir y reintentar

Si la auto-validación encuentra un fallo (hex fuera de paleta, asset externo, overflow/recorte, slide vacío, bajo contraste), **corrígelo y vuelve a verificar** — no des por bueno un archivo con esos defectos. Si el flujo de render incluye un paso de auto-fit (escalar-para-encajar), úsalo como red de seguridad para el encaje, pero diseña para caber igual: el auto-fit no es excusa para amontonar.
