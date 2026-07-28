---
name: how-meta-decides-who-sees-me
description: Tool de comprensión sobre la mecánica con la que Meta reparte pauta en Facebook e Instagram, y qué se puede hacer para trabajar con ella en vez de contra ella. Su sistema hoy tiene tres piezas que hacen cosas distintas — un modelo grande que aprende y transfiere conocimiento, un motor que recupera candidatos de un catálogo enorme, y un ranqueador que resuelve la subasta. De ahí salen tres consecuencias que rompen el manual viejo, la segmentación es pista y no límite, lo orgánico alimenta lo pagado, y la medición se corre hacia lo incremental. La uso al armar o auditar pauta de Meta, ante caídas sin cambio de creativo, y cuando alguien quiere apretar el público. Se activa en "por qué no rinde Meta", "Advantage", "el público está muy amplio", "cómo estructuro la campaña de Meta", "cayó el rendimiento en Instagram". NO es lo que premia el feed orgánico (how-machines-recommend-me). Aquí va la máquina de pauta de Meta.
---

# How Meta Decides Who Sees Me — la mecánica de su pauta

Todo lo que sigue es una aplicación concreta de **how-machines-spend-my-money**. Si
solo voy a recordar una cosa de esta skill, que sea esta: **en Meta, restringir el
público casi siempre empeora el resultado.**

## Las tres piezas, y por qué importa distinguirlas

Meta ya no es un solo algoritmo. Son tres funciones encadenadas:

- **Un modelo grande que aprende.** Entrena sobre enormes volúmenes de
  comportamiento y le pasa lo aprendido a las otras dos piezas. No hace creatividad
  — hace predicciones.
- **Un motor de recuperación.** De un inventario gigantesco de anuncios posibles,
  arma la lista corta de candidatos para esta persona en este instante. Aquí es donde
  mi segmentación se convierte en sugerencia.
- **Un ranqueador.** Resuelve la subasta entre los candidatos y decide cuál se
  muestra.

Cuando algo "no rinde", casi siempre el problema está en la primera etapa: **no
estoy entrando en la lista corta**, y eso es un problema de material y de señal, no
de puja.

## Las tres consecuencias operativas

**La segmentación es una pista, no una reja.** El sistema puede ir más allá de lo que
configuré si encuentra a alguien que convierte mejor. Un público apretado le quita
espacio para explorar. Amplio no significa "a cualquiera": significa dejarlo buscar y
darle una buena señal de qué buscar.

**Lo orgánico alimenta lo pagado.** El contenido que publica la marca ya no vive en
un compartimento separado del rendimiento de sus anuncios. Una cuenta orgánica viva
y coherente le da al sistema mucho más de dónde aprender. Es un argumento comercial
fuerte y poco usado — deja de haber una frontera entre las dos conversaciones.

**La medición se mueve a lo incremental.** El último clic pierde peso frente a
estimaciones de impacto modeladas. Eso hace más importante, no menos, poder correr
una prueba con un grupo retenido — **proving-i-caused-it**.

## Lo que sí me toca hacer bien

- **Darle mucho material y variado.** Es la palanca de mayor efecto. Ángulos y
  formatos distintos para cubrir a la misma persona en momentos distintos de su
  decisión, no diez versiones del mismo anuncio.
- **Cubrir el recorrido completo, no solo el final.** El sistema premia a las marcas
  que aparecen en los distintos momentos de una misma persona. Pauta que solo
  persigue la conversión final desaprovecha cómo está construido.
- **Cuidar la señal.** Que el evento que optimizo sea el que de verdad vale, y que
  llegue limpio.
- **Consolidar en vez de fragmentar.** Muchas campañas chiquitas se reparten el
  aprendizaje y ninguna aprende. Menos estructuras con más volumen aprenden mejor.

## Los errores que voy a ver seguido

- Apretar intereses para "afinar" — le quita exploración al motor.
- Duplicar la campaña que funciona, y que las dos compitan por la misma persona.
- Cambiar el creativo cada semana porque internamente aburre, y borrar la memoria que
  se estaba construyendo — lo cuida
  **the-codes-that-make-me-recognizable**.
- Leer el retorno que reporta la plataforma como si fuera una medición neutral —
  **how-much-i-trust-this-number**.

## Aviso de vigencia

Los nombres de estos sistemas y de los tipos de campaña cambian varias veces al año.
La mecánica de fondo —recuperar, ranquear, aprender de todo— es más estable que las
etiquetas. Cuando una decisión grande dependa de un nombre o de una función
específica, lo verifico contra la documentación oficial y digo con qué fecha lo
afirmo.

## Herramientas que puedo aprovechar

- **getLiveAdsMetrics** → el desempeño agregado de la cuenta.
- **getAdsBreakdown** → bajar de la campaña al conjunto, al anuncio y al día, para
  ver cuál pieza arrastra y cuál sostiene.
- **getMetaPageInsights**, **getInstagramInsights**, **getMetaPosts** → lo orgánico,
  que ahora es parte del rendimiento pagado.
- **getMetaAudienceDemographics**, **getAudiences** → a quién le estoy llegando de
  verdad frente a a quién creo.
- **creative-effectiveness-check** → antes de tocar cualquier palanca de medios.
- **paid-campaign-architecting** → cuando ya toca armar la estructura.
- **how-machines-spend-my-money** → la doctrina de la que esto es un caso.

**Mi límite honesto.** Puedo bajar hasta el conjunto, el anuncio y el día. Lo que no
veo es el creativo en sí — el video o la imagen que la persona vio. Cuando el
diagnóstico apunta a la pieza y no a la estructura, pido verla en vez de juzgarla por
sus números.
