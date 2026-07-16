---
name: competitor-post-analyzer
description: Forensic read of ONE specific competitor signal in real-time — a single post, reel, story, ad or landing/URL change just detected. Extracts intent, promotion type, threat level and the recommended response window for that one piece. Triggers when the scraper surfaces a new signal, or when the user says "analiza este post del competidor", "que publico [competidor]", "analiza esta URL", "el competidor lanzo X", "que significa esta señal". NOT aggregate metrics, engagement rates or competitive positioning over time (that is social-analytics). NOT judging whether a broad trend is worth riding (that is trend-sensing). This is one signal, dissected now.
---

# Competitor Post Analyzer — Lectura Forense de UNA Señal en Tiempo Real

Llega UNA señal de un perfil monitoreado (post, reel, story, ad, cambio de landing). Le haces una autopsia tactica inmediata que termina en una jugada. No es un reporte ni un promedio: es inteligencia de una sola pieza, leida ahora.

## Paso 0 — Lee el ROL del perfil primero

La señal NO siempre es una amenaza. Que hago con ella depende del **rol** del perfil (esta en su ficha de monitoreo, junto a su **relevancia**). Enruto antes de aplicar los cuadrantes:

- **Competidor (directo / indirecto)** → autopsia competitiva completa (los 4 cuadrantes de abajo): que buscan, cuanto amenaza, que jugada nos deja para **superarlo**.
- **Referente** → NO es amenaza, es una **leccion**. Leo la pieza segun su **relevancia** (el foco por el que lo seguimos): que hizo bien en comunicacion / imagen visual / tono / temas / CTA / conversion / interaccion, y **como lo adapto** a la marca. El Cuadrante 3 (amenaza) NO aplica — lo reemplazo por "que copio/adapto". El rango modula: internacional = playbook general; nacional = tactica cultural/local.
- **Aliado** → **oportunidad de colaboracion**: que activacion, co-marketing o amplificacion de audiencia compartida abre esta pieza.

Los cuadrantes 1-2 (formato, deteccion de promocion) se leen igual para cualquier rol; el 3 y la accion cambian segun lo anterior.

## Los 4 Cuadrantes

### Cuadrante 1 — FORMATO y ESTRUCTURA
¿Que tipo de pieza es y que revela su forma?
- **Story / Reel / Post**: formato de alta visibilidad -> urgencia organica
- **Carrusel educativo**: posicionamiento de autoridad -> ciclo de venta largo
- **Video con CTA directa**: conversion inmediata -> estan en modo push
- **Cambio de landing / web**: movida estrategica silenciosa -> alta relevancia

### Cuadrante 2 — DETECCION DE PROMOCION
Señales de que estan vendiendo activo:
- Palabras: descuento, oferta, promo, sale, % off, gratis, incluido, combo, edicion limitada
- Urgencia: solo hoy, ultimas horas, quedan X unidades, cierra mañana
- CTA de conversion: compra ahora, consigue, unete, registrate, reserva
- Precio visible: cualquier numero con $ o % es comercializacion activa

**Si hay promocion -> escala de urgencia**:
- BAJA: oferta generica sin urgencia temporal
- MEDIA: descuento + temporada definida
- ALTA: urgencia real + descuento fuerte + CTA directa

### Cuadrante 3 — NIVEL DE AMENAZA PARA LA MARCA
¿Cuanto compite esta pieza con nuestra propuesta de valor?

| Factor | +Amenaza |
|---|---|
| Mismo publico objetivo | Alto |
| Mismo beneficio principal | Alto |
| Mismo canal (Instagram/TikTok) | Medio |
| Mismo rango de precio | Medio |
| Misma ventana temporal | Alto |

Clasificacion: **BAJO / MEDIO / ALTO / CRITICO**

### Cuadrante 4 — VENTANA DE OPORTUNIDAD Y RESPUESTA
¿Que hacemos nosotros?
- **NADA**: no aplica o ya paso la ventana
- **MONITOREAR**: guardar para patron futuro
- **RESPUESTA INDIRECTA**: publicar pieza relacionada que posicione sin mencionar al competidor
- **RESPUESTA DIRECTA**: ofrecer nuestra alternativa en las proximas 24-48h

## Reglas de Analisis

1. **No nombres al perfil** en la respuesta al usuario cuando es competidor — usa "un competidor del sector". Referente/aliado si puedo nombrarlos (no hay razon competitiva para ocultarlos).
2. **No juzgues eticamente** el contenido — solo leelo estrategicamente.
3. **Siempre termina en accion**: el analisis sin jugada es solo ruido (superar al competidor / adaptar la leccion del referente / activar la colaboracion del aliado).
4. Antes de entregar, aplica brand-fidelity-check.

## Output Estandar al Usuario

```
Nueva señal detectada — [red social] de [perfil segun rol]

Contenido: {tipo y descripcion en 1 linea}
¿Promocion?: {SI/NO} — {si si: tipo y nivel de urgencia}
Lectura ({competidor|referente|aliado}): {competidor -> amenaza BAJO/MEDIO/ALTO/CRITICO · referente -> que se aprende/adapta segun su relevancia · aliado -> que colaboracion abre}
Ventana: {tiempo estimado de relevancia}
Accion recomendada: {la jugada}
```

## Ejemplo Trabajado

**Señal cruda del scraper**: Instagram Reel, 18 seg, texto en pantalla "ENVIO GRATIS solo este finde + 30% OFF en toda la tienda", CTA "compra desde el link". Mismo nicho que nosotros, mismo rango de precio, fin de semana.

```
Nueva señal detectada — Instagram de un competidor del sector

Contenido: Reel de 15-18s en modo push, anuncia 30% OFF + envio gratis fin de semana
¿Promocion?: SI — descuento fuerte + urgencia temporal + CTA directa = urgencia ALTA
Amenaza: ALTO — mismo publico, mismo rango de precio, misma ventana (este finde)
Ventana: 48-72h, vence el domingo
Accion recomendada: respuesta directa — activar nuestra contraoferta o reforzar diferencial de valor antes del sabado AM, sin entrar a guerra de precio
```

## Memoria

Documenta el patron en `memory/competitor-patterns.md` al finalizar.
Si la promocion es ALTA o CRITICA, añade tambien a `memory/alerts-active.md`.
