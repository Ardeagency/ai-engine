---
name: competitor-post-analyzer
description: Analyzes a specific competitor post or URL change in real-time when detected by the scraper. Extracts intent, promotion type, threat level and recommended response. Triggers automatically when a new signal is received, or when the user says "analyzes this post", "what did [competitor] publish", "analyze this URL", "the competitor published X".
---

# Competitor Post Analyzer — Lectura Forense de Señales en Tiempo Real

Cuando llega una señal nueva de un competidor (post, cambio de URL, promoción), aplicás un análisis forense inmediato. No es un reporte. Es una lectura de inteligencia táctica.

## El Análisis de los 4 Cuadrantes

### Cuadrante 1 — FORMATO y ESTRUCTURA
¿Qué tipo de contenido es?
- **Story/Reel/Post**: formatos de alta visibilidad → urgencia orgánica
- **Carrusel educativo**: posicionamiento de autoridad → ciclo de venta largo
- **Video con CTA directa**: conversión inmediata → están en modo push
- **Cambio de landing/web**: cambio estratégico silencioso → alta relevancia

### Cuadrante 2 — DETECCIÓN DE PROMOCIÓN
Busca estas señales de promoción:
- Palabras: descuento, oferta, promo, sale, % off, gratis, incluido, combo, edición limitada
- Urgencia: solo hoy, últimas horas, quedan X unidades, cierra mañana
- CTA de conversión: compra ahora, consigue, únete, regístrate, reserva
- Precio visible: cualquier número con $ o % es una señal de comercialización activa

**Si hay promoción → escala de urgencia**:
- 🟡 BAJA: oferta genérica sin urgencia temporal
- 🟠 MEDIA: descuento + temporada definida
- 🔴 ALTA: urgencia real + descuento significativo + CTA directa

### Cuadrante 3 — NIVEL DE AMENAZA PARA LA MARCA
¿Cuánto compite este contenido directamente con nuestra propuesta de valor?

| Factor | +Amenaza |
|---|---|
| Mismo público objetivo | Alto |
| Mismo beneficio principal | Alto |
| Mismo canal (Instagram/TikTok) | Medio |
| Mismo rango de precio | Medio |
| Misma ventana temporal | Alto |

Clasificación: **BAJO / MEDIO / ALTO / CRÍTICO**

### Cuadrante 4 — VENTANA DE OPORTUNIDAD Y RESPUESTA
¿Qué podemos hacer nosotros?
- **NADA**: el contenido no aplica o ya pasó la ventana
- **MONITOREAR**: guardar para patrón futuro
- **RESPUESTA INDIRECTA**: publicar contenido relacionado que posicione sin mencionar al competidor
- **RESPUESTA DIRECTA**: ofrecer nuestra alternativa en las próximas 24-48h

## Reglas de Análisis

1. **No menciones al competidor por nombre** en la respuesta al usuario — usa "un competidor del sector"
2. **No juzgues éticamente** el contenido del competidor — solo analizá estratégicamente
3. **Sé específico**: "post de carrusel con 3 slides sobre beneficio X" es mejor que "publicaron contenido"
4. **Siempre termina con acción**: el análisis sin acción es solo ruido

## Output Estándar al Usuario

```
📡 **Nueva señal detectada** — [red social] de [competidor o "un competidor"]

**Contenido**: {tipo y descripción en 1 línea}
**¿Promoción?**: {SÍ/NO} — {si sí: tipo y nivel de urgencia}
**Amenaza**: {BAJO/MEDIO/ALTO/CRÍTICO}
**Ventana**: {tiempo estimado de relevancia}
**Acción recomendada**: {qué debería hacer la marca}
```

## Memoria

Documentá el patrón en `memory/competitor-patterns.md` al finalizar.
Si es una promoción ALTA o CRÍTICA, añadí también a `memory/alerts-active.md`.
