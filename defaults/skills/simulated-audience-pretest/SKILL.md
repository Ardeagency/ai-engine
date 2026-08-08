---
name: simulated-audience-pretest
description: Pre-testeo algo contra la audiencia ANTES de soltarlo, para decidir si publicar, ajustar o rehacer. Tengo dos formas de hacerlo y elegir bien es parte del trabajo — yo misma proyecto la reaccion (inmediato, sirve para UNA pieza), o levanto el Predictor con lanzarPredictor, que instancia agentes de verdad y los deja debatir por rondas (tarda de minutos a horas, sirve para un MOVIMIENTO grande como un precio, una entrada a un mercado o un lanzamiento). Se activa en "testea esto", "como van a reaccionar", "va a funcionar?", "pre-test", "simula la audiencia", "compara estas dos", "que pasa si subimos el precio", "nos conviene entrar a", "predice". UNICO — es la unica forma de probar sin gastar alcance real.
---

# Simulated Audience Pretest — Probar antes de que el mundo lo vea

Publicar o invertir a ciegas quema alcance y dinero. Antes de soltar algo importante simulo
cómo lo recibiría la audiencia y decido con esa lectura. Es orientación informada, no una
predicción exacta — y siempre lo aclaro.

## Primero: cuál de las dos formas

No son intercambiables. Elegir mal cuesta — una hora de espera para juzgar un caption, o un
juicio de dos minutos para decidir un cambio de precio.

**Yo lo razono** (inmediato, en esta conversación) cuando se trata de **una pieza**: un post,
un caption, un anuncio, una miniatura, dos versiones que comparar. La respuesta se necesita
ahora y equivocarse es barato de deshacer.

**Levanto el Predictor** (`lanzarPredictor`) cuando se trata de **un movimiento**: un precio,
una entrada a un mercado, un lanzamiento, un reposicionamiento. Equivocarse cuesta plata de
verdad y la respuesta puede esperar. Ahí vale que agentes con personalidad y memoria debatan
entre ellos por rondas en vez de que yo lo proyecte sola.

Si dudo, pregunto: *¿esto es una pieza o una decisión?* Y si el usuario pide explícitamente
una simulación de verdad, la levanto aunque yo hubiera razonado sola.

---

## Forma A — yo lo razono

### De dónde salen las personas

No invento una audiencia genérica: instancio las personas desde las **audiencias reales
registradas** de la marca (vía `brand-data-gateway`) y las leo con `human-conversion-psychology`
(qué necesita sentir cada una, en qué modo está). Si no hay audiencias registradas, uso un
abanico de arquetipos como punto de partida — pero siempre lo digo.

Un buen abanico cruza distintos estados de compra y actitudes: alguien listo que compra sin
dudar, un escéptico que desconfía, uno que compara tres opciones, un fan que consume y nunca
interactúa, un detractor que podría criticar en público, alguien que podría amplificar. No es
una lista fija que llenar: elijo las que esta marca y esta pieza piden.

### Qué le proyecto a cada persona

- ¿Para o sigue scrolleando en los primeros 2 segundos?
- ¿Qué hace — guarda, comenta, comparte, ignora?
- ¿Qué objeción le surge al verla?
- ¿Qué comentaría si comentara?
- ¿Qué tan probable es que convierta, y por qué?

### Qué entrego

Una lectura sintética: reacción general, engagement y viralidad predichos (con el porqué),
las objeciones top, el punto más débil, y la decisión — publicar / ajustar / rehacer — con la
versión mejorada si aplica. Si hay dos versiones, las expongo a las MISMAS personas y declaro
una ganadora con su razón.

---

## Forma B — el Predictor

Un motor real de simulación de enjambre. Le paso la pregunta y el movimiento; él arma agentes
desde las **personas de audiencia** de la marca, los deja interactuar por rondas y devuelve un
veredicto con señales y su fuerza.

### Las cuatro reglas que no puedo romper

**1. No lo espero.** Una corrida tarda de minutos a horas. `lanzarPredictor` me devuelve un id
y ahí **termina mi turno**: le aviso al usuario que la lancé y sigo con otra cosa. Después
consulto con `getPredictor`. Si me quedo esperando, me cuelgo.

**2. Necesita permiso.** Levanta un trabajo largo y visible, así que pide confirmación humana.
No es una lectura silenciosa: el usuario tiene que saber que la arranqué.

**3. Vale lo que valen las personas.** El motor arma el público desde `audience_personas`. Si
la marca no las tiene descritas — con sus dolores, deseos y objeciones — la corrida devuelve
un análisis genérico disfrazado de simulación. `lanzarPredictor` me avisa de eso en `aviso` y
`semilla_sin`: **si viene con aviso, se lo traslado al usuario antes de que le crea al
veredicto**. Ojo: las "audiencias" de pauta de Meta NO sirven para esto — son cubos de
retargeting, no personas.

**4. Si falló, falló.** `getPredictor` con estado `fallido` significa que no hay predicción.
No invento un resultado ni lo presento como una lectura floja: digo que falló y por qué.

### Cómo leo el veredicto

El veredicto es del motor, no mío. Lo leo, lo interpreto con mi criterio y con la doctrina que
aplique (`reading-beneath-the-surface` para juzgar una señal, `human-conversion-psychology`
para entender la objeción), y **siempre aclaro que es una simulación**.

Miro sobre todo las señales negativas más fuertes: ahí está la objeción que va a aparecer
primero en la vida real, y es lo más accionable de todo el reporte.

Con `listarPredictores` reviso el historial — y si una corrida vieja ya respondió esta
pregunta, no gasto otra.

---

Siempre cierro recordando que es una simulación orientativa: mejor que soltarlo a ciegas, pero
no una certeza.
