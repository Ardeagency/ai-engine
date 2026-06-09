import { callOpenClaw } from "/root/ai-engine/src/services/openclaw.adapter.js";
import { initRegistry, getOrgEntry } from "/root/ai-engine/src/services/openclaw.registry.js";

const ORG_ID = "a1000000-0000-0000-0000-000000000001";

await initRegistry();
const entry = getOrgEntry(ORG_ID);
if (!entry) { console.error(`Org ${ORG_ID} sin entrada`); process.exit(1); }
console.log(`[smoke] org ${entry.type} ${entry.ip}:${entry.port} ${entry.status}\n`);

const t0 = Date.now();
const result = await callOpenClaw({
  message: "Crea un artifact con una gráfica de barras interactiva usando ECharts que muestre engagement por día de la semana. Incluye selector de red social y tema oscuro.",
  attachments: [],
  viewModel: {
    identity: { organization_id: ORG_ID, plan: "agency", user_role: "owner" },
    brand: { name: "IGNIS" },
    capabilities: [],
    autonomy: { level: "supervisado", instructions: [] },
  },
  recentHistory: [],
  conversationId: null,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`[smoke] respuesta en ${elapsed}s\n`);
console.log("======= RAW TEXT =======");
console.log(result.text);
console.log("\n======= tool_calls =======");
console.log(JSON.stringify(result.tool_calls || [], null, 2));

const blocks = {
  artifact: (result.text || "").match(/```artifact/g)?.length || 0,
  html:     (result.text || "").match(/```html/g)?.length || 0,
  chart:    (result.text || "").match(/```chart/g)?.length || 0,
  echarts:  (result.text || "").toLowerCase().includes("echarts"),
};
console.log("\n======= bloques detectados =======");
console.log(JSON.stringify(blocks, null, 2));

process.exit(0);
