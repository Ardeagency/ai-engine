# Migración a MCP — guía de activación

**Estado código**: ✅ Integrado y validado en ai-engine (Entrega B completa)
**Estado producción**: ⏳ Pendiente: registrar MCP en cada org-server existente
**Fecha integración**: 2026-05-08

## Qué se cambió en ai-engine

| Componente | Estado | Archivo |
|---|---|---|
| Endpoint `POST /mcp/dispatch` (auth por X-Org-Token, ejecuta `dispatchTool`) | ✅ Activo | `src/controllers/mcp.controller.js` (nuevo) |
| Endpoint `GET /mcp/list-tools` (filtra por nivel de autonomía actual) | ✅ Activo | mismo |
| Endpoint `GET /mcp/health` (verifica auth + responde org_id) | ✅ Activo | mismo |
| Routing `/mcp/*` montado | ✅ Activo | `src/routes/mcp.routes.js` (nuevo) + `src/index.js` |
| MCP server reescrito como cliente HTTP del control plane (sin Supabase directo) | ✅ Activo | `src/mcp/ai-engine-tools.js` |
| Inyección de `[CONVERSATION_ID]` al enrichedMessage (necesario para consent vía MCP) | ✅ Activo | `src/services/openclaw.adapter.js` + `src/services/ai.service.js` |
| Cloud-init incluye automáticamente el MCP server en nuevas orgs | ✅ Activo | `src/services/hetzner.provisioner.js` |
| Backups de archivos modificados | ✅ | sufijo `.bak.entrega-b` |

E2E validado con curl contra Arde Agency (a1000000-…0001):
- `/mcp/health` → 200 con organization_id resuelto del token
- `/mcp/list-tools` → 200, level=parcial, phase=B, 82 tools
- `/mcp/dispatch getOrgOverview` → 200 ok:true con resultado real
- `/mcp/dispatch tool fuera de phase` → 403 phaseBlocked
- `/mcp/dispatch token inválido` → 401

## Arquitectura activa

```
Vera (OpenClaw) en org-server (Hetzner)
   │ stdio
   ▼
MCP server local /opt/ai-engine-mcp/server.js
   │ HTTP + X-Org-Token
   ▼
ai-engine /mcp/dispatch
   ├─ resuelve organizationId del token (anti-spoofing)
   ├─ getOrgAutonomy → phase actual
   ├─ carga approvedIntents si conversation_id presente
   └─ dispatchTool() — phase + allowlist + schema + policy + consent + timeout
```

## Pendiente para activar en producción

### Para org-servers EXISTENTES (Arde Agency hoy: 88.99.174.96)

**Opción A — script SSH (recomendado, sin downtime)**

Desde tu Mac (que tiene SSH al Hetzner):

```bash
# 1. Descargar el script desde ai-engine
scp ai-engine:/root/ai-engine/scripts/migrate-existing-server-to-mcp.sh ~/migrate-mcp.sh
chmod +x ~/migrate-mcp.sh

# 2. Obtener server_ip + org_token + org_id desde la DB
ssh ai-engine 'cd /root/ai-engine && node --input-type=module -e "
  import { supabase } from \"./src/lib/supabase.js\";
  const { data } = await supabase.from(\"openclaw_instances\")
    .select(\"organization_id,server_ip,org_token\")
    .not(\"server_ip\", \"is\", null);
  for (const r of data || []) console.log(r.organization_id, r.server_ip, r.org_token);
"'

# 3. Ejecutar la migración (ejemplo con Arde Agency)
~/migrate-mcp.sh 88.99.174.96 <ORG_TOKEN> a1000000-0000-0000-0000-000000000001
```

El script:
1. Verifica conectividad token ↔ ai-engine
2. Descarga el MCP server desde ai-engine
3. Lo sube a `/opt/ai-engine-mcp/` del org-server
4. `npm install @modelcontextprotocol/sdk`
5. `openclaw mcp set ai-engine '{...}'` en el workspace del agente
6. Verifica registro

Tarda ~30-60s. Sin downtime — la próxima vez que Vera arranque su CLI, carga el MCP.

**Opción B — sleep + wake (si Opción A falla)**

```bash
# Desde ai-engine — usa el cloud-init nuevo que ya incluye MCP
curl -X POST -H "X-Internal-Key: $INTERNAL_API_KEY" \
  http://127.0.0.1:3000/internal/org/a1000000-0000-0000-0000-000000000001/sleep
# (espera 30s)
curl -X POST -H "X-Internal-Key: $INTERNAL_API_KEY" \
  http://127.0.0.1:3000/internal/org/a1000000-0000-0000-0000-000000000001/wake
# (espera ~90s para que el server termine cloud-init y haga callback)
```

Downtime ~90s. Reuse el snapshot del workspace.

### Para org-servers NUEVOS

No hay que hacer nada — el provisioner ya inyecta el MCP en cloud-init. Cualquier org creada de aquí en adelante nace con MCP registrado.

## Coexistencia transitoria

Durante la transición, **ambos canales coexisten**:

- Markers `[[TOOL:nombre|param:valor]]` en texto → parser regex en `openclaw.adapter.js` (ya existe)
- MCP nativo via stdio → endpoint `/mcp/dispatch` (nuevo)

Ambos pasan por el mismo `dispatchTool` central, así que las garantías de seguridad (phase, consent, audit) son idénticas. Vera puede usar cualquiera.

**Cuando confirmemos que MCP funciona**, eliminamos el parser de markers (deuda tracked aparte). No es urgente.

## Cómo verificar que MCP funciona en un org-server

```bash
# Desde tu Mac, SSH al org-server
ssh root@<server_ip>

# Lista MCPs registrados en el workspace
openclaw mcp list --workspace /root/workspaces/<agent_id>

# Test manual del MCP — pídele list_tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  AI_ENGINE_URL=http://5.161.243.1:3000 \
  ORG_TOKEN=<token> \
  ORG_ID=<org_id> \
  node /opt/ai-engine-mcp/server.js
```

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| MCP server no arranca por error en `/opt/ai-engine-mcp/.env` | Markers siguen funcionando como fallback durante la transición |
| ai-engine cae → MCP local no puede dispatch | Markers también dependen de ai-engine. Mismo blast radius que hoy. |
| Token comprometido (filtrado de un org-server) | Rotar `org_token` en `openclaw_instances` + reinstalar MCP en ese server. Auth cache TTL=60s, máx ventana de exposición |
| Tool nueva en ai-engine → MCP no la ve hasta TTL expire | Cache TTL es 60s. Aceptable. |
| Consent gate vía MCP requiere `_conversationId` | Vera lo recibe en `[CONVERSATION_ID]` del enrichedMessage. Si no lo pasa, la tool con consent falla con `requiresConsent:true` y Vera reacciona pidiendo APPROVE_ACTION |
| OpenClaw no soporta `mcp set` con env vars | Verificado en docs de OpenClaw — sí soporta `env` en la config |

## Checklist de activación

- [ ] Verificar que `ai-engine` responde en `/mcp/health` (ya hecho ✅)
- [ ] Listar org-servers actuales:
  ```
  ssh ai-engine 'cd /root/ai-engine && node --input-type=module -e "import { supabase } from \"./src/lib/supabase.js\"; const { data } = await supabase.from(\"openclaw_instances\").select(\"organization_id,server_ip,org_token\").not(\"server_ip\", \"is\", null); console.log(JSON.stringify(data, null, 2));"'
  ```
- [ ] Ejecutar `migrate-existing-server-to-mcp.sh` para cada uno (hoy: solo Arde Agency)
- [ ] Verificar `openclaw mcp list` muestra `ai-engine`
- [ ] Probar un chat: pedir a Vera "lista mis productos" — debería usar la tool vía MCP (visible en logs de ai-engine como `mcp:getProducts`)
- [ ] Después de 1 semana sin issues: deprecar parser de markers (cambio aparte)

## Archivos clave

- Endpoint: `src/controllers/mcp.controller.js`
- MCP server cliente: `src/mcp/ai-engine-tools.js`
- Provisioner cloud-init: `src/services/hetzner.provisioner.js`
- Script migración: `scripts/migrate-existing-server-to-mcp.sh`
- Backups originales: cualquier archivo con `.bak.entrega-b`
