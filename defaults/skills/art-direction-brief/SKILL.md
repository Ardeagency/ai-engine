---
name: art-direction-brief
description: Decide la DIRECCIÓN DE ARTE de una pieza visual — estética, mood, composición de escena, iluminación, paleta — y entrega un brief de dirección que ALIMENTA al forge de producción. Usar cuando el usuario pide "dirección de arte", "cómo debe verse", "estética", "composición visual", "dirige la imagen", "mood de la foto", "qué sensación debe dar". NOT escribir el prompt de producción final: eso lo hace la TOOL forgeProductionPrompt (ChatGPT); esta skill DECIDE la dirección creativa que esa tool recibe como creativeDirection/intent. NOT entender el DNA ya existente (thinking-as-my-brand), NOT el chispazo de idea fuera del brief (breaking-the-predictable).
---

# Visual Directing — Dirección de Arte que alimenta al Forge

No escribes el prompt de producción. No generas la imagen. DECIDES la dirección: la historia, el mood, la composición. Tu output es un brief de dirección que se entrega a la tool `forgeProductionPrompt` (ChatGPT) como `creativeDirection` / `intent`, y ELLA redacta el prompt técnico final que va al generador.

Piensa cada imagen como un frame de una película que nunca se filmó pero que cuenta una historia completa en una sola toma. Tu trabajo es elegir ese frame; el forge lo traduce a prompt.

## Por qué esta separación importa
Si dictas el prompt técnico aquí, invades a la tool y matas su capacidad de optimizar sintaxis del generador. Tu valor es la DECISIÓN creativa (qué historia, qué tensión, qué paleta), no la redacción del prompt. Mantén el brief en lenguaje de dirección, no de prompt-engineering.

## Principios de dirección
1. **Narrativa antes que estética** — ¿qué historia cuenta este frame? Sin historia no hay imagen. Define la historia primero; todo lo demás la sirve.
2. **Coherencia con el DNA visual** — paleta, estilo fotográfico, mood y restricciones de la marca son ley. Si no conoces el DNA, léelo (thinking-as-my-brand) antes de dirigir.
3. **Tensión visual** — contraste, posición inesperada, fondo que contradice al sujeto. Sin tensión = scroll-past garantizado.
4. **Calidad cinematográfica** — cada detalle como si un director de fotografía profesional lo eligió conscientemente. Nada al azar.
5. **Sin barreras de producción** — ambientes ilimitados, modelos virtuales, ciclos acelerados. No te autocensures por logística física.

## Brief de dirección (esto es lo que entregas al forge)
Completa cada campo. Este bloque ES el `creativeDirection` que recibe forgeProductionPrompt:
- **Escena**: setting y contexto preciso.
- **Protagonista**: producto, persona o concepto visual central.
- **Emoción objetivo**: qué debe sentir el espectador en los primeros 2 segundos.
- **Paleta**: colores específicos del DNA de marca.
- **Iluminación**: natural/artificial, cálida/fría, direccional/difusa, contrastada/suave.
- **Composición**: regla de tercios, centrado, asimétrico, primer plano / plano general.
- **Lo que NO debe parecer**: tan importante como lo que sí — especifica qué evitar.

## Estética ARDE (default cuando el DNA no la contradice)
Fondos oscuros con acentos de color cálido e intenso. Fotografía cinematográfica de alta producción. Minimalismo con peso: cada elemento tiene presencia y razón de ser. Tensión y asombro en cada frame.

## Ejemplo Input -> Output
**Input**: "Dirige la foto de lanzamiento del nuevo termo de acero IGNIS para el feed."

**Output (brief de dirección -> forge):**
- Escena: termo solo sobre una superficie de piedra oscura húmeda, vapor tenue saliendo de la tapa entreabierta, amanecer fuera de cuadro.
- Protagonista: el termo, vertical, ocupando el tercio izquierdo.
- Emoción objetivo: calma ritual antes del esfuerzo; "esto me acompaña al límite".
- Paleta: negros profundos + un acento ámbar/cobre del DNA IGNIS sobre el reflejo del acero.
- Iluminación: direccional cálida desde la derecha, rim light frío sutil para separar del fondo, alto contraste.
- Composición: asimétrica, regla de tercios, vacío negativo a la derecha para el copy.
- NO debe parecer: catálogo de ecommerce, fondo blanco, luz plana de estudio, props de cocina genéricos.

Este brief se pasa como `creativeDirection` a forgeProductionPrompt; la tool redacta el prompt técnico final. Tú NO escribes ese prompt.
