# Vera Mission Loop v2 — Plan de rebuild

> Estado: PROPUESTA (documentar antes de tocar codigo). Generado 2026-06-03.
> Contexto demo: el panel "Actividad" (Tareas / Misiones) mostraba ~80 misiones
> "Analisis de competencia" de abril, ruido de un diseno 1-mision-por-post hoy
> ademas cortado. Objetivo: convertir el panel en una ventana real al trabajo
> autonomo de Vera (que hace ahora / que le falta / que hizo), sin ruido.

---

## 1. Concepto correcto, implementacion mala

Las misiones SI son el mecanismo correcto: una senal/amenaza detectada por los
scrapers se convierte en una mision que se entrega automaticamente a Vera, ella
la resuelve (analiza, recomienda, actua) y el panel le muestra al usuario el
progreso. El problema era el diseno, no la idea.

### Tablas
- `body_missions`        → cola de trabajo autonomo de Vera (pestana **Misiones**)
- `vera_pending_actions` → acciones que Vera propone y esperan decision (pestana **Tareas**)
- `agent_queue_jobs`     → cola que consume el `job-worker`
- `mission_runs`         → log de intentos de ejecucion
- `intelligence_signals` / `brand_vulnerabilities` → senales y amenazas (input)

### Ciclo de vida intencionado (el que hay que restaurar/mejorar)
```
scraper → intelligence_signals (+ brand_vulnerabilities via threat-detector, idempotente)
   → [SINTETIZADOR] agrupa senales nuevas y crea body_mission (pending)
       + agent_queue_job (payload.mission_id) + mission_run
   → job-worker toma el job → marca mission in_progress
       → POST http://org-server/agent/run  (Vera/OpenClaw, skill competitor-post-analyzer)
   → Vera analiza/recomienda → job completed
       → body_mission completed  (o needs_review si propone accion → vera_pending_actions)
       → notifyUser resumido
```

---

## 2. Defectos del diseno viejo (lo que NO repetir)

1. **1 mision por post** → 26 posts/dia = 26 misiones identicas (firehose).
2. **Titulos genericos** ("Analisis de competencia") → indistinguibles.
3. **Sin estado en-curso** → `body_missions` solo pending→completed/failed; el
   panel no puede mostrar "que hace Vera AHORA".
4. **Misiones colgadas** → org-server 500 dejaba pending/failed eternos (BUG-001).
5. **Pipeline cortado** (migracion Apify 2026-04-28) → `enqueueSignalAnalysis`
   en `signal-webhook.controller.js` solo crea `brand_vulnerabilities`; ya no
   crea misiones ni jobs. (El codigo muerto que referenciaba `mission`/`job`/
   `priority` se limpio el 2026-06-03 como parche interino; este rebuild lo
   reemplaza con la logica correcta.)

---

## 3. Diseno v2

### Principio
**Una mision significativa por clave natural (entidad, dia) o por cluster de
amenaza — nunca por post.** Agregar, deduplicar, throttle.

### 3.1 Nuevo servicio: `mission-synthesizer.service.js` (ai-engine, SIN LLM)
- Corre al cierre de cada ciclo de scraping (o cron cada N horas).
- Lee `intelligence_signals` nuevas (no procesadas) + `brand_vulnerabilities`
  abiertas por brand_container.
- Agrupa por `(entity_id, signal_type, dia)` y por cluster de amenaza.
- Crea **UNA** `body_mission` por grupo con:
  - `mission_type`: `competitor_digest` | `threat_response` | etc.
  - titulo descriptivo: ej. `"Red Bull — 8 posts nuevos (1 viral 4.2x)"`.
  - `action_payload.cluster_key` = clave natural para dedup.
  - `status = 'pending'`.
- **Dedup**: skip si ya existe body_mission abierta con el mismo
  `action_payload.cluster_key` (mismo patron `_key` que ya usa `threat-detector`).
- Encola **UN** `agent_queue_job` (`job_type=analysis`, `payload.mission_id`)
  + crea `mission_run` (status `queued`).

### 3.2 Estado "en curso" real
- En `job-worker.processJob`, al tomar el job (tras `tryLockJob`): si
  `payload.mission_id`, marcar `body_missions.status = 'in_progress'` +
  `mission_runs.status='running'`, `started_at`.
- Asi el panel muestra "Vera esta analizando la competencia… ⏳".

### 3.3 Maquina de estados de `body_missions`
```
pending  → in_progress → completed
                       → needs_review  (Vera propone accion → vera_pending_actions)
                       → failed        (tras max_attempts)
```
- `pending`      = le falta hacer (cola visible al usuario)
- `in_progress`  = haciendo ahora
- `completed`    = hecho
- `needs_review` = hecho pero requiere decision del usuario (aparece en Tareas)
- `failed`       = fallo definitivo (auto-limpieza)

> Nota DB: hoy solo existe el valor `completed` en datos. Verificar si hay CHECK
> constraint en `body_missions.status`; si lo hay, ampliarlo a los 5 valores.

### 3.4 Auto-limpieza de colgadas
- Extender el cron existente `cleanup_empty_flow_runs` (pg_cron) o crear
  `cleanup_stale_missions`: cerrar `body_missions` en `pending`/`in_progress`
  con `updated_at` > N horas → marcar `failed` con razon `stale_timeout`, y
  liberar su `agent_queue_job`. Evita reacumulacion de basura.

### 3.5 Notificacion resumida
- Una notificacion por ciclo, no por post:
  `"Vera reviso la competencia hoy: 3 hallazgos, 1 accion propuesta"`.
- `org_notifications` para resumenes de org; `user_notifications` para el owner.
- Mantener email solo en severity high/critical (ya implementado en
  `_notifyOwnerOfJobCompletion`).

---

## 4. Archivos a tocar

### Backend (ai-engine, /root/ai-engine/src)
- `services/mission-synthesizer.service.js`  — NUEVO (sintetizador batched)
- `services/job-worker.service.js`           — marcar in_progress al lockear; manejar needs_review
- `controllers/signal-webhook.controller.js` — opcional: dejar solo deteccion (el synth crea misiones); ya parcheado
- `index.js` / scheduler                     — registrar el synth en el ciclo de scraping
- (cron SQL) `cleanup_stale_missions`        — auto-limpieza

### DB (Supabase tsdpbqcwjckbfsdqacam, via Management API)
- Ampliar/crear CHECK en `body_missions.status` (5 estados)
- Indice por `action_payload->>'cluster_key'` para dedup eficiente
- (opcional) columna `title` en `body_missions` si hoy el titulo se deriva del frontend

### Frontend (repo console.aismartcontent.io, NO local — vive en Netlify)
- Panel "Actividad": render por estado (pending/in_progress/completed/needs_review)
- Pestana **Misiones** = `body_missions`; **Tareas** = `vera_pending_actions`
- Indicador "Vera esta haciendo X ahora" para `in_progress`
- Empty states limpios

---

## 5. Rollout y pruebas
1. Aplicar migracion DB (estados + indice) — reversible.
2. Desplegar synth + cambios job-worker en ai-engine; `node --check` + restart
   `ai-engine.service` (fuera de horario demo).
3. E2E sobre IGNIS (org a1000000-…0001): forzar un ciclo, verificar que N senales
   generan 1 mision por cluster (no N), que pasa pending→in_progress→completed,
   y que el panel refleja los 3 estados.
4. Verificar dedup (segundo ciclo no duplica) y auto-limpieza (mision stale).
5. Validar notificacion resumida (1, no N).

## 6. Riesgos
- Tocar `body_missions.status` puede romper queries del frontend que asumen
  solo completed → coordinar con cambios de panel.
- El org-server (Vera) es SPOF multi-tenant; un fallo deja misiones en
  in_progress → la auto-limpieza lo cubre.
- Hacerlo en ventana autonoma 11pm–3am Bogota, pre-aprobado por tarea.

## 7. Referencias de memoria
- BUG-001 / firehose: `project_competitor_mission_firehose.md`
- Topologia ai-engine: `project_kie_consumer_topology.md`
- Vera decision core: `project_vera_decision_core.md`
- Cron cleanup existente: `project_cleanup_empty_flow_runs.md`
- No LLM en background: `feedback_no_llm_in_background.md` (el synth NO usa LLM)
