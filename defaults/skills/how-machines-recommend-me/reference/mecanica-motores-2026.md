# Mecánica de los motores — 2026

Referencia de fundamento para `how-machines-recommend-me`. Aquí va lo que premia LA MÁQUINA.
Lo que premia la gente vive en `the-audience-of-each-platform`.

Marcas: [ESTABLECIDO] = confirmado por la plataforma, por investigación publicada o por
medición amplia y convergente. [EMERGENTE] = medido por la industria, plausible pero no
confirmado por la fuente primaria. Los algoritmos de plataforma son cajas parcialmente
cerradas: casi todo lo de la Parte 1 es medición externa, no documentación oficial. No
presentar lo segundo como lo primero.

---

# Parte 1 — Algoritmos de plataforma (optimizan atención)

## TikTok
- Indexa **tres capas a la vez**: audio transcrito (la de mayor peso), texto en pantalla vía
  reconocimiento óptico, y caption. También lee comentarios. [EMERGENTE]
- Repetir la misma idea en las tres capas rinde del orden de 2 a 3 veces más que mencionarla
  en una sola. [EMERGENTE]
- **Retención**: el umbral que dispara distribución se sitúa alrededor del 70% de video
  completado en 2026, frente a ~50% en 2024. [EMERGENTE]
- **La búsqueda es un canal distinto del feed**: no pondera el conteo de vistas. Un video de
  54.000 vistas puede superar en búsqueda a uno de 250.000. [EMERGENTE]

## Instagram
- Superficies con peso en búsqueda: handle, nombre de perfil, bio, caption, comentarios y
  **texto alternativo**. [EMERGENTE]
- La búsqueda **también analiza la imagen o el video**: usa modelos de embeddings que mapean
  el contenido visual y la consulta al mismo espacio vectorial. Descrito por Adam Mosseri en
  un Q&A de julio de 2026. [ESTABLECIDO]
- **Los hashtags ya no traen tráfico significativo** — dicho por Mosseri. Las keywords en
  caption superan de forma consistente a la estrategia de solo hashtags. [ESTABLECIDO]
- **Los envíos por mensaje privado pesan del orden de 3 a 5 veces más que los likes** para
  alcanzar audiencia nueva. [EMERGENTE]
- Desde el 10 de julio de 2025, el contenido público de **cuentas profesionales se indexa en
  buscadores por defecto** (es opt-out, no opt-in). Historias, destacadas y bio quedan fuera.
  [ESTABLECIDO]

## Facebook
- Los grupos de comunidad generan alrededor de 50% más interacción que las páginas de marca.
  [EMERGENTE]
- Marketplace: ~1.000 millones de usuarios mensuales y más de 20 mil millones de dólares en
  transacciones anuales. [EMERGENTE]

## YouTube
- Señales dominantes: **clics sobre impresiones** y **tiempo de visualización**. [ESTABLECIDO]
- La palabra clave va **en los primeros 60 caracteres del título** y en los **primeros 150 de
  la descripción**; se recomiendan 200+ palabras de descripción para indexar bien. [EMERGENTE]
- **La transcripción se procesa con comprensión de lenguaje**: lo hablado pesa de verdad.
  Conviene subir un archivo de subtítulos limpio en vez de confiar en el automático, que
  introduce errores que ensucian la señal. [EMERGENTE]
- **Los capítulos se indexan tanto en YouTube como en el buscador.** [EMERGENTE]
- Los tags perdieron casi toda su influencia. [EMERGENTE]

## X
- No hay evidencia pública sólida y estable sobre sus factores de ranking en 2026. **No
  inventar factores.** Lo que sí está medido es la conducta de su audiencia — ver la
  referencia de `the-audience-of-each-platform`.

## Tiendas y MercadoLibre
- **El título es el factor SEO principal** en MercadoLibre. [EMERGENTE]
- Le siguen: **ficha técnica y atributos completos** (categorizar mal se penaliza),
  **reputación del vendedor** y **ventas** — el algoritmo interpreta vender como señal de
  calidad. Descripción y fotos ayudan de forma indirecta. [EMERGENTE]
- El algoritmo se vuelve más complejo con el tiempo: revisar antes de dar por vigente una
  táctica vieja. [EMERGENTE]

---

# Parte 2 — Modelos de IA (optimizan confianza)

## La consulta llega contada [ESTABLECIDO]
- Un buscador recibe consultas de 3 a 5 palabras, telegráficas. **Los prompts a modelos
  promedian ~23 palabras**, en frases completas, sin quitar preposiciones ni artículos, y
  contando la situación personal.
- Son multi-turno: la persona refina en diálogo.
- El largo dispara la respuesta generada: consultas de 2 palabras devuelven un resumen de IA
  el 64,6% de las veces; de 11 a 15 palabras, cerca del 89%.

## Query fan-out: inventa las preguntas que nadie hizo [ESTABLECIDO]
- El modelo parsea el lenguaje natural, identifica las facetas del tema, las intenciones
  subyacentes (comparar, explorar, decidir) **y las necesidades implícitas que no se
  escribieron**.
- Genera **consultas sintéticas**: decenas o cientos de sub-consultas distintas. El modo IA
  de Google llega a disparar hasta 8 búsquedas por consulta, y en búsqueda profunda, cientos.
- Pipeline de cuatro etapas: descomposición → recuperación en paralelo → agregación de
  fuentes → síntesis con cita.
- **Consecuencia:** el contenido que gana no responde la pregunta literal; cubre las
  facetas que hay que resolver para decidir.

## Recuperación por pasaje, no por página [ESTABLECIDO]
- El pipeline es: rastreo → troceado → embeddings → recuperación → generación con cita.
  Sustituye el ranking a nivel de página por puntuación a nivel de pasaje.
- Los trozos van de **256 a 512 tokens** y se indexan y citan de forma independiente: el
  primer párrafo, cada subtítulo, cada respuesta de FAQ y cada fila de tabla compiten por
  separado.
- Se comparan por **similitud de coseno** entre el embedding del trozo y el de la consulta.
  Lo que decide no es la densidad de palabras clave ni la autoridad del dominio: es la
  **alineación semántica del pasaje**.
- Largo óptimo de un párrafo citable: **40 a 75 palabras**, con la respuesta primero — es el
  largo medio de los pasajes que citan los principales motores.

## Cada motor lee un mundo distinto [ESTABLECIDO]
Reparto del top-10 de fuentes:
- **ChatGPT** → Wikipedia ~47,9%. Carácter: conocimiento establecido y medios consolidados.
- **Perplexity** → Reddit ~46,7%. Carácter: conversación de comunidad.
- **Resúmenes de IA de Google** → Reddit ~21,0% y YouTube ~18,8%. Carácter: mezcla de
  contenido profesional y social; es el reparto más equilibrado.
- **Solo ~11% de los dominios citados coinciden entre ChatGPT y Perplexity**: una sola
  estrategia no gana la superficie de IA.
- **YouTube superó a Reddit como fuente social más citada** en respuestas de IA a comienzos
  de 2026: aparece en ~16% de las respuestas frente a ~10%. → Publicar video es también GEO.

## Comercio agéntico [ESTABLECIDO]
- Ya hay protocolos abiertos para que agentes compren por su humano: el de OpenAI, y el
  universal de Google presentado en NRF en enero de 2026.
- El agente lee el feed de producto: identificadores (GTIN, UPC, MPN), peso y dimensiones,
  regiones y costos de envío, tiempos estimados, media, y **señales de confianza como número
  de reseñas y calificaciones**.
- **El dato desactualizado es una señal fuerte de descenso en el ranking**; se espera
  refresco diario, y más frecuente si cambian precio o inventario.

---

Ver también `evidencia-geo-2026.md` en esta misma carpeta: contexto de búsqueda sin clic,
estudio de Princeton sobre qué sube y baja las citas, y menciones de marca frente a enlaces.
