---
name: my-brand-dashboard
description: Como construyo el dashboard MI MARCA — el tablero donde le muestro a la organizacion como coexisten sus plataformas sociales y sus tiendas dentro de un mismo sistema digital, y de ahi saco planes que sostengan un trafico que suba y mas interaccion social. Incluye COMO me organizo para llenarlo — una investigacion y despues un trabajo aislado por tarjeta, que publico yo con publishMiMarcaCard, y como edito por item las que son lista con updateMiMarcaCardItems en vez de rehacerlas. Ninguna tarjeta es obligatoria y ninguna se oculta. La uso cada vez que escribo o reviso las tarjetas de Mi Marca (observacion, intuicion, virtudes, desventajas, algoritmo, audiencias recomendadas, audiencia), cuando me piden leer como va la marca por dentro, o cuando dudo si lo que voy a afirmar sobre ella es verificable. Se activa en "lee mi marca", "como vamos", "que esta pasando con nuestras redes", "llena el tablero", "analiza nuestra cuenta". NO es el analisis de la competencia (ese mira hacia afuera, a los perfiles monitoreados) ni el de tendencias (ese mira al mercado) — aqui el sujeto es la marca misma y nadie mas.
---

# My Brand Dashboard — Leer a la marca por dentro sin inventarle nada

Este tablero responde una sola pregunta grande: **¿cómo se está comportando este
negocio en el sistema digital que ya tiene montado?** Sus redes y sus tiendas no
son piezas sueltas — son un mismo organismo donde una alimenta a la otra. Mi
trabajo es mostrar cómo coexisten hoy, dónde se están estorbando, y qué plan
sostiene un tráfico que suba en vez de un pico que se apague.

No es un informe de resultados. El cliente ya tiene los resultados en pantalla.

## Antes de afirmar: ¿puedo VERLO?

Esta es la disciplina que va primero, porque sin ella lo demás es literatura.

- ¿Estoy mirando la pieza, o solo su texto? Un post es copy **más** imagen o video.
  Si voy a juzgar un formato, primero lo veo — para eso pido ver la publicación.
  Opinar del formato de algo que no vi es inventar con buena redacción.
- ¿Este dato es de la marca, o de otro? Lo propio es lo propio: los perfiles que
  la organización monitorea —competidores y referentes— **no son ella**. Si un
  número me sorprende, lo primero que reviso es de quién es.
- ¿Tengo vista sobre el periodo del que hablo? Antes de decir que algo "lleva
  meses apagado" o que "nunca se hizo", compruebo desde cuándo observa la
  plataforma esa fuente. **No tener el dato no es que no pasara.**
- ¿Qué herramienta me mostró esto? Si no sé responderlo, no lo escribo.
- ¿Necesito más detalle del que tengo? Entonces lo pido. Tengo cómo bajar al
  anuncio, al ad set, al día, a la pieza concreta. Quedarme en el resumen cuando
  podía bajar es pereza, y la pereza aquí se llama suposición.

Si algo no lo puedo ver ni verificar, tengo dos salidas honestas: pedirlo, o
decir que no lo tengo. La tercera —rellenar el hueco con lo que suena razonable—
es la que destruye la confianza, porque suena verdadera y nadie la va a revisar.

## Este tablero lo construyo yo, tarjeta por tarjeta

**Yo publico. Nadie extrae mis tarjetas de mi texto.** Tengo tres herramientas:

- `getMiMarcaProgress` — **qué hay** en cada periodo: cada tarjeta con su edad y,
  las que son lista, con las claves de sus items. **Empiezo siempre por aquí.**
- `publishMiMarcaCard` — deposita **UNA** tarjeta entera en **UN** periodo. Crea
  o **reemplaza**.
- `updateMiMarcaCardItems` — añade o quita **items** de una tarjeta que es lista,
  sin rehacerla.

**Ninguna tarjeta es obligatoria.** Los moldes son siete —`observacion`,
`intuicion`, `virtudes`, `desventajas`, `algoritmo`, `audiencias_recomendadas` y
`audiencia`— y el tablero muestra lo último que le puse a cada uno. **Nada se
oculta por no haberse actualizado.** Una tarjeta que sigue siendo cierta no
necesita que yo la reescriba: dejarla como está es una decisión, no un olvido.
Una tarjeta rechazada me vuelve con el motivo y no tumba a las demás.

`audiencia` es la del mapa y la pirámide: quién me sigue de verdad, por edad,
género y país. Se llena con `getMetaAudienceDemographics`. **Solo si hay
demografía real** — un mapa inventado envenena el tablero entero. Si la hay y no
la escribo, el molde se queda vacío teniendo el dato delante.

### Las tarjetas que son lista NO se rehacen: se editan

`observacion` y `audiencias_recomendadas` son listas de items. Rehacerlas enteras
borra lo que seguía siendo cierto y me obliga a reescribir cinco juicios buenos
para cambiar uno. Así que:

1. Leo lo que ya hay con `getMiMarcaProgress` — me devuelve las claves
   (el `titulo` en observaciones, el `id` en audiencias).
2. Decido **por item**: esto ya no aplica → fuera. Esto es nuevo → dentro. El
   resto **no se toca** y conserva su texto original.
3. `updateMiMarcaCardItems` con `agregar` y/o `eliminar`. Un item nuevo con la
   clave de uno que ya estaba lo **corrige** en su sitio, no lo duplica.

Solo uso `publishMiMarcaCard` en una lista cuando quiero empezar de cero a
propósito. Si no hay nada que cambiar, **no llamo**: eso también es trabajo.

### El ritmo

0. **Miro qué hay** (`getMiMarcaProgress`) y decido qué merece otra pasada. Lo
   que envejece en días para `week` puede aguantar semanas en `year`.
1. **Investigo una vez**, para los cuatro periodos. No cuatro veces.
2. **Destilo lo que encontré a hechos**: cifras con su fuente y su fecha, piezas
   concretas, huecos declarados. No prosa.
3. **Me programo un trabajo por tarjeta**, aislado y escalonado:

```
openclaw cron add --at +30s --session isolated --light-context --delete-after-run \
  --name "mimarca-week-intuicion" \
  --message "<el encargo COMPLETO de esta tarjeta>"
```

4. Cada trabajo despierta con su contexto propio, escribe **su** tarjeta con
   `publishMiMarcaCard`, y muere.

Escalono los `--at` (+30s, +60s, +90s…) o uso `--stagger`. La máquina donde vivo
tiene dos núcleos: amontonar veinte trabajos a la vez no los hace más rápidos,
los hace competir.

### Lo que decide si esto funciona: el mensaje

El trabajo despierta **sin mi investigación y sin esta skill**. Lo único que
tiene es el mensaje que yo le escribí. Si le mando *"escribe la tarjeta de
intuición de la semana"*, va a inventar — porque no le di con qué no inventar.

Cada mensaje lleva, siempre:

- **Qué tarjeta y de qué periodo**, con las fechas exactas de la ventana.
- **Los hechos** que sostienen esa tarjeta: cifras con su fuente, piezas con su
  fecha, lo que vi de la pieza si la vi.
- **Qué NO debe decir**: lo que ya dice otra tarjeta o lo que el tablero ya
  muestra. Una tarjeta que repite la pantalla no vale nada.
- **La orden de publicar** con `publishMiMarcaCard`, nombrando el periodo exacto.
- **Los huecos**: lo que no pude verificar, dicho como hueco. Si no se lo digo,
  el trabajo lo va a rellenar.

### Si algo falla

Un trabajo caído cuesta una tarjeta, no la lectura: las demás siguen en el
tablero y se siguen viendo. `getMiMarcaProgress` me dice qué quedó puesto y de
cuándo, y reprogramo solo la que se cayó. No repito lo que ya está bien.

## La publicación destacada pide un "¿por qué?", no un aplauso

El tablero ya sabe **cuál** ganó: la ordena por interacciones —likes, comentarios,
compartidos, guardados— y las reproducciones no puntúan. Lo que no sabe, y solo yo
puedo poner, es **por qué** ganó.

`getPublicacionDestacada` me da exactamente la misma pieza que el cliente ve, con
su copy completo, la descripción de lo que se ve, los comentarios y el desglose de
su resultado. Escribo el análisis con `explainPublicacionDestacada`, que lo pega a
esa publicación — no al periodo, porque el ranking se recalcula y el texto tiene
que viajar con la pieza.

**No opino de lo que no vi.** Si la tool me dice que falta la descripción visual o
que los comentarios no están cosechados, los pido antes de escribir:
`verPublicacion` para ver la imagen o el video, `harvestPostComments` para traer lo
que dijo la gente. Juzgar el formato de algo que no miré es inventar con buena
redacción, y aquí se nota más que en ningún otro sitio.

**Qué tiene que responder ese párrafo**, en prosa y sin lista:

- **Quiénes** salen y qué papel juegan. Si hay personas, protagonistas; si es
  producto solo, decirlo también — eso ya es un hallazgo.
- **De qué trata** de verdad, no de qué habla el copy.
- **Qué tema** toca y qué estaba pasando afuera cuando se publicó.
- **Cómo está hecha**: formato, ritmo, primer segundo, qué se ve primero.
- **A quién le hablaba** — y si le habló a los de siempre o trajo gente nueva.
- **Por qué a la gente le gustó**, leído en sus comentarios, no en mi intuición.
  Si los comentarios dicen algo que el copy no buscaba, ESO es el hallazgo.

Y lo que convierte el párrafo en trabajo útil: **qué se repite la próxima vez.**
Una lectura que termina en "funcionó muy bien" no le sirve a nadie el lunes. Si no
puedo nombrar qué ingrediente se replica y cuál fue suerte del momento, todavía no
entendí la pieza.

Cuidado con el atajo fácil: que un post del Mundial haya volado no significa que la
receta sea "publicar del Mundial". Significa que la marca supo montarse en algo que
ya estaba pasando — o que ni siquiera lo hizo y el alcance vino solo. Distinguir
esas dos cosas es el trabajo.

## Este tablero se lee con un filtro, y cada periodo pide otra lectura

Arriba del tablero hay un filtro —Semana, Mes, Año, Todo— y un rango que el
cliente puede fijar a mano. Escribo una lectura por cada uno, y **no es el mismo
texto con otro número**:

- En **Semana** manda lo que ACABA de pasar: una pieza que despegó, un silencio,
  algo que se rompió esta semana.
- En **Año** y **Todo** manda el patrón que aguantó el tiempo — lo que sigue
  siendo cierto cuando se mira de lejos. Ojo: eso no es contar la historia de la
  cuenta, es nombrar la constante.
- Si mi lectura de Semana sirve igual para Todo, una de las dos está mal.
- Si el cliente fijó un rango a mano, lo eligió a propósito: hay algo que quiere
  entender ahí. Analizo ESE tramo con sus fechas exactas, no "los últimos días".

Y una trampa propia de este filtro: un periodo corto tiene pocas piezas, así que
una sola puede mover todo el promedio. Cuanto más corta la ventana, más cuidado
con hablar de tendencias — en siete días casi nunca hay una.

## Lo que este tablero SÍ hace

- **Muestra el sistema, no las partes.** ¿La tienda recibe lo que las redes
  mandan? ¿Hay un canal produciendo contenido que no lleva a ninguna parte? ¿Una
  plataforma sostiene a otra o compiten por lo mismo?
- **Nombra lo que hay que hacer distinto**, no lo que pasó.
- **Distingue lo que la marca causó de lo que iba a pasar igual.**
- **Deja el plan en algo que alguien pueda ejecutar el lunes.**

## Lo que este tablero NO hace

- **No narra la historia de la cuenta.** Nadie abre un tablero para que le
  cuenten su propia biografía: la conocen mejor que yo.
- **No mira a la competencia.** Ni de refilón, ni "para dar contexto". Ese
  tablero existe y es otro. Aquí el sujeto es la marca y nadie más.
- **No repite lo que la pantalla ya muestra.** Si mi tarjeta dice el número que
  está tres centímetros más arriba, sobra.
- **No condena un tema por su formato** sin mirar si el momento lo premiaba.
- **No rellena huecos.** Un hueco declarado es información.

## ¿Estoy leyendo el sistema o una sola red?

Si toda mi lectura habla de Instagram, no leí el sistema: leí una red. Antes de
cerrar me pregunto qué papel juega cada plataforma conectada, cuál está
alimentando a cuál, y si la tienda aparece en algún punto de mi relato.

## ¿Mi lectura distingue causa de coincidencia?

Que dos cosas pasaran juntas no dice que una causara la otra. Antes de escribir
"esto funcionó porque…", compruebo si hubo algo más que lo explique: un momento
cultural, una campaña pagada corriendo, un cambio de la plataforma, una pieza
sola moviendo el promedio de una ventana corta.

## ¿Mi plan saca a la marca del bucle?

Un plan que dice "publicar más" o "mejorar el copy" no es un plan: es un deseo.
El plan sale del sistema — de dónde se está perdiendo la energía que ya se está
gastando.

## Lo que la marca borró también me habla

Si una publicación fue publicada y después retirada, el equipo ya emitió su
propio veredicto: reconocieron que algo no funcionó. Es la señal más honesta del
periodo y no está en ningún gráfico. La pregunta no es si estuvo mal — eso ya lo
decidieron ellos —, es **por qué** y qué se hace distinto la próxima vez.

## ¿Esto es profundo, o solo suena bien?

Antes de dar una lectura por buena me interrogo. Si alguna respuesta me incomoda,
todavía no terminé.

**Sobre la marca contra sí misma:** ¿comparé contra datos reales o contra mi
impresión de cómo le va? La única vara legítima en este tablero es su propio
pasado: este periodo contra el anterior, esta plataforma contra las otras, esta
pieza contra su propia mediana. Si para sostener un juicio necesito a un rival,
ese juicio no pertenece aquí.

**Sobre la intuición:** ¿esto lo firmaría un profesional, o lo estoy tomando a la
ligera? La prueba dura: si un tablero pudiera decirlo con una cifra, no es
intuición — es una etiqueta. ¿Miré la pieza real, su copy, su imagen y sus
comentarios, o estoy generalizando desde el título? ¿Separé qué estuvo bien de
qué falló, o condené todo junto porque era más fácil de escribir?

**Sobre el algoritmo:** ¿estoy leyendo cómo esta red lee a ESTA marca, o repitiendo
lo que se sabe de los algoritmos en general? Si mi párrafo sirve para cualquier
cuenta, no leí nada. ¿Sé qué señal concreta le falta a esta cuenta para que la
recomienden, y por qué esa y no otra?

**Sobre la profundidad en general:** ¿mi conclusión resiste que alguien pregunte
"¿y cómo sabes eso?" tres veces seguidas? ¿Qué evidencia desmentiría lo que estoy
afirmando — y la busqué, o solo junté lo que me daba la razón?

## ¿Me quedé en lo básico teniendo con qué profundizar?

Este es mi error más frecuente: leer posts, métricas y campañas —lo evidente— y
entregar sin tocar lo que de verdad explica el negocio. Antes de cerrar reviso si
alguna de estas preguntas aplica y todavía no la respondí:

- **¿A cuánta gente llega esta marca y cuánta la recuerda?** Hay diagnóstico de
  penetración y de demanda: crecer es que más gente la tenga en la cabeza, no que
  los de siempre interactúen más.
- **¿En qué momentos de compra no aparece?** Existe un análisis de los huecos de
  ocasiones — es lo que convierte "publicar más" en "publicar para cuándo".
- **¿Sus señas distintivas la hacen reconocible sin leer el nombre?** Hay una
  auditoría de eso.
- **¿Qué pasó con lo que ya se recomendó antes?** Tengo los resultados medidos de
  acciones pasadas. Recomendar sin mirar eso es empezar de cero cada vez.
- **¿El catálogo y el empaque están ayudando o estorbando?** También son parte del
  sistema digital.
- **¿La marca es citable por los motores que hoy responden por el usuario?** Hay
  un score de eso, y es tráfico que no depende del feed.
- **¿Qué usos del producto nadie está contando?** Hay expansión de casos de uso.

No las uso todas siempre — uso las que el caso pida. Pero si entregué una lectura
sin haber consultado ninguna, entregué la superficie.

## ¿Qué tengo realmente a mano, y qué de eso funciona?

No supongo mi propio inventario:

- Puedo **pedir el catálogo de mis herramientas** por categoría en vez de tirar de
  memoria. Si creo que algo no existe, primero lo busco.
- Puedo **preguntar desde cuándo hay datos** de cada fuente. Una herramienta que
  vuelve vacía casi nunca está rota: suele significar que esa fuente todavía no
  tiene historia para esta marca. Eso no se reporta como fallo, se reporta como
  hueco de datos.
- Si una herramienta pide un identificador, **lo saco de otra** — no la doy por
  inservible.
- Si de verdad no tengo cómo saber algo, lo digo en la lectura. Un hueco declarado
  es información; un hueco tapado es una mentira con buena redacción.

Y no supongo tampoco de qué soy capaz: me programo trabajos, abro sesiones
aisladas, guardo memoria y navego. Antes de pedirle a alguien que orqueste por
mí, reviso si puedo hacerlo yo.

## Herramientas que puedo aprovechar

**Para publicar (solo yo escribo este tablero):**

- `getMiMarcaProgress` → qué hay en cada periodo, de cuándo, y con qué items.
- `publishMiMarcaCard` → deposita UNA tarjeta entera en UN periodo (crea o reemplaza).
- `updateMiMarcaCardItems` → añade o quita items de una lista (`observacion`,
  `audiencias_recomendadas`) sin rehacerla.

**Para pensar:**

- **brand-data-gateway** → lo que la plataforma ya sabe de la marca: piezas,
  audiencias, productos, campañas.
- **live-social-metrics** → el resultado medido, no el recordado.
- **how-much-i-trust-this-number** → cuánto vale cada dato antes de apoyarme en él.
- **proving-i-caused-it** → separar lo que la marca produjo de lo que iba a pasar igual.
- **reading-beneath-the-surface** → cuando el dato no explica lo que veo.
- **the-audience-of-each-platform** → qué papel juega cada red antes de juzgar su
  rendimiento.
- **how-meta-decides-who-sees-me** (y su equivalente por plataforma) → para la
  tarjeta del algoritmo: cómo la está leyendo cada red y qué señal necesita.
