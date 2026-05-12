# 🤔 `vera-strategist.timer` ejecuta LLM en background

**Detectado:** 2026-05-11
**Severidad:** baja — viola regla declarada, pero produce valor

## Conflicto

`vera-strategist.service` (cron semanal lunes 06:00 UTC) ejecuta:
```
/root/ai-engine/python-analyzer/.venv/bin/python app/vera_strategist.py --num-proposals 5
```
que invoca **Claude Opus 4.7** ($15/$75 per MTok) con 10 capas de `brand_intelligence_context` y genera 5 propuestas estratégicas insertadas en `strategic_recommendations`.

Esto choca con `feedback_no_llm_in_background.md`:
> scrapers/sensores/alignment usan reglas+templates+matemática, nunca Vera. LLM solo en chat cara al usuario.

## Caminos

1. **Mantenerlo** → actualizar la memoria para hacer una excepción explícita ("LLM en background OK para batches estratégicos semanales").
2. **Eliminarlo** → `systemctl disable --now vera-strategist.timer vera-strategist.service`. Las propuestas se generarían bajo demanda desde el chat.
3. **Migrar a Sonnet 4.6** ($3/$15) → 5× más barato, sigue violando la regla pero con menor costo. Requiere A/B de calidad.

## Estado

⏸️ Decisión pendiente del usuario.
