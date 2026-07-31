---
name: my-trends-dashboard
description: Como construyo el dashboard TENDENCIAS — el tablero donde leo el MERCADO y no la cuenta, separando lo que va a durar de lo que se apaga en tres semanas, ordenando cada senal por horizonte y decidiendo si a ESTA marca le toca. Incluye COMO me organizo para llenarlo (getVera4Encargo, investigar, publishVera4Card una card por llamada) y la regla de sus instrumentos — la forma la fija el tablero, yo alimento la serie. La uso cada vez que escribo o reviso las tarjetas de Tendencias (latido, senales debiles, triangulacion, tensiones, tendencia o moda, tres horizontes, derecho a jugar, curva de adopcion, momento exacto, lo que falta, crecimiento de categoria, y mi intuicion sobre el mercado), cuando me piden leer el mercado o el nicho, y cuando dudo si una senal merece que la marca se suba. Se activa en "lee las tendencias", "que se esta moviendo", "que hay de nuevo en el mercado", "esto es tendencia o moda", "nos subimos a esto", "actualiza tendencias". NO es la marca por dentro (my-brand-dashboard) ni los perfiles monitoreados (my-competition-dashboard). NO es el juicio de UNA senal puntual (reading-beneath-the-surface, que es el razonamiento que uso AQUI).
---

# My Trends Dashboard — Leer el mercado sin volverse una revista

Un tablero de tendencias falla casi siempre de la misma forma: **informa del
mundo y no dice qué hacer con él**. Una lista de temas calientes es una revista,
no inteligencia.

Tres preguntas lo salvan, y este tab existe para responderlas en orden:

1. **¿Es real o es una moda?**
2. **¿En qué horizonte vive?**
3. **¿A esta marca le toca?**

Si una señal no puede terminar en "le toca / no le toca", no la publico.

## Aquí se lee el MERCADO, no la cuenta

El juicio sobre el contenido propio vive en Mi Marca; el de los perfiles
monitoreados, en Competencia. Si mi lectura se convierte en una auditoría de lo
que la marca publicó, me pasé de tablero. La marca aparece solo como
destinataria: qué de esto la toca.

**Toda señal lleva su reloj**: cuánto lleva abierta y cuándo se cierra. Una
tendencia sin tiempo no se puede accionar. Y si ya es titular del sector,
llegamos tarde — se dice, porque la ventaja está en lo que todavía no tiene
nombre.

## Cómo se llena, en este orden

1. **`getVera4Encargo({scope:"tendencias"})`** — el encargo card por card: qué VA,
   qué NO VA, la prueba que tiene que pasar y por qué ese gráfico es el correcto.
2. **Investigo** con mis tools MCP. Sin límite de tools ni de tokens.
3. **`publishVera4Card`**, UNA card por llamada. Ninguna es obligatoria.
4. **`getVera4Progress`** para cerrar: qué quedó y qué dejé fuera, con mi motivo.

## Yo decido qué se vigila. La automatización solo ejecuta

Los colectores siembran de `palabras_clave`, una lista que alguien escribió una
vez y que no aprende nada. No sabe que ayer un tema encendió los comentarios de
un competidor. Eso lo sé yo, y por eso la curaduría es mía.

**Son dos actos distintos y no los confundo:**

- **`exploreSearchDemand`** — mirar un término **una vez**, ahora. Barato,
  inmediato, sin compromiso. Es como decido si algo merece más.
- **`watchSearchTerm`** — dejarlo montado para que se mida **todos los días**.
  Compromete cuota a diario, así que exige un motivo escrito y la lista tiene
  tope. `listWatchedTerms` para ver qué hay, `unwatchSearchTerm` para soltar.

**Qué merece vigilancia diaria:** un término que apareció en una señal viva —lo
que preguntan en los comentarios de un rival, lo que se repite en las bios de sus
seguidores, la consulta que ya venía en `rising`— y sobre el que voy a tener que
decidir algo. **Qué no:** el nombre de nuestros productos (eso ya lo miden los
colectores) y las curiosidades sin consecuencia. La lista está llena a los cinco:
si quiero meter uno, saco otro y explico por qué. Esa fricción es a propósito.

**Lo que vale de medir a diario no es el número.** Google devuelve la serie de
doce meses en una sola llamada, así que la curva no la construyo yo. Lo valioso
es `nuevas`: **las consultas que hoy están y ayer no**. Una consulta en breakout
es una ola empezando, y eso solo se ve comparando días.

**Tres cosas que digo, siempre que use esto:**

- El interés es **relativo (0-100)**, no un número de búsquedas. Compara momentos
  y términos entre sí; no estima tráfico.
- **Sin volumen no significa sin valor.** La búsqueda mide demanda que YA existe.
  Nadie busca lo que todavía no sabe que existe, y ahí es donde vive lo que hay
  que construir.
- Si la cuota se acabó y no pude consultar, **lo digo**. «No hay demanda» y «no
  pude mirar» son cosas distintas, y confundirlas es como se entierra una idea
  buena con cara de dato.

## Tendencia o moda: tres marcadores, nunca un puntaje

Una tendencia real muestra **tres marcas a la vez**; un momento viral suele
mostrar una sola y desaparece en 48 horas.

- **Persistencia** — cuántas semanas lleva viva, no cuán alto picó. Una moda es
  justo la que más alto pica.
- **Propagación** — si cruzó de plataforma. Lo que se queda en una sola casi
  siempre es una moda de esa plataforma, no del mercado.
- **Consistencia** — si la historia es la misma o cada semana significa otra cosa.

Los tres van visibles y por separado (`tendencia_o_moda`): colapsarlos en un
"trend score" destruye justo el diagnóstico. Y **"es una moda, no te subas" es
una entrega valiosa**: el permiso de dejar pasar vale tanto como señalar la
buena. Si una señal es demasiado joven para juzgarla, ese es un veredicto
legítimo — `pronto_para_saber`, con fecha de revisión.

## Ordenar por horizonte, no por urgencia sentida

El problema real no es encontrar señales: es que **todas se ven igual de
urgentes**. Tres carriles obligan a decidir (`tres_horizontes`):

- **H1 — hoy**: el sistema actual, exige acción ahora.
- **H2 — transición**: hay que preparar algo para que no nos agarre montados.
- **H3 — lejano**: podría redefinir la categoría. Se vigila y se nombra; **no se
  corre a hacerlo**, y esa quietud es parte del método.

Meterlo todo en H1 no es ordenar. El contrato lo rechaza a propósito.

## ¿Le toca a esta marca? Cuatro preguntas

Por cada señal (`derecho_a_jugar`), con su razón en una línea:

- **Autoridad** — ¿puede hablar de esto sin sonar forzada?
- **Audiencia** — ¿la comunidad que lo mueve es la suya o una vecina?
- **Momento** — muy pronto se confunde; muy tarde se compite en un mensaje que
  ya saturaron.
- **Territorio** — ¿alguien ya se quedó con esa narrativa?

**DEJAR PASAR tiene que aparecer.** Una marca que se sube a todo no se recuerda
por nada.

## ¿Subió el nicho o subiste tú?

`crecimiento_categoria` separa las dos historias porque se corrigen distinto:
crecer menos que la categoría **es perder cuota** aunque el número sea positivo.
El crecimiento de una marca correlaciona mucho más con ganancias de cuota
(r=0,97) que con el crecimiento de la categoría (r=0,25), y para una marca
pequeña la cuota pesa todavía más.

Y ojo con la unidad: aquí mido **conversación observada**, no ventas. Se dice.

## La regla de los instrumentos

Yo **no elijo la forma**: alimento la serie y el tablero pone el eje, la escala y
el color. Con escalas fijas, para que un mes se pueda comparar con el anterior y
el instrumento acumule historia en vez de ser una foto distinta cada ciclo.

Donde el dato es juicio mío —la consistencia narrativa, quién adopta— va la
**nota de método**: un gráfico parece una medición aunque no lo sea.

## Mi intuición sobre el mercado — la única card sin tema asignado

`intuicion` es **mía y de este tablero**. No la copio de Mi Marca ni de
Competencia: allí el sujeto es la marca o el rival, aquí es **el mercado**. Si la
que escribo aquí se pudiera pegar en otro tab sin que se note, no escribí nada.

No tiene tema: tiene un **método**. Un humano ya ve que una búsqueda subió; lo que
no ve es el **porqué**.

1. **Parto de UNA señal concreta** —una conversación, una búsqueda que se mueve,
   algo que la gente empezó a decir— y respondo por qué se mueve **AHORA** y no
   hace seis meses. Del mercado en abstracto sale un horóscopo.
2. **Nombro lo obvio** que el tablero ya muestra de esa señal. Si mi lectura es lo
   obvio con otras palabras, no la escribo.
3. La intuición de este tab casi siempre está en la **causa emocional** debajo de
   la señal: qué cambió en la vida de esa gente para que esto les importe hoy.
4. **Cierro en qué le toca hacer a esta marca** con esa ventana, con su reloj:
   cuánto lleva abierta y cuánto le queda.

La vara: si un tablero pudiera decirlo con una cifra, no es intuición — es una
etiqueta. Y aquí no resumo lo que ya es noticia: si ya es titular, llegamos tarde.

## Lo que NUNCA hago aquí

- **Publicar una señal sin evidencia.** Si no la vi, no existe. Una tendencia
  inventada hace que la marca produzca para un mundo que no está pasando.
- **Confundir volumen con movimiento.** El pico más alto suele ser la moda.
- **Inflar para tener algo que decir.** Si el ciclo estuvo quieto, lo digo corto.
  Una tendencia de relleno quema la credibilidad de la próxima que sí importe.
- **Recomendar subirse a todo.** Cada señal que la marca toma es una que no puede
  contar bien; el criterio es más valioso que la cobertura.
- **Dibujar una curva con datos que no tengo.** Clasificar quién habla no es
  medir adopción, y esa diferencia se declara.
