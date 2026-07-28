/**
 * Guard de integridad del registro de tools de VERA.
 *
 * Falla (exit 1) si:
 *   1. Alguna tool listada en una fase (TOOLS_BY_PHASE) NO tiene handler en
 *      TOOL_REGISTRY → "tool fantasma": Vera la veria habilitada y la Capa 2
 *      la rechazaria con un error que contradice el prompt.
 *   2. El catalogo (tool-catalog.js) referencia una tool inexistente en el
 *      registry (ejemplo o alias oculto que apunta a la nada).
 *   3. La DOCTRINA (defaults/*.md y defaults/skills) manda usar una tool que
 *      ninguna fase expone. Este es el sentido que faltaba: el guard solo
 *      comprobaba fases ⊆ registry, jamas lo contrario, asi que una tool con
 *      handler pero sin fase se leia perfecta en la skill y fallaba muda al
 *      llamarla. Paso con harvestPostComments y getHarvestedComments, fuera de
 *      alcance desde el 22 de julio mientras cuatro skills se las mandaban usar.
 *
 * Uso:  npm test   (o  node --env-file=.env scripts/check-tool-registry.mjs)
 * Correr SIEMPRE antes de desplegar cambios en tools/fases/catalogo.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// ── La doctrina no puede mandar lo que no se puede llamar ────────────────────
// Se leen los ficheros de doctrina raiz y cada SKILL.md, se sacan los nombres
// con forma de tool (verbo + camelCase) y se cruzan contra la union de las
// fases. Lo que la doctrina nombra y ninguna fase expone es una orden condenada
// a fallar — y ademas tokens pagados por leer un protocolo imposible.
const expuestas = new Set(Object.values(TOOLS_BY_PHASE).flat());
const DEFAULTS = fileURLToPath(new URL("../defaults/", import.meta.url));
const VERBOS = /^(get|list|create|update|delete|upsert|publish|propose|run|start|pause|resume|harvest|generate|score|build|place|connect|disconnect|move|remove|set|search|analyze|approve|reject|send|fetch|measure|dispatch|trigger)[A-Z]/;

const doctrina = [];
for (const f of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "HEARTBEAT.md"]) {
  try { doctrina.push([f, readFileSync(path.join(DEFAULTS, f), "utf8")]); } catch { /* opcional */ }
}
try {
  const SK = path.join(DEFAULTS, "skills");
  for (const s of readdirSync(SK)) {
    const p = path.join(SK, s, "SKILL.md");
    try { if (statSync(p).isFile()) doctrina.push([s, readFileSync(p, "utf8")]); } catch { /* sin SKILL.md */ }
  }
} catch { /* sin carpeta de skills */ }

const citadaEn = new Map();
for (const [donde, txt] of doctrina) {
  for (const m of txt.matchAll(/\b([a-z][a-zA-Z0-9]{4,40})\b/g)) {
    if (!VERBOS.test(m[1])) continue;
    if (!citadaEn.has(m[1])) citadaEn.set(m[1], new Set());
    citadaEn.get(m[1]).add(donde);
  }
}
for (const [tool, donde] of [...citadaEn].sort()) {
  if (expuestas.has(tool)) continue;
  const estado = registry.has(tool)
    ? "tiene handler pero NINGUNA fase la expone — o se anade a una fase, o se quita de la doctrina"
    : "no existe en TOOL_REGISTRY — nombre muerto";
  problems.push(`doctrina: "${tool}" ${estado} (citada en: ${[...donde].slice(0, 4).join(", ")})`);
}

if (problems.length) {
  console.error("Guard de tools FALLO:\n" + problems.map((p) => "  ✗ " + p).join("\n"));
  process.exit(1);
}
console.log(
  `Guard de tools OK — ${AVAILABLE_TOOL_NAMES.length} handlers; fases y catalogo son subconjunto del registry, ` +
  `ningun handler descarta sus parametros, y las ${citadaEn.size} tools que la doctrina manda usar son llamables.`
);
process.exit(0);
