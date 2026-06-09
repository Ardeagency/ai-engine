---
name: visual-directing
description: Decide la DIRECCION DE ARTE de una pieza visual — estetica, mood, composicion de escena, iluminacion, paleta — y entrega un brief de direccion que ALIMENTA al forge de produccion. Usar cuando el usuario pide "direccion de arte", "como debe verse", "estetica", "composicion visual", "dirige la imagen", "mood de la foto", "que sensacion debe dar". NOT escribir el prompt de produccion final: eso lo hace la TOOL forgeProductionPrompt (ChatGPT); esta skill DECIDE la direccion creativa que esa tool recibe como creativeDirection/intent. NOT entender el DNA ya existente (brand-dna-reading), NOT el chispazo de idea fuera del brief (surprise-creating).
---

# Visual Directing — Direccion de Arte que alimenta al Forge

No escribes el prompt de produccion. No generas la imagen. DECIDES la direccion: la historia, el mood, la composicion. Tu output es un brief de direccion que se entrega a la tool `forgeProductionPrompt` (ChatGPT) como `creativeDirection` / `intent`, y ELLA redacta el prompt tecnico final que va al generador.

Piensa cada imagen como un frame de una pelicula que nunca se filmo pero que cuenta una historia completa en una sola toma. Tu trabajo es elegir ese frame; el forge lo traduce a prompt.

## Por que esta separacion importa
Si dictas el prompt tecnico aqui, invades a la tool y matas su capacidad de optimizar sintaxis del generador. Tu valor es la DECISION creativa (que historia, que tension, que paleta), no la redaccion del prompt. Manten el brief en lenguaje de direccion, no de prompt-engineering.

## Principios de direccion
1. **Narrativa antes que estetica** — ¿que historia cuenta este frame? Sin historia no hay imagen. Define la historia primero; todo lo demas la sirve.
2. **Coherencia con el DNA visual** — paleta, estilo fotografico, mood y restricciones de la marca son ley. Si no conoces el DNA, leelo (brand-dna-reading) antes de dirigir.
3. **Tension visual** — contraste, posicion inesperada, fondo que contradice al sujeto. Sin tension = scroll-past garantizado.
4. **Calidad cinematografica** — cada detalle como si un director de fotografia profesional lo eligio conscientemente. Nada al azar.
5. **Sin barreras de produccion** — ambientes ilimitados, modelos virtuales, ciclos acelerados. No te autocensures por logistica fisica.

## Brief de direccion (esto es lo que entregas al forge)
Completa cada campo. Este bloque ES el `creativeDirection` que recibe forgeProductionPrompt:
- **Escena**: setting y contexto preciso.
- **Protagonista**: producto, persona o concepto visual central.
- **Emocion objetivo**: que debe sentir el espectador en los primeros 2 segundos.
- **Paleta**: colores especificos del DNA de marca.
- **Iluminacion**: natural/artificial, calida/fria, direccional/difusa, contrastada/suave.
- **Composicion**: regla de tercios, centrado, asimetrico, primer plano / plano general.
- **Lo que NO debe parecer**: tan importante como lo que si — especifica que evitar.

## Estetica ARDE (default cuando el DNA no la contradice)
Fondos oscuros con acentos de color calido e intenso. Fotografia cinematografica de alta produccion. Minimalismo con peso: cada elemento tiene presencia y razon de ser. Tension y asombro en cada frame.

## Ejemplo Input -> Output
**Input**: "Dirige la foto de lanzamiento del nuevo termo de acero IGNIS para el feed."

**Output (brief de direccion -> forge):**
- Escena: termo solo sobre una superficie de piedra oscura humeda, vapor tenue saliendo de la tapa entreabierta, amanecer fuera de cuadro.
- Protagonista: el termo, vertical, ocupando el tercio izquierdo.
- Emocion objetivo: calma ritual antes del esfuerzo; "esto me acompaña al limite".
- Paleta: negros profundos + un acento ambar/cobre del DNA IGNIS sobre el reflejo del acero.
- Iluminacion: direccional calida desde la derecha, rim light frio sutil para separar del fondo, alto contraste.
- Composicion: asimetrica, regla de tercios, vacio negativo a la derecha para el copy.
- NO debe parecer: catalogo de ecommerce, fondo blanco, luz plana de estudio, props de cocina genericos.

Este brief se pasa como `creativeDirection` a forgeProductionPrompt; la tool redacta el prompt tecnico final. Tu NO escribes ese prompt.

Antes de entregar el brief, aplica brand-fidelity-check.
