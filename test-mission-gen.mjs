import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

// Obtener un user_id válido de la org (admin/member)
const { data: members } = await sb.from("organization_members").select("user_id, role").eq("organization_id", orgId);
const adminUserId = members?.find((m) => m.role === "admin")?.user_id || members?.[0]?.user_id;
console.log("admin user_id:", adminUserId);

// Aprobar un pending_action correctamente
const { data: pendings } = await sb.from("vera_pending_actions").select("id, action_type").eq("brand_container_id", brandId).eq("status", "pending").limit(1);
if (pendings?.length) {
  const target = pendings[0];
  const { error: appErr } = await sb.from("vera_pending_actions")
    .update({
      status:      "approved",
      approved_by: adminUserId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", target.id);
  console.log("\nAprobando " + target.id + " (" + target.action_type + "): " + (appErr ? appErr.message : "OK"));
}

// Re-correr scraper
console.log("\n--- ciclo scraper ---");
// Forzar trigger mission_generation a now
await sb.from("monitoring_triggers").update({ next_run_at: new Date().toISOString() })
  .eq("brand_container_id", brandId).eq("sensor_type", "mission_generation");

const scraper = await import("./src/services/social-scraper.service.js");
const r = await scraper.runCompetitorScraper();
console.log("scraper:", JSON.stringify(r));

// Verificar
const { count: mCount } = await sb.from("body_missions").select("*", { count: "exact", head: true }).eq("organization_id", orgId);
console.log("\nbody_missions: " + (mCount || 0));
const { data: ms } = await sb.from("body_missions").select("id, mission_type, status, trigger_signal_id, action_payload").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(3);
for (const m of ms || []) {
  console.log("---");
  console.log("[" + m.status + "] " + m.mission_type);
  console.log("  trigger_signal: " + m.trigger_signal_id);
  console.log("  action_payload: " + JSON.stringify(m.action_payload).slice(0, 250));
}

const { data: paStates } = await sb.from("vera_pending_actions").select("id, action_type, status, execution_result").eq("brand_container_id", brandId);
console.log("\nvera_pending_actions estado:");
for (const a of paStates || []) console.log("  [" + a.status + "] " + a.action_type + " | exec=" + JSON.stringify(a.execution_result));

// Sensor run stats
const { data: lastRun } = await sb.from("sensor_runs").select("stats, error_message, started_at").eq("brand_container_id", brandId).eq("sensor_type", "mission_generation").order("started_at", {ascending:false}).limit(1);
console.log("\nÚltimo mission_generation run:", JSON.stringify(lastRun?.[0]));
