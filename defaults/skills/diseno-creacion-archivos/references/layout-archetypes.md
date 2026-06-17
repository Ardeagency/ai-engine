# Librería de arquetipos de layout (referencia para la variedad)

La variedad bespoke viene de **rotar un arquetipo de layout por archivo** — es una decisión de diseño, no azar. El sistema de marca (paleta, fuentes, escala de espaciado, "no amateur tells") se mantiene constante; solo varía el arquetipo + la dirección creativa.

## Cómo usar
1. En tu **brief** elige 1 arquetipo (o hibrida 2) apropiado al tipo de documento y al contenido, y fíjalo como restricción para ese archivo.
2. Para **decks/informes multipágina**, no repitas el mismo arquetipo en páginas/slides adyacentes — alterna para dar ritmo.
3. Combina con **knobs de dirección creativa**: mood (1 palabra), énfasis (tipografía / imagen / datos), grid (1/2/3 col o roto), patrón de acento, estilo de portada, claro vs oscuro.

---

## Arquetipos transversales (sirven a deck, informe e infografía)

- **Hero-cover** — portada/divisor a sangre completa: color de marca sólido o imagen full-bleed, título grande, lockup de logo, mucho aire (≥40-50% vacío). Para abrir y cerrar (bookending).
- **Editorial-magazine** — columnas tipo revista, drop-cap o kicker, jerarquía fuerte serif/sans, imagen anclada a un tercio. Sobrio, premium.
- **Grid asimétrico** — bloques de distinto peso en una grilla de 12 col; foco arriba-izquierda; dinámico/moderno.
- **Modular-cards** — tarjetas uniformes (stat/concepto) en grilla; depth por capas sutiles, no sombras pesadas.
- **Big-number / stat-led** — una cifra gigante (acento) + un calificador corto; el resto en gris. Para un dato que es el mensaje.
- **Split 50/50** — dos mitades (texto / visual, o A vs B). En comparación, enfatiza visualmente la mitad "ganadora".
- **Full-bleed photo-led** — imagen a todos los bordes, texto sobre scrim/panel sólido para contraste.
- **Timeline / flujo** — pasos o hitos en secuencia (Z/F de lectura); conectores finos, no flechas pesadas.
- **Quote / manifiesto** — una frase corta, tipo muy grande, fondo oscuro, mucho negativo. Rompe el ritmo.

---

## Por tipo de documento

### Deck / presentación 16:9
Construye de una **librería de slides nombrados**, no un layout repetido. Anatomía de slide de contenido (estructura consultora): **título-acción** arriba (toda la frase, ver abajo) · **cuerpo/evidencia** (un gráfico/diagrama/layout que prueba el título) · **línea de fuente** abajo (muted). Footer fino opcional (nombre/página), nunca chocando.

Tipos a rotar: cover · agenda · **divisor de sección** (full-color, número "01") · una-gran-idea · big-number · dos-columnas · comparación · slide-de-datos · quote · cierre/CTA (eco de la portada).

**Títulos-acción (la regla de mayor impacto, diferenciador consultora vs PowerPoint):** cada título es la **conclusión en una frase completa**, no una etiqueta-tema. "Q3 creció 14% impulsado por APAC", NO "Resumen Q3". El lector debe poder seguir todo el argumento leyendo **solo los títulos** de arriba a abajo (lógica horizontal / Pyramid Principle). **Flujo para el LLM: escribe primero la secuencia completa de títulos-acción; verifica que cuenten la historia solos; luego diseña cada cuerpo para probar su título.** Rechaza títulos que sean frase nominal ("Panorama de Mercado", "Nuestro Equipo").

Arco narrativo (pitch/Sequoia, 10–15 slides, detalle al apéndice): Propósito → Problema → Solución → Por qué ahora → Mercado → Competencia → Producto → Modelo → Tracción → Equipo → El pedido.

Tipografía en slide: pocas palabras (≤6 líneas, ≤6 palabras/línea como *máximos*, diseña por debajo), tipo grande, jerarquía por contraste. Alterna claro/oscuro intencionalmente para marcar capítulos.

### Informe / documento (PDF, A4/Letter)
- **Portada:** título (foco único, mayor) → subtítulo → autor/cliente → fecha/versión → un logo en posición consistente. ≥40-50% en blanco. Sin stock cliché ni tipos novelty.
- **Divisores de sección** consistentes, numerados ("01 / Resumen"), `break-before: page`.
- **Cuerpo:** una columna a ~66ch, o 12-col para páginas ricas. Headers de sección en escala modular. Ritmo con la escala de 8px.
- **Header/footer corridos** vía margin boxes (paged.js) o templates de Playwright — nunca `position:fixed`. "Página X de Y".
- **Tablas** minimalistas (ver design-principles §5). Figuras/cards con `break-inside: avoid`.
- Mezcla densidad: páginas de texto + una página de datos/cards + un divisor, para dar respiro.

### Infografía (PNG, tamaño fijo)
- Diseña en CSS de pantalla (no print), root con tamaño fijo (ej. 1080×1350 vertical, 1200×630 horizontal), `deviceScaleFactor: 2`.
- Jerarquía visual fuerte: título grande, stat cards uniformes (número grande acento + label corto), flujo de lectura Z/F.
- Un acento, rampa neutra, iconografía parca y consistente (canal no-color). Mucho whitespace.

### Documento Word (DOCX) y Tablas (XLSX/CSV)
Estos pueden seguir siendo **deterministas** (formato, no diseño libre por LLM) pero **aplicando los tokens de marca**: color de acento en headings/headers de tabla, fuente de marca si está disponible, casi-negro para texto, números con alineación derecha y decimales consistentes. El "diseño creativo por LLM" aplica a PDF/deck/infografía (HTML); Word/Excel priorizan estructura editable y compatibilidad.
