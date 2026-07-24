---
name: competitor-post-analyzer
description: Forensic read of ONE specific competitor signal in real-time — a single post, reel, story, ad or landing/URL change just detected. Extracts intent, promotion type, threat level and the recommended response window for that one piece. Triggers when the scraper surfaces a new signal, or when the user says "analiza este post del competidor", "que publico [competidor]", "analiza esta URL", "el competidor lanzo X", "que significa esta señal". NOT aggregate metrics, engagement rates or competitive positioning over time (that is live-social-metrics). NOT judging whether a broad trend is worth riding (that is reading-beneath-the-surface). This is one signal, dissected now.
---

# Competitor Post Analyzer — Lectura Forense de UNA Señal en Tiempo Real

Llega UNA señal de un perfil monitoreado (post, reel, story, ad, cambio de landing). Le haces una autopsia táctica inmediata que termina en una jugada. No es un reporte ni un promedio: es inteligencia de una sola pieza, leída ahora.

## Paso 0 — Lee el ROL del perfil primero

La señal NO siempre es una amenaza. Qué hago con ella depende del **rol** del perfil (está en su ficha de monitoreo, junto a su **relevancia**). Enruto antes de aplicar los cuadrantes:

- **Competidor (directo / indirecto)** → autopsia competitiva completa (los 4 cuadrantes de abajo): qué buscan, cuánto amenaza, qué jugada nos deja para **superarlo**.
- **Referente** → NO es amenaza, es una **lección**. Leo la pieza según su **relevancia** (el foco por el que lo seguimos): qué hizo bien en comunicación / imagen visual / tono / temas / CTA / conversión / interacción, y **cómo lo adapto** a la marca. El Cuadrante 3 (amenaza) NO aplica — lo reemplazo por "qué copio/adapto". El rango modula: internacional = playbook general; nacional = táctica cultural/local.
- **Aliado** → **oportunidad de colaboración**: qué activación, co-marketing o amplificación de audiencia compartida abre esta pieza.

Los cuadrantes 1-2 (formato, detección de promoción) se leen igual para cualquier rol; el 3 y la acción cambian según lo anterior.

## Los 4 Cuadrantes

### Cuadrante 1 — FORMATO y ESTRUCTURA
¿Qué tipo de pieza es y qué revela su forma?
- **Story / Reel / Post**: formato de alta visibilidad -> urgencia orgánica
- **Carrusel educativo**: posicionamiento de autoridad -> ciclo de venta largo
- **Video con CTA directa**: conversión inmediata -> están en modo push
- **Cambio de landing / web**: movida estratégica silenciosa -> alta relevancia

### Cuadrante 2 — DETECCIÓN DE PROMOCIÓN
Señales de que están vendiendo activo:
- Palabras: descuento, oferta, promo, sale, % off, gratis, incluido, combo, edición limitada
- Urgencia: solo hoy, últimas horas, quedan X unidades, cierra mañana
- CTA de conversión: compra ahora, consigue, únete, regístrate, reserva
- Precio visible: cualquier número con $ o % es comercialización activa

**Si hay promoción -> escala de urgencia**:
- BAJA: oferta genérica sin urgencia temporal
- MEDIA: descuento + temporada definida
- ALTA: urgencia real + descuento fuerte + CTA directa

### Cuadrante 3 — NIVEL DE AMENAZA PARA LA MARCA
¿Cuánto compite esta pieza con nuestra propuesta de valor?

| Factor | +Amenaza |
|---|---|
| Mismo público objetivo | Alto |
| Mismo beneficio principal | Alto |
| Mismo canal (Instagram/TikTok) | Medio |
| Mismo rango de precio | Medio |
| Misma ventana temporal | Alto |

Clasificación: **BAJO / MEDIO / ALTO / CRÍTICO**

### Cuadrante 4 — VENTANA DE OPORTUNIDAD Y RESPUESTA
¿Qué hacemos nosotros?
- **NADA**: no aplica o ya pasó la ventana
- **MONITOREAR**: guardar para patrón futuro
- **RESPUESTA INDIRECTA**: publicar pieza relacionada que posicione sin mencionar al competidor
- **RESPUESTA DIRECTA**: ofrecer nuestra alternativa en las próximas 24-48h

## Reglas de Análisis

1. **No nombres al perfil** en la respuesta al usuario cuando es competidor — usa "un competidor del sector". Referente/aliado sí puedo nombrarlos (no hay razón competitiva para ocultarlos).
2. **No juzgues éticamente** el contenido — solo léelo estratégicamente.
3. **Siempre termina en acción**: el análisis sin jugada es solo ruido (superar al competidor / adaptar la lección del referente / activar la colaboración del aliado).

## Output Estándar al Usuario

```
Nueva señal detectada — [red social] de [perfil según rol]

Contenido: {tipo y descripción en 1 línea}
¿Promoción?: {SÍ/NO} — {si sí: tipo y nivel de urgencia}
Lectura ({competidor|referente|aliado}): {competidor -> amenaza BAJO/MEDIO/ALTO/CRÍTICO · referente -> qué se aprende/adapta según su relevancia · aliado -> qué colaboración abre}
Ventana: {tiempo estimado de relevancia}
Acción recomendada: {la jugada}
```

## Ejemplo Trabajado

**Señal cruda del scraper**: Instagram Reel, 18 seg, texto en pantalla "ENVÍO GRATIS solo este finde + 30% OFF en toda la tienda", CTA "compra desde el link". Mismo nicho que nosotros, mismo rango de precio, fin de semana.

```
Nueva señal detectada — Instagram de un competidor del sector

Contenido: Reel de 15-18s en modo push, anuncia 30% OFF + envío gratis fin de semana
¿Promoción?: SÍ — descuento fuerte + urgencia temporal + CTA directa = urgencia ALTA
Amenaza: ALTO — mismo público, mismo rango de precio, misma ventana (este finde)
Ventana: 48-72h, vence el domingo
Acción recomendada: respuesta directa — activar nuestra contraoferta o reforzar diferencial de valor antes del sábado AM, sin entrar a guerra de precio
```

## Memoria

Documenta el patrón en `memory/competitor-patterns.md` al finalizar.
Si la promoción es ALTA o CRÍTICA, añade también a `memory/alerts-active.md`.
