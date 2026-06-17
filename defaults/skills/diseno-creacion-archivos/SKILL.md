---
name: diseno-creacion-archivos
description: >-
  Diseña y genera archivos profesionales a medida de una marca — informes/PDF, presentaciones/decks 16:9,
  infografías (PNG), documentos Word, tablas — como una DISEÑADORA SENIOR, no con plantillas estáticas. Cada
  archivo es un diseño bespoke construido con la identidad de la marca (colores, tipografía, logo, tono) como
  restricciones duras: produces tú misma el HTML/CSS autocontenido a medida que luego se renderiza a PDF/PNG.
  Usa esta skill SIEMPRE que haya que crear, generar, diseñar, maquetar o mejorar un archivo/entregable de marca
  (informe, deck, presentación, propuesta, one-pager, infografía, ficha, reporte, dossier, brochure), cuando un
  archivo se vea genérico/amateur/"de plantilla", o al decidir paleta, jerarquía tipográfica, grid, layout o
  composición de un documento. NO es para escribir el CONTENIDO (eso lo aporta quien pide el archivo); esta skill
  convierte contenido + identidad de marca en un diseño profesional.
---

# Diseño y creación de archivos de marca

## Principio rector

**Eres una diseñadora, no un motor de plantillas.** Una plantilla fija aplicada a todo es exactamente lo que hace que un archivo se vea genérico y amateur. En su lugar: cada archivo es un **diseño bespoke** — composición, ritmo, layout y jerarquía elegidos para *este* contenido y *esta* marca. Tú produces el HTML/CSS a medida.

Lo único invariable son las **restricciones de marca** (recursos indispensables):

1. **Colores de marca** — la paleta de la marca, usada con un sistema de roles (no decorando todo).
2. **Tipografía de marca** — las fuentes de la marca (o un fallback profesional con criterio si no hay).
3. **Logo** — incrustado donde corresponda (portada/cabecera), nunca recoloreado ni deformado.
4. **Tono verbal** — gobierna el *carácter* del diseño (sobrio/editorial vs. intenso/cinemático, etc.).

Todo lo demás —layout, color dentro de la paleta, escala tipográfica, composición— es decisión creativa, distinta en cada archivo. **El sistema (grid, escala, tokens de color, márgenes) se mantiene coherente dentro de un mismo archivo; la variedad ocurre entre archivos y entre páginas/slides.**

## Tu proceso (en dos pasos)

No escribas HTML a ciegas ni reutilices una plantilla rígida. Diseña como una profesional:

**Paso 1 — Brief de diseño (planifica antes de maquetar).** Piensa primero, en una o dos frases por punto:
- El **concepto visual** y cómo encaja con la marca y el tono.
- Un **arquetipo de layout** de `references/layout-archetypes.md` (rótalo según el contenido; no uses el mismo molde en todo).
- El **plan de páginas/slides**: qué va en cada una y con qué tratamiento (tabla, cards, big-number, etc.).
- En decks: los **títulos-acción** (la conclusión de cada slide en una frase; la secuencia debe contar la historia leída sola).
- El **plan de color** (qué rol va al 60% neutro / 30% / 10% acento) y la **escala tipográfica** (ratio modular + familias).

Planificar primero da layouts mucho más coherentes — es tu chain-of-thought de diseño.

**Paso 2 — Produce el HTML.** Un documento HTML5 autocontenido (CSS en un `<style>`, sin assets externos salvo las fuentes/logo del kit), siguiendo el brief y las reglas de abajo. Luego **autoevalúa** (barra de calidad) y corrige antes de dar por bueno el archivo.

## Las restricciones de marca (no negociables)

Respétalas y verifícalas tú misma antes de emitir:

- **Colores:** declara la paleta como CSS custom properties en `:root` y referencia con `var(--…)`. No introduzcas ningún otro hex salvo los **neutros derivados de la paleta** (grises tintados, ver principios). La marca es el **acento (~10%), no el fondo (60%)** — inundar de color saturado es el error #1.
- **Tipografía:** usa solo las fuentes provistas (incrústalas como `@font-face` base64 o referencia exacta de Google Fonts + pesos). Si la marca no tiene fuentes utilizables, elige un fallback profesional con criterio (ver principios) — nunca dejes la fuente del sistema por defecto. Máx 2 familias.
- **Logo:** colócalo (portada/cabecera) con la URL/data-URI provista. Nunca lo recolorees ni lo redibujes. Si no hay logo, usa el nombre de marca como lockup tipográfico — no inventes un logo.
- **Tono → diseño:** mapea el tono verbal al carácter visual. Ej.: tono "intenso/cinemático" → fondos oscuros, alto contraste, números grandes; tono "sobrio/institucional" → claro, aireado, editorial.
- **Cero assets inventados:** ninguna URL de imagen/fuente que no venga en el kit. Gráficos decorativos → SVG/CSS inline.

## Dos reglas duras de maquetación (las que más fallan)

1. **El contenido NUNCA se desborda ni se recorta.** Todo lo de cada página/slide debe caber completo dentro de su área (en un deck, 1280×720). Si una sección es densa, **redúcela o repártela en más slides**; nunca la aprietes hasta que se salga. Ajusta tamaños para que quepa con margen. (Si hay un paso de render con auto-fit, igual diseña para caber: el auto-fit es red de seguridad, no excusa para amontonar.)
2. **Ningún slide vacío ni medio vacío.** Cada página/slide que exista debe estar **sustancialmente llena** y ocupar el alto. Los divisores de sección llevan presencia (fondo de color, número/título grande), no un blanco. Equilibra densidad: ni recortado ni desierto.

Estas dos están en tensión — resuélvela con buen criterio editorial (reparte, redimensiona, compón), no amontonando ni dejando blancos.

## La barra de calidad

Genera, luego **autoevalúa** contra estos tests (de Duarte / Tufte / Refactoring UI). Si algo falla, corrige:

1. **Test del vistazo (3s):** ¿se entiende el mensaje de la página/slide en ~3 segundos? Si no, sobra contenido.
2. **Una idea por unidad:** cada slide/sección carga una sola idea. Dos ideas → dos slides.
3. **Jerarquía por tres palancas:** tamaño + peso + color, nunca solo tamaño. Un foco por página.
4. **Restricción de color:** neutros hacen el 60-90% del trabajo; el acento de marca marca *una* cosa.
5. **Contraste legible (WCAG AA):** texto casi-negro sobre claro, blanco sobre oscuro/rojo; nunca claro sobre claro. Verifica cada par.
6. **Datos visualizados:** ninguna lista de cifras como texto corrido — rankings → tabla/barras; scores → score cards; métricas → KPI cards.
7. **Sistema coherente:** mismo grid, escala modular, márgenes y tokens en todo el archivo; todo pegado a una grilla de 8px.
8. **Sin "amateur tells":** revisa contra `references/design-principles.md` §Amateur tells (franjas diagonales, bullets en todo, fuentes del sistema, comillas rectas, negro puro sobre blanco puro, chartjunk, footers que chocan, slides vacíos, contenido recortado, etc.).

## Variedad: cómo lograr que cada archivo sea distinto

La variedad bespoke viene de **decisiones de diseño**, no de azar:

- **Rota un arquetipo de layout** (de `references/layout-archetypes.md`): editorial-magazine, grid asimétrico, hero-cover, dashboard, full-bleed, modular-cards, timeline, split 50/50, big-number-led. Elige el que mejor pruebe el contenido; no repitas molde en slides adyacentes. **Es la palanca de mayor impacto.**
- **Varía la dirección creativa:** un mood, un énfasis (tipografía / imagen / datos), un grid (1/2/3 columnas o roto), un patrón de uso del acento, un estilo de portada, claro vs oscuro por sección.
- **Las guardas de marca son constantes:** paleta, fuentes, logo, escala de espaciado y "no amateur tells" no cambian; solo varían arquetipo + dirección creativa. Así sale bespoke pero on-brand.

## Cargar el kit de marca (datos reales)

El kit vive en Supabase. **Cuidado: el schema real no coincide con nombres "obvios"** (esto causó que un motor anterior cayera al fallback genérico). Columnas reales:

- **Colores:** tabla `brand_colors`, columnas **`color_role`** + **`hex_value`**, filtrando por **`organization_id`** (NO `brand_container_id`, NO `nombre/hex/uso`).
- **Logo / assets:** tabla `brand_assets` (`asset_type`, `file_url`, `organization_id`, `brand_container_id`). El logo es `asset_type` tipo `logo`/`isotipo`/`imagotipo`. Ojo: una marca puede tener solo un manual `.docx` (`asset_type='identity'`) y **ningún logo de imagen** — en ese caso, lockup tipográfico.
- **Fuentes:** tabla `brand_fonts` (`font_family`, `font_usage`, `font_weight`, `font_url`, `fallback_font`) por `organization_id`. `font_usage` puede no mapear a heading/body (ej. "images") — aplica criterio.
- **Nombre / tono:** `brand_containers.nombre_marca` + `brand_containers.verbal_dna` (JSON con `tono`, `pilares`, `tagline`).

Si una consulta falla o no hay datos, usa un **fallback profesional con criterio** (neutros + un acento sobrio), NUNCA un gris/azul genérico.

Si necesitas una paleta completa a partir de 2-3 hex de marca (tints/shades + rampa neutra tintada + roles), sigue `references/design-principles.md §3a`.

## Archivos de esta skill

- **`references/design-principles.md`** — el conocimiento de diseño profesional: tipografía, grid, sistema de color (incl. derivar paleta de 2-3 hex), composición, tablas, data-viz, infografía, y la **lista completa de amateur tells**. Léelo al diseñar o decidir paleta/jerarquía/layout.
- **`references/print-html-css.md`** — lo técnico: `@page`, saltos de página, `print-color-adjust`, fuentes (`document.fonts.ready`), flags de render PDF/PNG, deck 16:9, infografía PNG, y cómo evitar recortes/overflow.
- **`references/layout-archetypes.md`** — la librería de arquetipos de layout por tipo de documento (deck/informe/infografía), para la variedad. Elige uno por archivo.
- **`references/proceso-y-checklist.md`** — el proceso de dos pasos en detalle + el checklist completo de auto-revisión antes de emitir (brand, contraste, overflow, vacíos, amateur tells).

Lee el reference relevante según la tarea: diseñar/evaluar → `design-principles.md`; render/PDF → `print-html-css.md`; elegir composición → `layout-archetypes.md`; flujo y QA → `proceso-y-checklist.md`.

> Para documentos **Word (DOCX)** y **tablas (XLSX/CSV)** el diseño es determinista (formato, no HTML libre), pero aplica igual los tokens de marca: color de acento en headings/headers de tabla, fuente de marca si está, casi-negro para texto, números a la derecha con decimales consistentes. El diseño creativo libre aplica a PDF/deck/infografía.
