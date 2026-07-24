# Principios de diseño profesional (referencia)

Reglas concretas y numéricas para producir diseño que se lea como trabajo de un diseñador senior, no de plantilla. Fuentes: Butterick *Practical Typography*, Material Design 3, IBM Carbon, Refactoring UI, Tufte, Nussbaumer Knaflic *Storytelling with Data*, Duarte, Reynolds *Presentation Zen*, WCAG 2.1, ColorBrewer.

## Tabla de contenido
1. Jerarquía tipográfica
2. Grid y layout
3. Sistema de color (incl. derivar paleta de 2-3 hex)
4. Composición
5. Tablas
6. Data-viz y gráficos
7. Infografías
8. Amateur tells (lista de exclusión)

---

## 1. Jerarquía tipográfica

**Escala modular.** Una escala es geométrica: `size(n) = base × ratio^n`. Elige UN ratio por documento:
- 1.2 (minor third) — docs densos con muchos niveles
- 1.25 (major third) — documentos generales (default seguro)
- 1.333 (perfect fourth) — más editorial/contraste
- 1.414+ — display/editorial con pocos niveles
- Ej. base 16px, ratio 1.25: h6≈16, h5≈20, h4≈25, h3≈31, h2≈39, h1≈49.

**Tamaños.**
- Cuerpo: **10–12pt en print / 15–25px en pantalla**. Default pro: 11pt serif (print) o 12–14px sans (pantalla). Peso ≥400 (nunca hairline para texto).
- En decks: títulos ~36–56px, cuerpo ~22–32px. **Título ≈50% mayor que el cuerpo** para forzar jerarquía.

**Jerarquía por TRES palancas: tamaño + peso + color** — nunca solo tamaño. Dos elementos del mismo tamaño pueden leerse en niveles distintos vía peso y color. Emphasis 600/700.

**Interlineado (line-height).** Cuerpo 1.3–1.45 (1.4 default; nunca <1.3 en prosa). Títulos 1.1–1.2 (texto grande necesita menos). Texto pequeño más holgado (~1.4).

**Medida (line length).** **45–90 caracteres por línea, ideal ~66.** Enforce con `max-width: 66ch`. Demasiado ancho = el ojo pierde el retorno; demasiado angosto = entrecortado. En print, controla la medida con los **márgenes**, no estrechando el bloque.

**Pareo de fuentes.** Máx **2 familias** (o una en varios pesos). Parea por contraste claro (serif + sans es el par seguro); diferencias sutiles parecen errores. Iguala la x-height. Superfamilias eliminan el problema: IBM Plex, Source.

**Serif vs sans.** La diferencia de legibilidad es **despreciable**; importan más calidad, familiaridad, x-height, medida e interlineado. Print de alta resolución → serif viable; pantalla/accesibilidad → sans.

**Micro-tipografía (señales fuertes de pro vs amateur).**
- **Comillas tipográficas siempre:** `" " ' '`; apóstrofo = U+2019. Las comillas rectas nunca deben aparecer. Pulgadas/pies usan primos `′ ″`.
- **Guiones:** hyphen `-` (compuestos), en-dash `–` (rangos 2010–2015), em-dash `—` (incisos). Menos `−` (U+2212).
- **Un espacio tras el punto.**
- **Mayúsculas solo <1 línea**, con tracking 0.05–0.12em (`letter-spacing`). Nunca trackees minúsculas.
- **Nunca subrayes** salvo enlaces — enfatiza con bold *o* itálica, no ambas, en tramos cortos.
- `orphans: 3; widows: 3;` (Chrome lo respeta en print).
- `font-variant-numeric: tabular-nums lining-nums` para columnas numéricas.

---

## 2. Grid y layout

**Grid de columnas.** 12 columnas (divide en 2/3/4/6) para páginas ricas; 6 para prosa de una columna. A4 ≈ 794px, Letter ≈ 816px a 96dpi. Columnas en %, gutters fijos.

**Márgenes y gutters.** Print: **20–30mm** (o 1in/25.4mm). Márgenes externos/inferior más anchos se ven premium (canon Van de Graaf, proporciones 2:3:4:6 inner:top:outer:bottom). Nunca <18mm. Gutters 16–24px, nunca <12px.

**Ritmo vertical / escala de espaciado.** **Pega todo a una grilla de 8px.** Escala canónica: **4 · 8 · 12 · 16 · 24 · 32 · 48 · 64**. Nunca valores arbitrarios (13px, 27px). 4=micro, 8/16=padding de componente, 24/32=entre componentes, 48/64=entre secciones.

**Whitespace.** Espacio generoso = profesionalismo percibido; el desorden baja comprensión. Sesga hacia MÁS espacio; "empieza con demasiado y quita". Deja ≥40–50% de una portada/hero en blanco. Distingue whitespace activo (agrupa) de pasivo.

**Alineación y proximidad.** Cuerpo **alineado a la izquierda** (ancla consistente, sin ríos). **Nunca centres texto largo/multilínea.** Evita justificado en PDF salvo con `hyphens: auto`. Proximidad (Gestalt): más espacio *entre* grupos, menos *dentro* — la forma más barata de mostrar estructura sin bordes.

**Foco y simetría.** **Un foco dominante por página** (el mayor / más contraste / arriba-izquierda u óptico). Layouts asimétricos = dinámico/editorial; simetría estricta = formal (portadas). **Diseña en escala de grises primero, añade color al final** — fuerza jerarquía por espacio/tamaño/contraste antes que por color.

**Regla de tercios.** Divide en grilla 3×3; pon los focos en las líneas o intersecciones. En imágenes, el sujeto en una intersección, no centrado. Layouts texto+imagen: ~1/3 texto : 2/3 visual.

---

## 3. Sistema de color

### 3a. Derivar una paleta completa de 2-3 hex de marca
Modelo mental (Material 3): una **paleta tonal** es un hue + chroma ≈constante variando solo el **tono** (lightness). No necesitas más hues de marca, necesitas más **tonos** del hue de marca + una rampa neutra.

- Genera **9–10 pasos** por color de marca (escala 50/100/.../900; el hex de marca suele caer en ~500). Ancla base + más oscuro (≈900, texto) + más claro (≈50/100, fondos tintados), luego interpola.
- **No muevas solo lightness en HSL** — produce medios lavados y muertos. Correcciones: (a) **sube saturación en los extremos** (claro y oscuro) para no virar a gris; (b) **rota el hue 20–30°** (tints hacia el vecino cálido/brillante, shades hacia el oscuro). Idealmente trabaja en **OKLCH/HCT** (perceptualmente uniforme); HSL con esas correcciones como fallback.
- Espacia los pasos por **contraste** (no por L lineal): saltos mayores en el medio, menores en los extremos.

**Rampa neutra (esto es lo que se ve profesional).** La mayoría del documento son neutros, no color de marca. Mejor que gris puro: **gris tintado de marca** (grises a muy baja saturación del hue de marca, ej. `hsl(brandH, 4–10%, L)`) — se sienten intencionales y on-brand. Genera ~9–10 pasos y asigna: superficies = los 1-2 más claros (o blanco); bordes = gris claro-medio (~200–300); texto secundario = gris medio-oscuro (~600–700); cuerpo = ~800–900 (casi negro, **rara vez `#000` puro**); hover = un paso más oscuro.

### 3b. Roles de color (asigna cada token a uno)
primary/brand · secondary · **accent** (el pop saturado, reservado a *una* cosa por vista) · **neutral** (la rampa gris, el grueso de la página) · semantic (success/verde, warning/ámbar, error/rojo, info/azul). Si la marca *es* roja, diferencia el rojo "error" (cambia hue/sat) y apóyate en iconos.

### 3c. 60-30-10 (presupuesto de color)
**60%** dominante = neutro (fondos, whitespace). **30%** secundario (cards, paneles, headers de tabla). **10%** acento = color de marca en lo de alto valor (KPIs, CTAs, enlaces, *un* dato). **Inversión crítica a respetar: la marca es el 10%, no el 60%.** Bloques grandes de color saturado = barato y cansa la vista (amateur tell #1).

### 3d. Claro vs oscuro
**Claro (texto oscuro sobre casi-blanco) es el default** para long-form/print. Oscuro sirve para portadas/divisores/heros. **Nunca extremos puros:** ni `#000` sobre `#fff`, ni `#fff` sobre `#000`. En decks, alterna claro/oscuro **intencionalmente** para ritmo y marcar capítulos.

### 3e. Texto
Nunca negro puro sobre blanco. Usa casi-negro **`#1a1a1a`–`#222`** (tintado a la temperatura de la paleta). Tres niveles: primario casi-negro (≥4.5:1), secundario gris medio (~`#4b5563`), muted (~`#9ca3af`). Sobre oscuro: off-white `#e5e7eb`/`#f4f4f5`, nunca `#fff`.

### 3f. Accesibilidad (WCAG 2.1 — gates pass/fail)
| Nivel | Texto normal | Texto grande | Gráficos/UI |
|---|---|---|---|
| **AA** | **4.5:1** | **3:1** | **3:1** |
| AAA | 7:1 | 4.5:1 | — |

Texto grande = ≥24px regular o ≥18.66px bold. Default: AA. Fórmula contraste: `(L1+0.05)/(L2+0.05)`; luminancia `L = 0.2126R + 0.7152G + 0.0722B` (canales linealizados). **Para elegir color de texto sobre fondo de marca:** prueba blanco y casi-negro, toma el de mayor contraste, y solo úsalo si pasa 4.5:1 (cuerpo) / 3:1 (grande). Heurística rápida: brillo `(R·299+G·587+B·114)/1000`; >~125 → texto negro, ≤125 → blanco. Un mid-tone saturado (ej. `#e02020`) suele fallar para texto de cuerpo: úsalo solo en labels grandes/bold, o oscurécelo (brand-700/800) hasta que el blanco pase. **Nunca codifiques por color solo** (WCAG 1.4.1): añade icono/label/patrón.

---

## 4. Composición

- **Un foco por página/slide.** El ojo debe saber al instante dónde aterrizar.
- **Whitespace estructural**, no desperdicio: da aire y evita el desorden; poner contenido en tercios genera zonas limpias.
- **Alineación a una grilla compartida** en todas las páginas: mismo margen izquierdo, baseline, gutter. La desalineación es el amateur tell más visible.
- **Full-bleed** para portada, divisores e imágenes: la imagen llega a todos los bordes; texto sobre un scrim/panel sólido para contraste. Evita una imagen pequeña flotando en un mar de plantilla vacía.

---

## 5. Tablas

**Bordes mínimos ("menos tinta").** Solo reglas horizontales, muy ligeras. **Sin líneas verticales, sin cajas por celda** (grids pesados = amateur). Regla bajo el header + opcional regla inferior.
```css
table { border-collapse: collapse; width: 100%; }
th, td { border: none; }
thead th { border-bottom: 2px solid #222; font-weight: 600; }
tbody tr:last-child td { border-bottom: 1px solid #ddd; }
```
- **Zebra** solo en tablas anchas; tinte sutil **`#f7f7f7`–`#fafafa`** (2–4% gris).
- **Header:** semibold, borde inferior 1.5–2px, tinte opcional. Alinea cada header a su columna.
- **Números a la derecha, texto a la izquierda.** Mismos decimales por columna; `font-variant-numeric: tabular-nums lining-nums`. Unidades en el header, no por celda. Nunca centres datos.
- **Padding:** ~6–8px vertical / 10–12px horizontal. Altura de fila consistente.
- **Overflow en PDF (en orden):** `table-layout: fixed` + anchos de columna + `word-break: break-word; overflow-wrap: anywhere;`; repetir header con `thead { display: table-header-group; }`; bajar a 8–9pt en tablas densas; rotar a página landscape para tablas muy anchas. Nunca `break-inside: avoid` en una tabla más alta que una página.

---

## 6. Data-viz y gráficos

- **Maximiza el data-ink (Tufte):** borra tinta no-dato — gridlines pesados, bordes/marcos, fills de fondo, 3D, sombras, ticks redundantes. Eso es **chartjunk**.
- **Un acento + neutros (Knaflic):** el color es preatentivo — pon en gris todo y colorea **solo la serie/barra/punto que importa** con el acento de marca. La jugada de mayor impacto en data-viz.
- **Elige el gráfico por el mensaje:** tendencia → línea; comparación de categorías → barra horizontal; parte-todo → barra apilada única o solo los números (evita pie con muchos slices; **nunca 3D**). Un solo número impresionante → **muéstralo como número**, no lo grafiques.
- **Escalas por tipo (ColorBrewer):** secuencial (un hue claro→oscuro), divergente (dos hues, centro neutro), categórica (≤6–8 hues, colorblind-safe; nunca una rampa secuencial para categorías).
- **KPI/big-number:** el valor es el elemento mayor (~36px bold, acento), contexto (target, delta) menor y quieto. **Redondea:** "518M" > "517,893,412". Delta con flecha + palabra ("+12% vs. mes pasado"), no solo color.
- Siempre **línea de fuente** ("Source: …"); etiqueta unidades; **direct-label** las series en vez de leyendas.

---

## 7. Infografías

- **Jerarquía visual:** lo mayor/más saturado = más importante; establece con escala y contraste, luego desciende. Un foco claro por sección.
- **Grid + márgenes consistentes;** flujo de lectura natural (Z o F; arriba→abajo, izq→der). Secuencia stat cards/pasos en ese orden.
- **Stat cards:** tamaño uniforme, número grande + label corto, un acento, superficie neutra (usa depth por capas sutiles, no sombras pesadas).
- **Iconografía** parca y consistente (un estilo/peso/grid); sirve de canal no-color. No es decoración para rellenar.
- **Restricción:** "cada pixel que no comunica dificulta ver el dato." Whitespace es feature. Una o dos tallas por nivel, un acento, rampa neutra ajustada.
- Infografía PNG: diseña en CSS de pantalla (no print), tamaño fijo del root (ej. 1080×1350 vertical IG), `deviceScaleFactor: 2`.

---

## 8. Amateur tells (lista de exclusión — verifícala antes de emitir)

**Fuentes:** fuentes del sistema (Times/Arial/Calibri) por defecto · Comic Sans/Papyrus · 3+ familias · hairline para cuerpo.
**Tipografía:** comillas rectas · doble espacio tras punto · hyphen como dash · subrayado para énfasis · bold+itálica juntas · párrafos en MAYÚSCULAS · justificado con ríos · cuerpo centrado · líneas a todo el ancho de página.
**Color:** arcoíris/demasiados hues · oversaturación / color de marca como 60% · "azul Office" por defecto · texto gris claro sobre color (bajo contraste) · negro puro sobre blanco puro · gradientes/swooshes decorativos.
**Layout:** todo centrado / sin grid · espaciado aleatorio · sin whitespace, apretado · todo el mismo peso · **texto tocando los bordes / contenido recortado** · **franja diagonal / banner en ángulo** (el tell del PDF de IGNIS) · **footer absoluto que choca con el contenido**.
**Decoración:** clip art / stock cliché · sombras por todas partes · bevels/3D/WordArt · cajas/bordes por todo.
**Estructura:** plantilla por defecto sin portada/branding · estilos de heading inconsistentes · muros de texto · doble titular redundante (sección + subtítulo repitiendo).
**Datos:** pie 3D · chartjunk / gridlines pesados · leyendas desconectadas (usa direct-label) · estilo Excel por defecto · grids de tabla pesados.
**Decks:** "muerte por bullets" · títulos-etiqueta en vez de títulos-acción · tipos diminutos · una sola idea reventada en muchas o muchas ideas en una.
