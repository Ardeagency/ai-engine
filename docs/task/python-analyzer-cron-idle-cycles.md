# 🟢 `python-analyzer-cron` y `patterns-cron` corren en vacío

**Detectado:** 2026-05-11
**Severidad:** baja — overhead despreciable

## Síntoma

Dos timers corren con frecuencia alta pero procesan 0 trabajo:

| Timer | Cadencia | Último output |
|---|---|---|
| `python-analyzer-cron.timer` | cada 5 min | `{"processed":0,"message":"no pending posts"}` |
| `python-analyzer-patterns-cron.timer` | cada 10 min | `{"processed":0,"message":"no pending patterns"}` |

Causa: los triggers `social:*` (Apify) están `paused` y no entran `brand_posts` nuevos. Sin posts pendientes, los procesadores no tienen trabajo.

## Fix propuesto (opcional)

- **(a)** Subir cadencia a 30 min mientras Apify esté pausado → ahorro ~250 ejecuciones/día sin trabajo.
- **(b)** Auto-skip: el endpoint ya devuelve early si no hay pending — el costo real ya es mínimo (~50ms por curl). Posiblemente no vale tocar.

## Estado

⏸️ Decisión: probablemente DEJAR (overhead despreciable). Documentar como visible no significa actuar.
