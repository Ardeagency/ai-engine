# Proceso de diseño y checklist de auto-revisión

Cómo diseñar un archivo de marca de principio a fin, y qué verificar antes de darlo por bueno. Tú (la diseñadora) ejecutas ambos pasos.

## Paso 1 — Brief de diseño (planifica antes de maquetar)

Antes de escribir una línea de HTML, decide y anota brevemente:

- **Concepto visual** (1-2 frases): la idea de diseño y por qué encaja con la marca y el tono verbal.
- **Tipo de documento**: report (PDF A4) · deck (16:9) · infographic (PNG) · document (Word) · table (XLSX).
- **Arquetipo de layout** (de `layout-archetypes.md`): el que mejor prueba el contenido. No repitas el mismo molde en páginas/slides adyacentes.
- **Plan de páginas/slides**: para cada una, qué contenido va y con qué tratamiento visual (tabla / cards / big-number / score cards / barras / quote / divisor). Asegura suficientes páginas para que ninguna quede apretada ni vacía.
- **Títulos-acción** (decks): la conclusión de cada slide en una frase completa, no una etiqueta. Verifica que la secuencia de títulos cuente la historia leída sola (lógica horizontal / Pyramid Principle).
- **Plan de color**: qué rol va al 60% (neutro), 30% (secundario), 10% (acento de marca).
- **Escala tipográfica**: ratio modular (1.2 / 1.25 / 1.333) + familia(s) de marca o fallback.

## Paso 2 — Produce el HTML

Un documento HTML5 autocontenido:
- Todo el CSS en un único `<style>` en `<head>`. Sin JS/CSS externos salvo `<link>` de Google Fonts (o `@font-face` base64).
- Paleta como CSS custom properties en `:root`; usa `var(--…)`. Ningún hex fuera de la paleta salvo neutros derivados.
- Sin URLs de assets inventadas; decoración → SVG/CSS inline; logo solo si se provee.
- Reutiliza clases CSS (no repitas estilos inline) — más limpio y eficiente.
- Print/deck: incluye `@page` + `print-color-adjust:exact` en `*`; cada slide ocupa el alto con flex/grid (ver `print-html-css.md`).

Detalles técnicos de render (flags PDF/PNG, deck 16:9, fuentes, saltos) en `print-html-css.md`.

## Checklist de auto-revisión (verifica TODO antes de emitir)

**Marca**
- [ ] Solo hex de la paleta de marca + neutros derivados. La marca es el acento (~10%), no el fondo.
- [ ] Solo fuentes de marca (o fallback profesional con criterio). Máx 2 familias. Nunca fuente del sistema por defecto.
- [ ] Logo colocado correctamente (o lockup tipográfico si no hay). Nunca recoloreado/redibujado.
- [ ] El carácter visual refleja el tono verbal de la marca.

**Maquetación (las dos reglas duras)**
- [ ] **Nada se desborda ni se recorta:** todo cabe completo en cada página/slide (deck: 1280×720). Si hay overflow, reduce/reparte.
- [ ] **Ningún slide vacío ni medio vacío:** cada página está sustancialmente llena y ocupa el alto. Divisores con presencia, no en blanco.

**Diseño**
- [ ] Test del vistazo: el mensaje de cada página se capta en ~3s. Una idea por unidad.
- [ ] Jerarquía por tamaño + peso + color. Un foco por página.
- [ ] Contraste WCAG AA en cada par texto/fondo (casi-negro sobre claro, blanco sobre oscuro/rojo; nunca claro sobre claro).
- [ ] Datos visualizados (tablas/cards/barras/KPIs), no listas de cifras como texto corrido. Números a la derecha, tabular-nums.
- [ ] Espaciado en grilla de 8px; escala tipográfica modular; medida ~66ch en prosa.
- [ ] Variedad de layout entre páginas (no el mismo molde repetido); sistema coherente (grid/tokens/márgenes).

**Amateur tells (ninguno presente)**
- [ ] Sin franjas/banners diagonales, footers que chocan, doble titular redundante, bullets en todo.
- [ ] Sin comillas rectas, negro puro sobre blanco puro, gradientes/sombras/bevels decorativos, clip art.
- [ ] Sin chartjunk, pie 3D, gridlines pesados, grids de tabla pesados, todo centrado en una banda con vacíos.

Si algo falla, **corrige y vuelve a revisar**. Es preferible un deck más largo (bien repartido) que uno recortado o medio vacío.
