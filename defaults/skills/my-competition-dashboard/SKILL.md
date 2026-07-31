---
name: my-competition-dashboard
description: Como construyo el dashboard COMPETENCIA — el tablero donde muestro que hacen los perfiles monitoreados, como suenan, que emocion provocan y sobre todo que van a hacer despues. Incluye COMO me organizo para llenarlo (getVera4Encargo, investigar, publishVera4Card una card por llamada) y la regla que gobierna sus graficos — la forma la fija el tablero, yo alimento la serie. La uso cada vez que escribo o reviso las tarjetas de Competencia (territorio tematico, registro de voz, emocion, busqueda vs voz, supuesto y punto ciego, proxima movida, anomalias, errores ajenos), cuando me piden leer a la competencia o cuando dudo si lo que voy a afirmar de un rival es verificable. Se activa en "lee la competencia", "que estan haciendo los rivales", "llena el tablero de competencia", "analiza a los competidores", "actualiza competencia". NO es la lectura de UNA senal puntual de un rival (competitor-post-analyzer) ni el mapa mental para anticiparlo en abstracto (reading-the-rivals-mind, que es el razonamiento que uso AQUI). NO es la marca por dentro (my-brand-dashboard) ni el mercado (tendencias).
---

# My Competition Dashboard — El tablero que mira hacia afuera

Este tablero responde una pregunta que el cliente no puede contestar solo mirando
feeds: **¿qué están haciendo los que compiten conmigo, por qué lo hacen, y qué
van a hacer después?**

Ver QUÉ publica un rival es trivial — cualquiera abre su perfil. Lo que nadie
más le da es el POR QUÉ detrás de cada movida y la proyección de la siguiente.
Ahí es donde este tab se gana el sitio.

## La doctrina de roles: innegociable

Cada perfil monitoreado tiene un ROL y lo **verifico antes de nombrar a nadie**
(`getCompetenciaActorDetails` / `getIntelligenceEntities`).

- **Competidores** (mismo nicho) son la disputa real: a esos hay que entenderlos
  para REBASARLOS.
- **Referentes** (marcas de otro nicho, de otra liga) NO son competencia. De
  ellos se APRENDE. Nunca digo que "dominan tu nicho", que "te superan" ni que
  "ocupan tu hueco": es falso y le mete miedo al cliente por la razón equivocada.
- **Aliados** se leen como lo que son: una puerta, no una amenaza.

El nombre va EXACTO como está registrado. Si de un perfil no capturé lo
suficiente para juzgarlo, lo **omito**: una fila inventada envenena una tabla
entera y no se nota hasta que alguien decide con ella.

## Cómo se llena, en este orden

1. **`getVera4Encargo({scope:"monitoreo"})`** — ahí está, card por card, qué VA,
   qué NO VA, la prueba que tiene que pasar y por qué ese gráfico es el correcto
   para ese análisis. Se lee ANTES de investigar: el contrato dice dónde va el
   texto, el encargo dice por qué la card existe.
2. **Investigo** con mis tools MCP. Sin límite: cavo hasta tener el juicio, no
   hasta llenar el formato.
3. **`publishVera4Card`**, UNA card por llamada. Ninguna es obligatoria. Si el
   contrato me rechaza algo, me dice exactamente qué campo fue: corrijo esa y
   sigo — las demás no se ven afectadas.
4. **`getVera4Progress`** para cerrar: qué quedó, qué dejé fuera y por qué.

## No opino de lo que no vi

Aquí juzgo a gente que no me va a corregir, así que la disciplina tiene que ser
más dura que en mi propia marca, no más blanda.

**Un contador no es contenido.** «660 comentarios» es un número, no una opinión:
de ahí no se deduce entusiasmo, ni rechazo, ni debate. Un hilo largo puede ser
gente enganchada preguntando cómo comprar, y leerlo como fricción invierte el
hallazgo. Si un juicio se apoya en lo que dice la audiencia, **abro el hilo**:

- **`verPublicacion`** — ver la imagen o el video antes de opinar del formato.
- **`harvestPostComments`** — traer el hilo completo de un post. Cuesta centavos
  reales; lo uso cuando el juicio lo vale, y en Competencia casi siempre lo vale
  porque es la única voz sin filtrar del mercado ajeno.
- **`getHarvestedComments`** — recoger lo cosechado.
- **`studyFollowers`** / **`getFollowerStudy`** — quién lo sigue, no solo quién
  comentó. Lista sus seguidores y abre una muestra de perfiles con bio, tamaño
  de cuenta, rubro y enlace. Instagram, TikTok y X; YouTube y Facebook no
  exponen esa lista y no es una limitación nuestra.

**Dos advertencias que tengo que ESCRIBIR si uso el estudio de seguidores.**
Primera: no es una muestra representativa de toda su base — son los **más
recientes**, o sea quién está llegando ahora. Segunda: **no hay edad, ni género,
ni ciudad**; eso no existe en un perfil. Lo que hay es lo que esa gente **dice
ser** en su bio. Presentarlo como demografía sería inventar precisión.

Y el hallazgo no es el censo — «tiene 12.000 seguidores» no le sirve a nadie. Es
el **contraste**: a quién cree ese perfil que le habla, y quién le está llegando
de verdad. Cuando las dos cosas no coinciden, ahí está la card.

**Ojo con lo que NO está cosechado.** Los scrapers de perfil solo traen la
primera tanda, y en TikTok, Facebook, YouTube y X suelen traer **cero**. Que la
tool me devuelva un conteo alto no significa que yo tenga los comentarios: si no
los pedí, no los tengo. Deducir el tono de un hilo que no abrí es inventar con
buena redacción — y aquí se nota menos que en ningún otro sitio, porque nadie
del otro lado va a desmentirme.

**Cuando el dato choca con la doctrina, gana el dato.** Una teoría de manual
—«ese formato es de fondo de embudo», «eso no convierte»— no tumba lo que la
evidencia sostiene. Si al rival le funciona algo que en teoría no debería
funcionar, la doctrina no es el veredicto: es lo que hay que explicar. Y si
NOSOTROS hacemos lo mismo con otro resultado, esa comparación es el hallazgo —
mismo formato y distinto desenlace es casi un experimento, y lo que cambia entre
los dos vale más que cualquier teoría traída de fuera.

## La regla de los instrumentos: yo no elijo la forma

El tablero fija el gráfico; yo alimento la serie. Si yo eligiera la forma, el
tablero cambiaría de idioma cada semana y el cliente tendría que reaprenderlo en
cada lectura.

Y las **escalas son fijas** a propósito — los mismos tonos, las mismas emociones,
los mismos temas entre perfiles y entre meses. Sin escala fija no hay comparación
posible y el instrumento deja de acumular historia: se vuelve una foto distinta
cada ciclo en vez de un movimiento que se puede leer.

| Card | Qué alimento |
|---|---|
| `territorio_tematico` | Temas (≤8) × perfiles. Una fila por perfil, una columna por tema, **en el mismo orden**. El 0 es un hallazgo: nadie cubre ese tema |
| `registro_de_voz` | Los mismos tonos para todos; cada perfil reparte 100 puntos |
| `emocion_competencia` | Escala con un punto **neutro** (ahí se parte el eje); un valor por punto |
| `busqueda_vs_voz` | Dos series **indexadas a 100** en el primer mes, un valor por mes |

**La nota de método es obligatoria** en los tres primeros. Tono, emoción y temas
los codifico yo leyendo piezas y comentarios — no los midió un sensor. Un gráfico
parece una medición aunque no lo sea, y esa es la forma más fácil de que el
tablero mienta con cara de rigor. Digo sobre cuántas piezas o comentarios lo
construí, siempre.

## Las cuatro esquinas: lo que casi nadie mira

Un tablero de competencia normal solo observa **qué hace** el rival. Esa es una
de cuatro. Las otras tres son las que anticipan:

- **Qué lo mueve** — su caja, su meta de crecimiento, el ego de quien decide ahí.
- **Qué cree** (`supuesto_punto_ciego`) — sus supuestos sobre el mercado, sobre su
  audiencia y sobre nosotros. Donde esa creencia se aleja de lo real vive su punto
  ciego, y ahí está la oportunidad de romperle el plan sin pelear de frente.
  **Pienso como él, no como yo**: me pregunto qué tiene sentido para ÉL.
  **El veredicto puede ser «tiene razón»** — y muchas veces es el más útil. La
  card no existe para demostrar que se equivoca, sino para entender su creencia:
  si le funciona, lo valioso es el MECANISMO, por qué le rinde a él y no a
  nosotros haciendo lo mismo.
- **Qué puede** — sus recursos marcan el límite de lo que puede responder. Un
  rival que anuncia sin capacidad detrás está haciendo teatro; uno que se mueve
  en silencio está preparando algo.

Y con las cuatro, **`proxima_movida`**: cuál es su siguiente jugada más probable
y por qué ahora. Obligatorio el par completo — la señal que la confirmaría y la
que la **DESMENTIRÍA** — más una fecha de revisión. Sin la segunda no es una
hipótesis, es un deseo; buscar solo lo que me da la razón es la forma más común
de equivocarse con confianza. Y cierro en qué hago si ocurre: prever sin preparar
la respuesta es aplazar el problema en desventaja.

## Lo que se lee en el silencio

Lo visible es materia prima; no me quedo ahí.

- **Qué cambió** (`anomalia`): el perfil que cambió de tono, que triplicó su
  frecuencia, que movió precio — o que **dejó de tocar** un tema. Un tema
  abandonado informa tanto como uno nuevo: si paró, algo aprendió o algo le pasó.
  Sin el ANTES no hay anomalía, hay actividad.
- **Qué promete y no cumple**: ahí vive la insatisfacción explotable, y casi nunca
  aparece en una métrica — aparece en la misma queja repitiéndose.
- **Qué NO hace que debería**: ese es mi hueco.
- **En qué fracasó** (`error_ajeno`): disecciono POR QUÉ, y verifico si yo podría
  cometer el mismo error. Sin burla y sin celebración: es material de aprendizaje,
  no munición.

## Lo que NUNCA hago aquí

- **Inventar un dato de un rival.** Si no lo vi, no existe. Un competidor no me va
  a corregir, así que nadie va a atrapar el error hasta que sea caro.
- **Confundir mi lectura con una medición.** Sin nota de método, no publico un
  instrumento de juicio.
- **Copiar al rival como recomendación.** Se gana siendo más nosotros, no siendo
  una versión suya con menos presupuesto. Al rival se le aprende para rebasarlo.
- **Nombrarlo en el contenido de la marca.** Lo que aprendo aquí alimenta la
  estrategia; jamás termina en una pieza que señale a otro.
- **Tratar una hipótesis como un hecho.** Toda lectura de la cabeza ajena se marca
  como hipótesis y busco a propósito lo que la desmentiría. La que sobrevive al
  intento de tumbarla es la única en la que confío.
- **Forzarle un error al que acierta.** Si la evidencia dice que al rival le
  funciona, el veredicto es «tiene razón» y punto. Rellenar el hueco del punto
  ciego con una teoría cómoda porque el formato pide un error es la peor mentira
  del tablero: manda a la marca a atacar un fantasma y le esconde el mecanismo
  que sí debería estudiar.
- **Alarmar por deporte.** Si el ciclo estuvo quieto, lo digo corto y honesto.
  Inflar una amenaza quema la credibilidad de la próxima que sí sea real.
