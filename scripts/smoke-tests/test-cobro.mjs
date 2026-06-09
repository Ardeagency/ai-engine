// E2E smoke: pasa por processAndSaveReply para validar el cobro vera_chat.
import { processAndSaveReply } from "/root/ai-engine/src/services/ai.service.js";
import { initRegistry } from "/root/ai-engine/src/services/openclaw.registry.js";
import { createClient } from "@supabase/supabase-js";

const ORG_ID  = "a1000000-0000-0000-0000-000000000001"; // IGNIS
const USER_ID = "8ecd5e72-6277-4abf-a136-8a9100ff66ca"; // admin de IGNIS
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function bal() {
  const { data } = await sb.from("organization_credits").select("credits_available, updated_at").eq("organization_id", ORG_ID).single();
  return data;
}
async function lastVeraChat() {
  const { data } = await sb.from("credit_usage").select("id, credits_delta, created_at, metadata").eq("organization_id", ORG_ID).eq("kind", "vera_chat").order("created_at", { ascending: false }).limit(1);
  return data?.[0] || null;
}

await initRegistry();

console.log("[before] balance:", await bal());
console.log("[before] last vera_chat:", await lastVeraChat());

// Crear conversación nueva para este test
const { data: conv } = await sb.from("ai_conversations").insert({
  user_id: USER_ID, organization_id: ORG_ID, title: "[test] cobro vera_chat",
}).select("id").single();
console.log(`[smoke] conversation_id=${conv.id}`);

// Insertar mensaje del usuario (como hace chat.controller.js)
await sb.from("ai_messages").insert({
  conversation_id: conv.id, role: "user",
  content: "Hola, ¿qué puedes hacer por mi marca?", organization_id: ORG_ID,
});

const t0 = Date.now();
await processAndSaveReply({
  message: "Hola, ¿qué puedes hacer por mi marca?",
  attachments: [],
  organizationId: ORG_ID,
  userId: USER_ID,
  conversationId: conv.id,
});
console.log(`[smoke] processAndSaveReply terminó en ${((Date.now()-t0)/1000).toFixed(1)}s`);

console.log("[after] balance:", await bal());
console.log("[after] last vera_chat:", await lastVeraChat());

process.exit(0);
