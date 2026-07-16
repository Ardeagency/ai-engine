---
name: daily-briefing
description: Produce el digest diario de inteligencia de la marca — el reporte que responde que paso en las ultimas 24h, que significa y que hacemos hoy. Usala al arrancar el ciclo de trabajo o cuando el usuario pida el pulso del dia. Dispara con "brief diario", "que paso hoy", "reporte de la mañana", "daily", "pulso del dia", "resumen del dia", "que paso hoy en el mercado", "dame el pulso del dia". Es el digest consolidado de las ultimas 24h. NO analiza un post puntual de un competidor (eso es competitor-post-analyzer), NO da metricas de APIs conectadas (eso es social-analytics), NO emite el veredicto sobre UNA tendencia concreta (eso es trend-sensing), y NO interpreta hacia donde VA el mercado (eso es market-intuition): este agrega lo que PASO hoy en un reporte accionable.
---

# Daily Briefing — El Pulso del Dia

Tu trabajo: convertir el ruido crudo de las ultimas 24h (señales del scraper, movimientos de competencia, tendencias, alertas) en un brief que se lee en 2 minutos y deja al equipo sabiendo exactamente que hacer. No es un volcado de datos: es la sintesis que ahorra una hora de revisar dashboards.

Responde siempre tres preguntas, en este orden: ¿Que paso? ¿Que significa? ¿Que hacemos?

## Estructura del brief

### 1. Radar del mercado (3-5 lineas)
Que ocurrio relevante en el nicho en las ultimas 24h. Solo lo que toca a ESTA marca. Si una señal no cambia ninguna decision, no va — ocupa espacio que el equipo lee con atencion limitada.

### 2. Movimientos de los perfiles monitoreados (3-5 lineas)
Solo lo accionable, y leido segun el **rol** de cada perfil — no todo es competencia:
- **Competidor** — anomalias, amenazas y brechas que abren jugada para **superarlo**.
- **Referente** — que hizo bien que valga la pena **adaptar** (comunicacion / visual / tono / CTA), segun su relevancia. Es una leccion, no una amenaza.
- **Aliado** — aperturas de **colaboracion** o amplificacion de audiencia compartida.

La actividad rutinaria no se reporta: solo lo que se salio del patron. El equipo asume que "lo normal" sigue normal.

### 3. Oportunidades del dia (2-3 maximo)
Mas de 3 diluye el foco y nada se ejecuta. Para cada una, el formato señal->interpretacion->accion (es lo que vuelve util el brief: la accion ya esta decidida):
- **SEÑAL**: que detectaste
- **OPORTUNIDAD**: que puede hacer la marca con eso
- **ACCION RECOMENDADA**: el paso concreto, hoy

### 4. Contenido recomendado (3-5 piezas)
Cada pieza en una linea: formato + canal + concepto + emocion objetivo + prioridad (urgente / esta semana / backlog). La prioridad es obligatoria: sin ella el equipo no sabe que tocar primero.

### 5. Alertas (solo si las hay)
Lo que exige atencion humana inmediata. Aplica el corte factual: si no hay una alerta real respaldada por una señal del dia, NO inventes una para llenar la seccion. Un brief sin alertas es una buena noticia, no un vacio que tapar.

## Regla de densidad
Si el brief tarda mas de 2 minutos en leerse, esta largo. Edita. Prioriza. Se brutal con lo que se queda y lo que se corta. La densidad es la feature, no un nice-to-have: un brief largo no se lee y la inteligencia muere sin consumir.

## Tono
Directo como un brief ejecutivo de agencia. Sin saludos, sin relleno, sin "como mencione antes". Solo informacion -> interpretacion -> accion.

Antes de entregar, aplica brand-fidelity-check.

## Ejemplo

**Input** — señales crudas del dia (lo que llega del scraper/sensores para una marca de cafe de especialidad):
- Competidor A bajo 18% el precio de su suscripcion mensual ayer 8pm.
- Pico de busquedas "cafe frio en casa" +40% semana (ola de calor regional).
- Influencer de nicho (140k) menciono "aciden brillante" como criterio de compra; 3.2k likes.
- Tu post del martes (proceso natural) duplico el engagement de tu promedio.
- Token de Meta de la marca caduco hace 2 dias; sin ingesta de IG.

**Output** — el brief, ya redactado:

> **RADAR** — Ola de calor dispara "cafe frio en casa" +40% en busqueda regional. Ventana corta (clima), alto intento de compra.
>
> **COMPETENCIA** — Competidor A recorto 18% su suscripcion anoche. No es promo de temporada: es jugada de retencion. Riesgo de fuga en clientes sensibles a precio.
>
> **OPORTUNIDADES**
> 1. SEÑAL: busquedas de cafe frio +40%. OPORTUNIDAD: somos referentes en proceso, no en formato frio. ACCION: pieza-receta de cold brew con nuestro natural, hoy.
> 2. SEÑAL: influencer valida "acidez brillante" como criterio. OPORTUNIDAD: es exactamente nuestro perfil de taza. ACCION: caption educativo conectando acidez->frescura, alineado al post del martes que ya pego.
>
> **CONTENIDO**
> - Reel cold brew paso a paso | IG | "facil de hacer, dificil de igualar" | deseo | urgente
> - Carrusel "que es acidez brillante" | IG | educa el criterio del influencer | curiosidad | esta semana
> - Story responde a precio sin bajar el nuestro: valor vs descuento | IG | confianza | esta semana
>
> **ALERTAS** — Token Meta caducado hace 2 dias: sin ingesta de IG, las metricas del brief estan ciegas en ese canal. Reconectar antes de medir cualquier campaña.

Notese: cada bloque va señal->interpretacion->accion, sin metricas crudas sueltas, y la alerta sale de una señal real (token caduco), no inventada. Eso es un brief de 2 minutos.
