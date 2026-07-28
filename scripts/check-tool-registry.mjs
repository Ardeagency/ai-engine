/**
 * Guard de integridad del registro de tools de VERA.
 *
 * Falla (exit 1) si:
 *   1. Alguna tool listada en una fase (TOOLS_BY_PHASE) NO tiene handler en
 *      TOOL_REGISTRY → "tool fantasma": Vera la veria habilitada y la Capa 2
 *      la rechazaria con un error que contradice el prompt.
 *   2. El catalogo (tool-catalog.js) referencia una tool inexistente en el
 *      registry (ejemplo o alias oculto que apunta a la nada).
 *
 * Uso:  npm test   (o  node --env-file=.env scripts/check-tool-registry.mjs)
 * Correr SIEMPRE antes de desplegar cambios en tools/fases/catalogo.
 */
import { readFileSync } from "node:fs";
import { AVAILABLE_TOOL_NAMES } from "../src/services/tool.dispatcher.js";
import { TOOLS_BY_PHASE } from "../src/lib/tool-phases.js";
import { CATALOG_TOOL_NAMES } from "../src/lib/tool-catalog.js";

const registry = new Set(AVAILABLE_TOOL_NAMES);
const problems = [];

for (const [phase, tools] of Object.entries(TOOLS_BY_PHASE)) {
  for (const t of tools) {
    if (!registry.has(t)) problems.push(`fase ${phase}: "${t}" NO tiene handler en TOOL_REGISTRY (tool fantasma)`);
  }
}
for (const t of CATALOG_TOOL_NAMES) {
  if (!registry.has(t)) problems.push(`tool-catalog: "${t}" referenciado pero NO existe en TOOL_REGISTRY`);
}

// ── Convencion de llamada ────────────────────────────────────────────────────
// dispatchTool invoca `tool.fn(safeParams)` con las claves PLANAS:
//     const safeParams = { ...params, organizationId, userId, allowedTools }
// Un handler cuya firma desestructura `params`, no tiene `...rest` y no nombra
// ninguna clave de datos plana solo puede leer safeParams.params — que NUNCA
// existe. Se ejecuta, no lanza, y tira a la basura lo que el agente le paso.
const CTX = new Set(["params", "organizationId", "userId", "brandContainerId",
                     "allowedTools", "conversationId", "orgName"]);
const fuente = readFileSync(new URL("../src/services/tool.dispatcher.js", import.meta.url), "utf8");
const cuerpo = fuente.slice(fuente.indexOf("TOOL_REGISTRY"));
const reFirma = /^\s{2}([a-zA-Z][a-zA-Z0-9_]{2,}):\s*\{\s*\n\s*(?:\/\/[^\n]*\n\s*)*fn:\s*(?:async\s*)?\(([^)]*)\)/gm;
let mf;
while ((mf = reFirma.exec(cuerpo)) !== null) {
  const [, nombre, arg] = mf;
  if (!/^\s*\{/.test(arg) || !/\bparams\b/.test(arg)) continue;
  if (arg.includes("...")) continue;
  const claves = [...arg.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=[,:}=])/g)].map((x) => x[1]);
  if (claves.some((k) => !CTX.has(k))) continue;
  problems.push(`${nombre}: solo lee safeParams.params, que nunca existe — descarta en silencio lo que le pasen. Anade ...rest o desestructura las claves planas.`);
}

if (problems.length) {
  console.error("Guard de tools FALLO:\n" + problems.map((p) => "  ✗ " + p).join("\n"));
  process.exit(1);
}
console.log(`Guard de tools OK — ${AVAILABLE_TOOL_NAMES.length} handlers; fases y catalogo son subconjunto del registry, y ningun handler descarta sus parametros.`);
process.exit(0);
