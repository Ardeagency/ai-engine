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

if (problems.length) {
  console.error("Guard de tools FALLO:\n" + problems.map((p) => "  ✗ " + p).join("\n"));
  process.exit(1);
}
console.log(`Guard de tools OK — ${AVAILABLE_TOOL_NAMES.length} handlers; todas las fases y el catalogo son subconjunto del registry. Sin fantasmas.`);
process.exit(0);
