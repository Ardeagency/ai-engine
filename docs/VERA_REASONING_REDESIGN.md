# Vera — Rediseño del cerebro: su superpoder de razonamiento

**Fecha:** 2026-07-24 · **Alcance:** `defaults/` (SOUL, IDENTITY, AGENTS + `skills/`)

De **27 skills mezcladas** (doctrina disfrazada de skill + manuales de reglas + tools) pasamos a **21 skills en una arquitectura de 3 capas**, donde Vera **razona con criterio** en lugar de seguir reglas. Este documento resume TODO lo que cambió y por qué.

---

## 1. El hallazgo que lo motivó

Las skills de OpenClaw son **model-invoked**: el runtime arma un catálogo (nombre + descripción) y el cuerpo del `SKILL.md` se carga on-demand cuando el LLM decide. **No se puede forzar la invocación.**

Consecuencia: una skill escrita como *doctrina pasiva* o *manual de pasos* ("haz esto, luego aquello") el LLM **la ignora** cuando no le ve utilidad → se producían "descartes" (pasos de calidad que se saltaban) y doctrina duplicada.

**La solución, en tres principios:**
1. Lo que debe aplicarse **siempre** → doctrina en SOUL/AGENTS (siempre en contexto), no en una skill opcional.
2. Las skills se describen **por momento de necesidad** (cuándo usarla), no como teoría.
3. Las skills se escriben como **preguntas que Vera se hace** — su razonamiento interno — no como reglamentos.

---

## 2. Las 3 capas del cerebro

| Capa | Qué es | Dónde vive |
|---|---|---|
| **Doctrina** | Cómo piensa y opera Vera (siempre-on) | `SOUL.md` (cómo piensa) · `AGENTS.md` (cómo opera) · `USER.md` (la marca a la que sirve = ancla el estándar de fidelidad, por-org) |
| **Tools de razonamiento** | Preguntas que la ayudan a pensar más allá de lo obvio | 10 skills |
| **Tools reales** | Capacidades atadas a herramienta / formato / dato | 11 skills |

La doctrina raíz que atraviesa todo: **a un humano no lo convierte lo que le vendo, sino cómo lo hago sentir cuando entiendo lo que necesita.** La venta es una consecuencia emocional, no una transacción de features.

---

## 3. Las 10 tools de razonamiento — el superpoder

No son manuales: son **baterías de preguntas** que Vera se hace, cada una fundada en investigación profesional real, y **interconectadas** (cada una sabe qué otras aprovechar, como opción, no como regla).

| Tool de razonamiento | Reemplazó a | Qué se pregunta | Fundamento profesional |
|---|---|---|---|
| **human-conversion-psychology** | audience-decoding | ¿Qué necesita SENTIR esta persona? ¿Qué motor la engancha? ¿Qué puente emocional debe cruzar la pieza? | Kahneman (Sistema 1/2), Berger (STEPPS), Cialdini |
| **reading-beneath-the-surface** | market-intuition | ¿Qué me dicen juntas estas señales sueltas? ¿Qué patrón se enciende, y tengo base real o me engaño? ¿Qué lo DESMENTIRÍA? | Klein (RPD), Heuer/ACH (falsear, no confirmar), Ansoff (señales débiles) |
| **self-critique-loop** | reflexion-loop | ¿Qué puede ser mejor? Me critico desde varias lentes (audiencia, escéptico, marca, rival, futuro) y reconstruyo lo débil | Self-Refine + Multi-Agent Reflexion |
| **learning-from-outcomes** | error-learning | ¿Por qué pasó (fracaso o acierto)? Mato la excusa, cavo la causa raíz, destilo la lección y la releo antes de repetir | Reflexion (verbal RL) + Voyager (destilar y superar) |
| **breaking-the-predictable** | surprise-creating | ¿Qué patrón espera la audiencia aquí, para romperlo? El asombro que rompe el patrón del contexto se recuerda y se comparte | Von Restorff / violación de expectativa, de Bono, SCAMPER |
| **deciding-the-piece** *(hub)* | content-manifesting | ¿Cuál es la ÚNICA idea? ¿Qué formato por su riqueza emocional? ¿Qué puedo reutilizar de la plataforma? | Single-Minded Proposition, Media Richness |
| **thinking-as-my-brand** *(hub)* | brand-dna-reading | ¿Qué haría MI marca aquí? Todo pasa por su identidad; absorbo referentes por simbiosis, no imitación; cuido la brecha entre lo que dice ser y lo que consigue | Brand stewardship, brecha identidad-imagen, arquetipo-filtro |
| **the-receptive-moment** | emotional-timing | ¿Es AHORA (un BOOM que montar hoy) o esperamos el clímax? Sea cual sea el objetivo, no solo publicar | Mood congruence, moment marketing, mindset > hora |
| **leading-the-market** | cmo-strategizing | ¿En qué lugar estoy (líder/retador/seguidor/nicher) y qué guerra dicta esa posición? La astucia va al mercado, nunca a la persona | Ries & Trout (Marketing Warfare), Kotler, Byron Sharp (Ehrenberg-Bass) |
| **reading-the-rivals-mind** | competitive-infiltration | ¿Cómo piensa el rival? ¿Cuál es su supuesto que NO coincide con la realidad (su punto ciego)? ¿Cuál es su próxima movida? | Porter (Cuatro Esquinas), War Gaming / Red Teaming |

**Doctrina de Maquiavelo, en su lugar exacto:** la astucia (león/zorro, la ocasión) se aplica al **mercado y al competidor** — nunca a la audiencia. A la persona se la gana con empatía y con una reputación construida sobre sustancia real, no fingida. Coca-Cola no engaña a quien la toma; compite con astucia contra Pepsi.

---

## 4. Lo que se eliminó

- **`cmo-strategizing`** — Vera es CMO por naturaleza; su lente estratégica vive en el SOUL, y el razonamiento de mercado quedó en `leading-the-market`.
- **6 rulebooks** que la competencia del LLM + la capa de razonamiento ya cubren: `copy-forging`, `content-atomizing`, `hook-matrix-generating`, `narrative-threading`, `campaign-architecting`, `trend-sensing`. Eran manuales de "haz esto y aquello"; Vera ahora escribe, atomiza, idea ángulos y juzga tendencias desde su razonamiento + su voz de marca.

---

## 5. Las tools reales (renombradas para que el nombre diga lo que hacen)

Al examinarlas apareció que no todas son iguales — se dividen en 3 tipos:

- **Tipo A — tool-usage genuino** (le enseñan a USAR una herramienta real): `live-social-metrics` (métricas de APIs conectadas), `brand-data-gateway` (catálogo inyectado + gate `APPROVE_ACTION`), `art-direction-brief` (alimenta la tool `forgeProductionPrompt`), `branded-file-design` (genera HTML/CSS + schema real).
- **Tipo B — conocimiento/experticia** (no hay tool; le da pericia que no puede derivar): `search-and-ai-discoverability` (SEO+GEO con evidencia: estudio Princeton, AI Share of Voice).
- **Tipo C — métodos aligerados** (Vera los ejecuta con razonamiento; se les quitó la regla rígida): `simulated-audience-pretest`, `voice-guide-builder`, `brand-coherence-audit`, `daily-intelligence-digest`.
- Más `competitor-post-analyzer` (una señal puntual del rival) y `brand-fidelity-check` (el piso de calidad).

**Renames aplicados:** social-analytics→`live-social-metrics`, data-protocol→`brand-data-gateway`, geo-optimizing→`search-and-ai-discoverability`, diseno-creacion-archivos→`branded-file-design`, visual-directing→`art-direction-brief`, crowd-simulating→`simulated-audience-pretest`, brand-voice-codifying→`voice-guide-builder`, brand-auditing→`brand-coherence-audit`, daily-briefing→`daily-intelligence-digest`.

---

## 6. Calidad y coherencia

- **Ortografía:** las 21 skills + SOUL/IDENTITY/AGENTS quedaron con tildes correctas (se abandonó una regla vieja errada de "nunca tildes" que había nacido de una limitación de teclado, no de una preferencia).
- **Grafo de invocación:** verificado sano — las referencias mutuas entre skills son disambiguadores o complementariedad opcional, no cadenas forzadas que hagan recursión.
- **Fidelidad de marca:** la línea repetida "aplica brand-fidelity-check" se quitó de las skills; el estándar vive en `USER.md` (por-marca) y en el SOUL/AGENTS. Su conversión en gate garantizado del runtime queda como deuda de código.

---

## 7. Lo que queda (runtime — próximo proyecto)

1. **Gate de fidelidad real** en el runtime (no una skill opcional).
2. **Heartbeat**: atar el disparo garantizado de `self-critique-loop` (antes de alto impacto) y `learning-from-outcomes` (tras cada resultado, releído antes de repetir).
3. **Progressive tool disclosure**: en vez de volcar ~140 tools/turno (~32KB) en el prompt, entregarle a Vera un índice de categorías y que pida las funciones on-demand — mismo patrón que las skills. Las skills ya declaran su categoría en "herramientas que puedo aprovechar".

---

*Vera dejó de ser un montón de skills que el LLM ignoraba y pasó a ser un cerebro de 3 capas que razona con libertad y criterio, apoyado en herramientas reales cuando las necesita.*
