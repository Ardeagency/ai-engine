---
name: error-learning
description: Extrae lecciones de FRACASOS y errores — propios y ajenos — y mantiene una base viva de lecciones aprendidas. Usar despues de un bajo rendimiento, al diseccionar una campaña fallida, un fracaso de competidor, o cualquier retrospectiva. Triggers "que salio mal", "por que no funciono", "postmortem", "retrospectiva", "aprende de esto". Unico para autopsia de fracasos: no es el gate pass/fail de una pieza ni el analisis estrategico del rival.
---

# Error Learning — Los errores son el activo mas valioso

Las victorias confirman lo que ya sabias. Los errores revelan lo que NO sabias. Aprendo mas de lo que falla que de lo que funciona. Mi trabajo no es lamentar el fracaso: es extraerle la causa raiz y convertirla en regla que no se vuelva a romper.

## El ritual de la autopsia

### 1. Describe el resultado sin juicio
Que esperabas. Que obtuviste. Cual es la brecha exacta y medible. Sin adornos ni culpables todavia.

### 2. Elimina excusas comunes
Las excusas son anestesia: matan el dolor pero impiden el diagnostico.
- "El algoritmo estaba raro" -> o el contenido no era suficientemente bueno?
- "No era el momento" -> que señales concretas lo demuestran?
- "La audiencia no estaba lista" -> o el mensaje no conecto con su estado emocional real?

### 3. Los 5 por que hasta la causa raiz
Pregunta "por que?" cinco veces seguidas. Cada respuesta es el por que de la siguiente. La quinta suele ser la causa real — casi siempre un proceso o una suposicion, no la pieza.

### 4. Documenta en `reference/lessons-learned.md`
```
## Leccion #[numero]
Fecha: | Marca/Contexto: | Que fallo: | Causa raiz: | Leccion: | Como evitarlo:
```
Una leccion sin escribir se repite. La memoria operativa es el archivo, no la cabeza.

### 5. Actualiza el proceso
Si la leccion revela una falla sistemica, modifica COMO operas. Cambiar el proceso, no solo la intencion: la disciplina no escala, los sistemas si.

## El registro de victorias explicadas
Cuando algo funciona excepcionalmente bien, no sigas adelante. Detente y explica POR QUE funciono con la misma rigurosidad de una autopsia. Una victoria sin explicacion es suerte. Una victoria entendida es conocimiento replicable.

## Aprender de los errores ajenos
Cuando un competidor lanza una campaña que fracasa, no solo noto que fracaso — disecciono por que fracaso y verifico si yo podria cometer el mismo error. El fracaso ajeno es laboratorio gratis: aprovecharlo sin pagar la multa.

## Regla de humildad operativa
Despues de cada acierto pregunta: "Funciono por las razones que creo, o hubo suerte?" Si no puedo explicar por que funciono con evidencia, la explicacion esta incompleta — y una explicacion incompleta es una trampa para el proximo intento.

## Ejemplo: una campaña que cayo -> la leccion

**Input** — Campaña de lanzamiento de producto: 3 reels en 5 dias, meta 8% engagement, obtuvo 1.2%. El equipo culpa "el algoritmo del fin de semana".

**Output (autopsia):**
- Brecha sin juicio: meta 8%, real 1.2%, faltaron 6.8 puntos. Alcance normal, engagement colapsado -> problema de mensaje, no de distribucion.
- Excusa eliminada: "algoritmo de fin de semana" -> reels anteriores en fin de semana hicieron 6%, asi que el dia no explica la caida.
- 5 por que: 1) Poco engagement -> porque nadie comento. 2) Por que? -> el reel no pedia nada ni abria pregunta. 3) Por que? -> el guion priorizo features del producto. 4) Por que? -> el brief llego como ficha tecnica, no como angulo emocional. 5) Por que? -> **no se valido el hook contra el estado emocional de la audiencia antes de producir.**
- Causa raiz: produccion arranco sin angulo emocional validado.
- Leccion: ninguna pieza de lanzamiento entra a produccion sin hook aprobado contra el estado emocional real.
- Como evitarlo: agregar gate "hook validado" obligatorio antes de cualquier render de campaña.

Asi una caida de 6.8 puntos se vuelve una regla de proceso permanente.

Antes de entregar, aplica brand-fidelity-check.
