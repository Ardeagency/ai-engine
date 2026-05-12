# 🟡 `brand_indexer` bloqueado por OpenAI 429

**Detectado:** 2026-05-11
**Severidad:** media — degrada inteligencia semántica pero no bloquea producto

## Síntoma

`brand_indexer` (sensor diario, lógica local) falla cada ejecución desde **2026-05-08** con:
```
brand_indexer: embeddings_failed_all (37 embed errors): OpenAI embeddings 429: {...}
```

## Causa raíz

Quota de OpenAI agotada (coincide con `project_trends_engine` → "blockers vivos: Apify+OpenAI quotas agotadas").

El indexer pide 37 embeddings por run y los 37 reciben 429. Eso sugiere que el cache hash-based (`feedback_embeddings_sancionados`) **no está hidratado** para los chunks actuales o el batch va concurrente sin retry/backoff.

## Opciones

| Acción | Esfuerzo | Pro | Contra |
|---|---|---|---|
| (a) Pausar el sensor hasta tener quota | trivial | Deja de spamear logs y notificaciones | Sin embeddings nuevos → degradación silenciosa |
| (b) Aumentar quota / rotar API key | bajo | Solución natural | Costo recurrente |
| (c) Reducir batch + agregar retry exponencial | medio | Funciona con quota baja | Indexer más lento |
| (d) Mover a `text-embedding-3-small` (más barato) | medio | 5× más barato | Pequeña pérdida de calidad |

## Recomendación

Combinar (b) + (c): aumentar quota y, en paralelo, hacer el indexer resiliente a 429 (retry con backoff, batch más chico).

## Estado

⏸️ Pendiente de decisión del usuario.
