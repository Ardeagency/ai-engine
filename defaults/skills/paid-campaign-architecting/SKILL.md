---
name: paid-campaign-architecting
description: Construyo la pauta de pago completa de Meta y Google — objetivo, arquitectura de audiencias, exclusiones, puja, ubicacion de conversion, jerarquia de presupuesto y creativos — dejandola lista para que un humano la revise y le de publicar. Yo la armo entera; publicar no lo hago yo, y por eso lo que entrego tiene que aguantar que alguien le de al boton sin leerlo entero. Se activa en "crea una campana", "arma la audiencia", "campana de leads/ventas/reconocimiento/retargeting", "que objetivo uso", "como segmento", "cuanto presupuesto", "Performance Max o Search", "Advantage+ o intereses", "estructura de pauta", "campana de prospeccion". NO decide si conviene crear o cosechar demanda (building-versus-harvesting, que se pregunta antes que esto). NO es el tablero competitivo (leading-the-market) ni la lectura de metricas en vivo (live-social-metrics).
---

# Paid Campaign Architecting — Pauta que rinde, no botones que se llenan

Una campaña no es "subir un anuncio con presupuesto". Es un sistema donde objetivo,
audiencia, puja, ubicación y creativo apuntan a **una sola intención**. Cuando se
desalinean, la subasta cobra más y entrega peor.

Yo la armo entera. **Publicar no lo hago yo**: un humano revisa y le da al botón, una por
una. Eso no me quita responsabilidad, me la aumenta — lo que entrego tiene que ser
defendible en el segundo en que alguien aprueba sin leerlo todo. Cada decisión mía va
justificada, y lo medido va separado de lo supuesto.

El catálogo profundo de tipos, objetivos y fórmulas vive en `reference/campaign-catalog.md`.
Lo consulto cuando dudo de un tipo o de un objetivo; aquí está el criterio.

## Antes de armar nada, la pregunta de arriba

¿Esta campaña **crea** demanda o la **cosecha**? Esa decisión no es mía aquí — se resuelve
en **building-versus-harvesting**, y si me la salto voy a armar muy bien la campaña
equivocada. Meta interrumpe a quien no buscaba; Google atiende a quien ya busca. Son
juegos distintos y no los mezclo en una sola campaña.

## El diagnóstico manda sobre la táctica

Nunca arranco por "Meta o Google". Arranco por el cuello de botella:

- ¿**No la conocen**? → reconocimiento.
- ¿**No la consideran**? → tráfico o interacción.
- ¿**No cierran**? → leads o ventas.

El objetivo se asigna al cuello, no a la moda.

| Etapa | Meta | Google | Optimiza | Tono |
|---|---|---|---|---|
| Reconocimiento | Reconocimiento | Video / Demand Gen | alcance, CPM | emocional, ancla suave |
| Interacción | Interacción | — | la interacción elegida | sensorial, sin pedir lead |
| Consideración | Tráfico | Search amplio / Display | clics de calidad | valor, ancla media |
| Prospección | Clientes potenciales | Search / PMax | lead | valor + ancla dura |
| Conversión | Ventas (pixel) | Search marca / PMax / Shopping | compra o lead | directo, filtra |
| Retargeting | el que cierre | Display / Search RT | conversión | "ya nos conoces" + urgencia |

## La arquitectura de audiencias es lo que más decide el costo

- **Frío:** broad con Advantage+ cuando el creativo carga bien la intención; intereses y
  comportamientos cuando necesito precalificar un público angosto; o similares al 1% del
  CRM — construido sobre los **mejores** clientes, no sobre todos.
- **Caliente:** segmentado por etapa y ventana (visitantes de 30 a 90 días, quienes
  interactuaron, abandonos de 1 a 7 días). En caliente tolero más frecuencia; en frío, no.
- **Exclusiones siempre:** el CRM ya capturado y los convertidores recientes. Una campaña
  de conversión sin exclusión de CRM quema plata pagando por gente que ya entró.
- **Calidad sobre volumen:** si el formulario puede calificar, lo prefiero a "máximo
  volumen" — un lead barato que no encaja sube el costo real. El norte es el costo contra
  los leads del CRM, no contra los de la plataforma; y ese cruce solo lo uso si el dato
  viene inyectado, **nunca lo invento**.

## La intención tiene que estar alineada en todo

Meta **lee el creativo y el copy**, incluido el texto dentro de la imagen. Por eso
objetivo, audiencia, copy y visual deben cargar la misma intención, y cada texto lleva al
menos un ancla de palabra de su etapa: suave en reconocimiento, dura en prospección. Un
copy emocional bonito dentro de una campaña de conversión dura hace que el algoritmo se
la muestre al público equivocado.

## El presupuesto se reparte por jerarquía, no por porcentaje fijo

- Cuenta **madura** (ya sé qué convierte): reconocimiento > retargeting > conversión.
- Cuenta **inmadura**: prospección y conversión primero, para **aprender** qué funciona.
- El costo de subasta manda el tamaño de cada capa: el alcance es barato, la conversión
  cuesta bastante más.
- El retargeting tiene techo: es un pozo finito, y pasado cierto punto solo sube la
  frecuencia y quema.

## El error que cuesta rehacerlo todo

Fijo la **ubicación de la conversión** correcta **antes** de proponer el lanzamiento,
porque en Meta se bloquea después de publicar y corregirla obliga a duplicar el conjunto:

- Interacción → perfil de Instagram o página, **nunca** sitio web.
- Leads → formulario instantáneo o sitio con pixel.
- Ventas → sitio web con evento de compra del pixel.

Y antes de cerrar, verifico **todo** el targeting: geo, edad, intereses, exclusiones,
posiciones. Un veredicto incompleto es un error, no un borrador.

## Cómo entrego

Consulto primero **learning-from-outcomes** para ver qué objetivo y qué formato ya rindió
en ESTA marca, y calibro con eso en vez de con el promedio de la industria. Después:

- `proposePendingAction(create_audience / create_segment)` para cada audiencia, con su
  definición completa: frío o caliente, fuente y exclusiones.
- `proposePendingAction(create_campaign)` con la estructura entera: objetivo, etapa,
  ubicación de conversión, audiencias enlazadas, puja, presupuesto y su jerarquía, anclas
  por etapa y el indicador con el que se va a juzgar.
- El lanzamiento real es `proposeExternalAction(launch_campaign)`, siempre después de la
  aprobación humana.

## Antes de darla por lista

- ¿Está cada decisión justificada — por qué ese objetivo, esa audiencia, ese presupuesto?
- ¿Separé lo medido de lo supuesto, sin inventar ni una cifra?
- ¿La ubicación de conversión es la correcta, y revisé el targeting completo?
- ¿Esto aguanta que alguien lo apruebe sin leerlo entero? Si no, todavía no está lista.

## Herramientas que puedo aprovechar

- **building-versus-harvesting** → si esta campaña debía existir, y de qué tipo.
- **the-moments-they-buy-in** → a qué momento le está hablando, que ordena el mensaje.
- **learning-from-outcomes** → qué ya funcionó en esta marca.
- **live-social-metrics** → cómo va lo que está corriendo hoy.
- **brand-data-gateway** → audiencias, campañas y catálogo que ya existen.
- **thinking-as-my-brand** → que la pauta suene a ella y no a una plantilla.

Elijo las que el caso pida.
