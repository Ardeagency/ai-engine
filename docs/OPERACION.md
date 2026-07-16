# ai-engine — Modo operativo de produccion

> Este documento registra EN GIT las decisiones de configuracion que hoy solo
> viven en `.env` (gitignored). El `.env` guarda secretos; aqui se documenta el
> MODO en que corre prod, para que se pueda reconstruir sin abrir el server.
> Ultima revision: 2026-07-16.

## Experimento "data cruda" (activo desde 2026-07-15)

Decision: ai-engine deja de ANALIZAR post-scraping. Los scrapers y sensores
siguen ON y escriben data cruda a Supabase; el chat de Vera sigue vivo. Toda la
capa de analisis/recomendacion/medicion queda apagada por flags.

| Flag | Valor prod | Efecto |
|------|-----------|--------|
| `POST_SCRAPE_ANALYSIS_ENABLED` | `false` | Apaga content-analysis, mission-generator, strategy-review, threat-detector, audience-alignment |
| `JOB_WORKER_ENABLED` | `false` | Apaga el worker de jobs de fondo |
| `RECOMMENDATION_AUTO_LINK_ENABLED` | `false` | No enlaza recomendaciones automaticamente |
| `RECOMMENDATION_PRODUCER_ENABLED` | `false` | No produce recomendaciones |
| `OUTCOME_MEASUREMENT_ENABLED` | `false` | No mide outcomes de jugadas |
| `VERA_BRAIN_FEED_ENABLED` | `false` | Elimina el ciclo de accion (cycle-pulse). Solo quedan sesiones read-only de dashboard + chat |
| `VISIBILITY_SENSOR_ENABLED` | `false` | Apaga el sensor de visibilidad SEO/GEO |

Revertir: poner el flag en `true` (o borrarlo) y `systemctl restart ai-engine.service`.

## Rollouts graduales

| Flag | Valor prod | Efecto |
|------|-----------|--------|
| `CHAT_PULL_VIA_TOOLS_ORGS` | orgs demo (IGNIS + una piloto) | Esas orgs NO reciben el catalogo inyectado en el chat; Vera lo LEE con sus tools (getProducts, getAudiences, etc.). Ahorra contexto. `*` = todas. |

## Sesion dashboard de Vera (shadow mode)

La feature `vera-dashboard-session.service.js` corre en SHADOW: escribe en
`vera_dashboard_readings` pero el frontend sigue leyendo `brand_cmo_brief` hasta
el switch por org. No hay flag global de corte todavia; se dispara por endpoint
interno `/internal/vera-dashboard/run`.

## Disciplina de trabajo (acordada 2026-07-16)

Se edita en el server (el mirror local es solo lectura), PERO **toda sesion
termina con `git add <archivos> && git commit && git push`**. Git es el backup:
se acaban los archivos `.bak-*` regados. Antes de tocar, snapshot en
`/root/ai-engine-snapshots/`.
