# 🟢 `crisis-watch` itera marcas demo

**Detectado:** 2026-05-11
**Severidad:** baja — desperdicio mínimo de RPCs

## Síntoma

`python-analyzer-crisis-watch.service` ejecuta cada 5 minutos:
```bash
for B in $(curl ... brand_containers?select=id); do
  CR=$(curl ... rpc/snapshot_crisis ...)
  ...
done
```

Itera **todos** los `brand_containers`, incluyendo IGNIS (marca ficticia demo, ver `project_ignis_es_ficticia`).

## Impacto

- N RPCs/ciclo extra donde N = cantidad de marcas demo.
- Polución potencial: si alguna marca demo genera alertas, dispara `delivery/dispatch` que envía notificaciones reales.

## Fix propuesto

Editar el `ExecStart` en `/etc/systemd/system/python-daemon-crisis-watch.service` para filtrar:
```
.../brand_containers?select=id&is_demo=eq.false
```
(o el flag equivalente que distinga marcas reales de demo)

Y luego:
```
systemctl daemon-reload && systemctl restart python-analyzer-crisis-watch.timer
```

## Estado

⏸️ Pendiente. Requiere verificar el nombre exacto del flag/columna que marca demos.
