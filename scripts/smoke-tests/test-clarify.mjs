// Smoke test: fuerza a VERA a producir un [CLARIFY]
// Importa callOpenClaw directamente con un viewModel mínimo para IGNIS.

import { callOpenClaw } from "/root/ai-engine/src/services/openclaw.adapter.js";
import { initRegistry, getOrgEntry } from "/root/ai-engine/src/services/openclaw.registry.js";

const ORG_ID = "a1000000-0000-0000-0000-000000000001"; // IGNIS

await initRegistry();
const entry = getOrgEntry(ORG_ID);
if (!entry) {
  console.error(`Org ${ORG_ID} NO está en registry. Abortando.`);
  process.exit(1);
}
console.log(`[smoke-test] org registrada → ${entry.type} ${entry.ip || ""}:${entry.port || ""} status=${entry.status}`);
console.log(`[smoke-test] disparando mensaje a VERA...\n`);

const t0 = Date.now();
const result = await callOpenClaw({
  message: "Quiero crear contenido para mi marca",
  attachments: [],
  viewModel: {
    identity: {
      organization_id: ORG_ID,
      plan: "agency",
      user_role: "owner",
    },
    brand: { name: "IGNIS" },
    capabilities: [],
    autonomy: {
      level: "supervisado",
      instructions: [
        "Antes de ejecutar acciones de escritura debes pedir APPROVE_ACTION.",
      ],
    },
  },
  recentHistory: [],
  conversationId: null,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`[smoke-test] respuesta recibida en ${elapsed}s\n`);
console.log("======= RAW TEXT =======");
console.log(result.text);
console.log("\n======= tool_calls =======");
console.log(JSON.stringify(result.tool_calls || [], null, 2));
console.log("\n======= requires_consent =======");
console.log(result.requires_consent);

// Heurística rápida: ¿emitió alguno de los bloques nuevos?
const detected = ["[CLARIFY]", "[PILLS]", "[STEPS]", "[METRICS]", "[ACTIONS]"]
  .filter((b) => result.text?.includes(b));
console.log("\n======= bloques interactivos detectados =======");
console.log(detected.length ? detected.join(", ") : "NINGUNO — Vera respondió en prosa");

process.exit(0);
