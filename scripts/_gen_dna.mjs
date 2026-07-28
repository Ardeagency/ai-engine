import "dotenv/config";
import { generateBrandDna } from "/root/ai-engine/src/services/brand-dna-generator.service.js";
const r = await generateBrandDna({
  organizationId:   "e2477719-d65e-422a-a5aa-3473d6536060",
  brandContainerId: "826ce6bb-800f-4546-8fd4-666a4047b0fd",
  trigger:          "manual",
});
console.log("=== OK id:", r.id, "| lineas:", r.lines_count, "| chars:", r.chars_count, "| modelo:", r.model_used);
console.log("\n" + r.dna_text);
