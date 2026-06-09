---
name: competitive-infiltration
description: Performs deep STRATEGIC analysis of a competitor — how they think, what move comes next, which weaknesses are exploitable — to differentiate and stay ahead. Use when the user wants competitive strategy, a rival profile, or to anticipate the competition. Triggers on "analisis de competencia", "como nos diferenciamos", "estrategia del rival", "anticipar al competidor", "que va a hacer la competencia". NOT for dissecting a single competitor post (use competitor-post-analyzer). NOT for a rival's ad metrics or numbers from APIs (use social-analytics). This builds the competitor's mental map; it does not score one piece or pull stats.
---

# Competitive Infiltration — Inteligencia Profunda de Competencia

No estas haciendo un reporte de lo que la competencia publica. Estas construyendo un mapa mental de COMO piensa el competidor, para anticipar lo que va a hacer y donde es vulnerable.

Por que importa: ver QUE publican es trivial; cualquiera lo hace. La ventaja nace de inferir el POR QUE detras de cada movida y proyectar la siguiente. Eso permite diferenciarte antes de que ellos reaccionen.

## Los 3 niveles de analisis (recorrelos siempre en orden)

### Nivel 1 — Lo Visible (lo que cualquiera ve)
Que publican, frecuencia, formatos, productos destacados, promociones, tono, estetica, numeros publicos. Es solo la materia prima; no te quedes aqui.

### Nivel 2 — Lo Interpretable (lo que requiere pensar)
- Por que cambiaron su frecuencia o su mix de formatos?
- Por que dejaron de destacar ese producto? Por que bajo su engagement?
- Que estan copiando, y de quien? A que estan reaccionando?
Cada cambio observable esconde una decision. Nombra la decision.

### Nivel 3 — Lo Invisible (lo que requiere intuicion)
- Que NO estan haciendo que deberian? Esos vacios son tu oportunidad.
- Que prometen pero no cumplen? Ahi vive la insatisfaccion explotable.
- Cual es su creencia limitante que los ciega?
- Estan creciendo de forma sostenible o hinchando numeros?
Este nivel es el que produce ventaja real. Si tu analisis se queda en Nivel 1, no sirvio.

## Reglas
1. Nunca imites. Entender al competidor es para DIFERENCIARTE, no para clonarlo.
2. Capitaliza sus errores con elegancia — sin mencionarlos jamas de forma directa.
3. Documenta patrones recurrentes en `reference/competitor-patterns.md` y actualiza el mapa con cada ciclo.
4. Toda afirmacion sobre el rival es una hipotesis hasta tener evidencia; marca lo que es inferencia.

## Formato de reporte
Una fila por movimiento detectado:

**COMPETIDOR** | **MOVIMIENTO** | **INTERPRETACION** | **AMENAZA** | **OPORTUNIDAD** | **ACCION SUGERIDA** | **URGENCIA**

## Ejemplo

Input: "Analiza a nuestro rival principal en cafe de especialidad. Lleva 3 semanas raro."

Output:
- N1 (visible): bajaron de 5 a 2 posts/semana; quitaron el origen Etiopia del feed; metieron 3 promos de descuento seguidas.
- N2 (interpretable): el corte de frecuencia + promos sugiere presion de inventario o de caja, no estrategia de marca. Dejaron Etiopia = problema de abasto, no de demanda.
- N3 (invisible): NO estan comunicando trazabilidad ni historia de productor — su creencia ciega es "el cliente solo quiere precio". Ahi esta el hueco.

Reporte:
| Rival | Promos en cadena + frecuencia a la baja | Estres de inventario/caja, no plan | Pueden robar clientes con precio corto plazo | Vacio total en narrativa de origen y productor | Lanzar serie de trazabilidad con el productor real; cero descuento, todo valor | Alta |

Veredicto: no pelees su guerra de precio. Ocupa el territorio de origen que ellos abandonaron mientras estan distraidos apagando incendios.

## Cierre
Antes de entregar, aplica brand-fidelity-check.
