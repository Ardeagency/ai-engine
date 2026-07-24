# Evidencia GEO 2026 — tacticas con respaldo, no intuicion

Referencia de fundamento para geo-optimizing. Marca [ESTABLECIDO] = validado por
datos/consenso; [EMERGENTE] = hipotesis razonable no probada. Asi no vendes humo como hecho.

## El contexto que justifica el cambio [ESTABLECIDO]
- ~65% de las busquedas de Google terminan SIN clic (2026).
- Con AI Overview presente, el CTR organico cae ~38-61% en esa consulta.
- El solapamiento top-10 de Google ↔ citas del AI Overview cayo de ~75% (med-2025) a 17-38%
  (inicios 2026): rankear #1 ya NO garantiza ser citado por la IA.
- Las sesiones referidas por IA crecieron +527% interanual; menor volumen, mayor intencion
  (los clics que sobreviven a un AIO convierten ~23% mejor).
→ El termometro de salud pasa de "posicion/trafico" a PRESENCIA en la respuesta.

## Como ser CITADO por la IA — estudio de Princeton (Aggarwal et al., KDD 2024) [ESTABLECIDO]
Sobre 10.000 consultas, lo que SUBIO las citas 30-41%:
1. **Estadisticas / datos numericos** (+~40%) — densidad factual.
2. **Citar fuentes con citas inline** (+~30%) — cadena de confianza.
3. **Citas textuales de expertos (quotations)** (+~28-41%) — proxy de credibilidad.
4. **Fluidez** (redaccion clara, bien estructurada) y **voz autoritativa**.
No movio o empeoro: keyword stuffing (−10%), simplificacion excesiva, relleno, lenguaje
puramente marketinero. **El efecto fue MAYOR en paginas peor posicionadas** → GEO es palanca
especialmente buena para marcas que aun no dominan el SEO.

Patron de contenido citable: respuesta directa arriba (TL;DR / piramide invertida),
encabezados en forma de pregunta (= consultas reales), listas y tablas comparativas (el
modelo las copia casi literal), bloques auto-contenidos, datos/cifras/fechas/nombres propios
como anclas, contenido fresco con fecha de actualizacion visible.

## El frente nuevo: menciones de marca > backlinks [EMERGENTE-FUERTE]
Analisis de 30M de citas — de donde sacan las respuestas:
- ChatGPT: ~48% Wikipedia, ~11% Reddit, ~7% Forbes.
- Google AI Overviews: ~21% Reddit, ~19% YouTube, ~14% Quora.
- Perplexity: ~47% Reddit, ~14% YouTube, ~7% Gartner.

Hallazgo clave: las **menciones de marca correlacionan ~0,66** con la probabilidad de cita
en IA, vs ~0,22 de los backlinks — la mencion de marca es el predictor mas fuerte. Esto saca
parte del GEO del equipo SEO y lo mete en PR + comunidad:
- **Reddit** (fuente #1 de varios motores): presencia genuina, ser mencionado en hilos de
  recomendacion.
- **Wikipedia / wikis de nicho** si la marca califica por notoriedad.
- **Reseñas y listicles** "mejores X para Y" en medios (la IA los lee para comparativas).
- **Prensa / earned media**: menciones editoriales > link-building volumetrico.

## Medicion — AI Share of Voice [practica ESTABLECIDA; herramientas EMERGENTES]
% de respuestas relevantes de IA que mencionan tu marca vs competidores (ChatGPT, Perplexity,
AI Overviews, Gemini). Define 30-50 prompts representativos de la categoria, correlos
periodicamente, mide: % de menciones, % de citas con enlace, posicion, sentimiento, gap vs
competidor. Herramientas 2026 (categoria joven, pilotar 2-3 sin casarse): Otterly.ai,
Profound, LLMrefs, Peec/LLMPulse, entre otras.

## llms.txt — no te emociones [ESTABLECIDO que NO mueve citas hoy]
Adopcion ~10%; los crawlers de IA lo ignoran (~0,1% de peticiones lo tocan); Google confirmo
que no lo soporta; sin correlacion con ser citado. SI sirve para herramientas de
desarrollo/agentes (Cursor, Claude Code, Copilot lo fetchean): es un play B2A para docs
tecnicas, no una palanca de visibilidad. Publicalo solo si vendes a desarrolladores; si no,
prioridad baja.

## Higiene tecnica para GEO [ESTABLECIDO]
- Permitir los bots de IA (GPTBot, PerplexityBot, ClaudeBot, Google-Extended) en robots.txt
  si quieres ser citado.
- Contenido en HTML renderizable (no escondido tras JS pesado que el crawler no ejecuta).
- Schema JSON-LD (barato, probablemente ayuda; no es la palanca magica).

## La conexion con A2A (vision 2027 de Vera)
Todo esto es la base medible de la vision agente-a-agente: cuando la IA del comprador busque
"mejor X para Y", la marca aparece si construyo densidad factual citable + menciones de marca
+ consistencia de entidad. El AI Share of Voice es como se mide hoy ese futuro.
