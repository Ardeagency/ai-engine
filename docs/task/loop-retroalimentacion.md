# Deuda técnica — Loop de retroalimentación post-ejecución

**Estado**: Pendiente de implementación
**Detectado**: 2026-05-08 durante auditoría de niveles de autonomía + canal Vera↔ai-engine
**Severidad**: 🔴 Alto — sin esto Vera puede ejecutar pero no aprender

## Problema

Hoy el ciclo es **abierto**:

```
Vera lee datos → analiza → propone (proposeAction) → usuario aprueba → executor ejecuta → ✅ OK / ❌ FAIL → fin
```

Lo que ai-engine sabe al final es solo si la **ejecución técnica** funcionó (`vera_pending_actions.execution_result`, `executed_at`, `error_message`). No sabe si la acción **funcionó como decisión estratégica**: ¿el post propuesto generó engagement? ¿la audiencia ajustada convirtió mejor? ¿el schedule programado dio outputs útiles?

Sin esto Vera no puede:
- Calibrar `vera_confidence` con datos reales (hoy es heurístico)
- Aprender qué tipos de acciones funcionan para esta marca específica
- Sugerir replicar lo que sí funcionó ni evitar lo que no
- Reportar al usuario "de las últimas 5 cosas que aprobaste, 3 dieron resultados — aquí está el delta"

## Diseño propuesto (v1)

### Schema

Opción A (preferida): nueva tabla `vera_action_outcomes`

```sql
CREATE TABLE vera_action_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_action_id   uuid NOT NULL REFERENCES vera_pending_actions(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL,
  brand_container_id  uuid,
  action_type         text NOT NULL,

  -- Snapshots temporales de métricas
  measured_at         timestamptz NOT NULL DEFAULT now(),
  measurement_window  text NOT NULL,  -- "24h" | "7d" | "30d"
  baseline_metrics    jsonb,          -- métricas previas a la ejecución
  outcome_metrics     jsonb,          -- métricas posteriores
  delta               jsonb,          -- delta calculado por métrica

  -- Veredicto computado
  outcome_verdict     text,           -- "positive" | "neutral" | "negative" | "inconclusive"
  outcome_score       numeric(4,3),   -- -1.0 a 1.0 — qué tan bien le fue
  reasoning           text,           -- explicación humana del veredicto

  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pending_action_id, measurement_window)
);

CREATE INDEX idx_vao_org ON vera_action_outcomes(organization_id, measured_at DESC);
CREATE INDEX idx_vao_pa  ON vera_action_outcomes(pending_action_id);
```

Razón de tabla nueva (no columna en `vera_pending_actions`): permite **múltiples ventanas de medición** por acción (24h + 7d + 30d) sin perder historial, y separa el ciclo de medición del de ejecución.

### Métricas por `action_type`

| action_type | Fuente | Métricas baseline + outcome |
|---|---|---|
| `publish_instagram_post` / `publish_facebook_post` | Meta Graph API (`getMetaPosts`/`getInstagramPosts`) | `reach`, `impressions`, `engagement_rate`, `saves`, `shares`, `comments`. Baseline = mediana últimos 10 posts antes de la ejecución |
| `schedule_instagram_post` / `schedule_facebook_post` | Idem, una vez ejecutado el schedule | Igual al anterior |
| `update_brand_container` / `update_brand_*` | Sin medición externa directa | Solo persistimos `outcome_metrics: null` y marcamos `outcome_verdict: "inconclusive"` (acción de configuración, no medible vía métricas externas) |
| `create_audience` / `update_audience` | Cross-ref con campañas posteriores que la usen | Si una campaña apunta a la audiencia tras la ejecución → conversion rate de esa campaña vs baseline |
| `create_campaign` / `launch_campaign` | Flow runs asociados + Meta/GA | engagement de assets generados + tráfico web atribuible |
| `create_schedule` | Outputs de los runs ejecutados desde ese schedule | tasa de completion + engagement promedio |
| `add_intelligence_entity` / `add_url_watcher` | Sin métricas de impacto — ajustes internos | `inconclusive` |

### Job de medición

Servicio nuevo `outcome-measurement.service.js`:

- **Cron**: cada 1 hora (poll inicialmente, mover a scheduled si genera ruido)
- **Lógica**: SELECT `vera_pending_actions` con `status='executed'` y faltan ventanas `24h`/`7d`/`30d` que ya cumplieron tiempo desde `executed_at`
- **Por cada acción candidata**:
  1. Determinar baseline (snapshot de métricas pre-ejecución, derivado de `current_state` + queries históricas)
  2. Capturar métricas actuales según el mapa por `action_type`
  3. Calcular delta y `outcome_score` (formula por tipo)
  4. INSERT en `vera_action_outcomes`
  5. Si `outcome_score < -0.3` (acción mal): logear como signal para que Vera lo vea en el próximo briefing

**Importante**: el job usa **reglas + math** para clasificar el outcome — NO LLM (consistente con la regla del usuario "no LLM en background jobs").

### Tools nuevas para Vera (Phase B+)

| Tool | Parámetros | Devuelve |
|---|---|---|
| `getActionOutcomes` | `status?` (`positive`/`negative`/`all`), `since?` (ISO date), `limit?` | Lista de outcomes con verdict + delta + reasoning |
| `getActionOutcomeDetail` | `pending_action_id` | Todas las ventanas de medición de una acción específica |
| `getOutcomeSummary` | `window?` (`7d`/`30d`/`90d`) | Agregado: % positive vs negative por action_type, calibración de confidence |

### Integración con score de oportunidad

Cuando `getStrategyOpportunityScore` esté en v2, agregar columna opcional `historical_success_rate` derivada de `vera_action_outcomes`: para topics donde la marca ya ejecutó acciones, mostrar qué tan bien le fue. Esto cierra el loop completo: Vera propone → usuario aprueba → ejecuta → mide → ajusta confidence en próxima propuesta.

## Riesgos / decisiones abiertas

1. **Privacidad de métricas**: si el usuario revoca permisos de Meta/GA después de ejecutar, ¿borramos los outcomes históricos? Propuesta: NO — son datos derivados de la org, persisten. Solo congelamos nuevas mediciones.
2. **Acciones internas no medibles**: hoy se mapean a `inconclusive`. ¿Vale la pena medirlas o las excluimos del job? Recomiendo excluirlas para no inflar la tabla con filas vacías.
3. **Backfill**: las acciones ejecutadas ANTES de implementar esto no tienen baseline confiable. Decidir: ¿corremos backfill best-effort o partimos en cero desde la fecha de release?
4. **Costo de queries Meta/GA**: medir 30 acciones/día × 3 ventanas × ~5 llamadas API = ~450 calls/día/org. Manejable pero hay que monitorear rate limits.
5. **Definición de baseline**: para posts, "mediana de últimos 10 antes de la ejecución" puede sesgarse por estacionalidad. Considerar comparar con mismo día de la semana N semanas atrás como alternativa.

## Estimación

- Schema + migration: 1h
- `outcome-measurement.service.js` con mappers por action_type (3-4 tipos críticos primero): 6-8h
- Tools nuevas + registro en dispatcher: 1-2h
- Tests + validación con IGNIS: 2-3h
- **Total**: ~2 días de trabajo enfocado

## Cuándo implementar

Dependencias previas:
- ✅ Sistema de niveles auditado (Entrega A)
- ✅ `getPendingActions` expuesta a Vera (Entrega A.5)
- ⏳ Migración a MCP (Entrega B) — opcional pero recomendado antes, así las tools nuevas ya nacen MCP-native
- ⏳ Decisión sobre `gap_competencia` y enriquecimiento del score con retail (#5) — para integrar `historical_success_rate` coherentemente

**Recomendación**: implementar **después** de completar la migración a MCP (Entrega B). Si se implementa antes, hay que migrar 2 veces.

## Referencias en código

- Tabla afectada: `vera_pending_actions` (existe), `vera_action_outcomes` (nueva)
- Servicios afectados: `src/services/action-executor.service.js` (no se toca), `src/services/outcome-measurement.service.js` (nuevo)
- Tools afectadas: extensión de `src/tools/strategy.tools.js`
- Cron arranque: agregar a `src/index.js` con flag `OUTCOME_MEASUREMENT_ENABLED`
