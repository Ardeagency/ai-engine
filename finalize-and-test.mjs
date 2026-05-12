import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

// 1) Backfill: la openclaw_instance ya healthy nunca registró eventos. Insertamos
//    un evento sintético "agent_online" para que el audit trail tenga al menos
//    el estado actual reflejado.
const { data: inst } = await sb.from("openclaw_instances").select("id, status, server_ip, server_port, agent_id, provisioned_at").eq("organization_id", orgId).maybeSingle();
console.log("Instancia existente:", inst?.id, "status:", inst?.status);

const { data: hasEvents } = await sb.from("provisioning_events").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
const { count: evCount } = await sb.from("provisioning_events").select("*", { count: "exact", head: true }).eq("organization_id", orgId);
console.log("Eventos previos:", evCount || 0);

if ((evCount || 0) === 0 && inst) {
  const { error } = await sb.from("provisioning_events").insert({
    organization_id: orgId,
    instance_id:     inst.id,
    event_type:      "agent_online",
    phase:           "complete",
    message:         "Backfill: instancia healthy preexistente al despliegue del audit log",
    metadata:        { server_ip: inst.server_ip, port: inst.server_port, agent_id: inst.agent_id, backfilled: true },
  });
  console.log("Backfill agent_online: " + (error ? error.message : "OK"));
}

// 2) Crear trigger mission_generation
const { data: existingTrg } = await sb.from("monitoring_triggers").select("id").eq("brand_container_id", brandId).eq("sensor_type", "mission_generation").is("entity_id", null).maybeSingle();
if (!existingTrg) {
  const { data: ins, error } = await sb.from("monitoring_triggers").insert({
    brand_container_id: brandId,
    organization_id:    orgId,
    entity_id:          null,
    sensor_type:        "mission_generation",
    cadence:            "interval",
    cadence_value:      "5",
    priority:           7,
    status:             "active",
    next_run_at:        new Date().toISOString(),
    config:             { auto_created_by: "audience-intelligence-rollout-2026-04-28" },
  }).select("id").maybeSingle();
  console.log("trigger mission_generation: " + (error ? error.message : "creado " + ins.id));
} else {
  console.log("trigger mission_generation: ya existe " + existingTrg.id);
}

// 3) Aprobar 1 pending_action para probar end-to-end
const { data: pendings } = await sb.from("vera_pending_actions").select("id, action_type, status, vera_reasoning").eq("brand_container_id", brandId).eq("status", "pending").limit(1);
if (pendings?.length) {
  const target = pendings[0];
  const { error: appErr } = await sb.from("vera_pending_actions")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", target.id);
  console.log("\nAprobando pending_action " + target.id + " (" + target.action_type + "): " + (appErr ? appErr.message : "OK"));
}

// 4) Forzar ciclo del scraper (incluye mission_generation)
console.log("\n--- Ejecutando ciclo del scraper para mission_generation ---");
const scraper = await import("./src/services/social-scraper.service.js");
const r = await scraper.runCompetitorScraper();
console.log("Resultado:", JSON.stringify(r));

// 5) Verificar resultados
console.log("\n=== ESTADO FINAL ===");
const { count: evNow } = await sb.from("provisioning_events").select("*", { count: "exact", head: true }).eq("organization_id", orgId);
console.log("provisioning_events: " + (evNow || 0));
const { data: evs } = await sb.from("provisioning_events").select("event_type, phase, message, metadata, created_at").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(5);
for (const e of evs || []) console.log("  [" + e.event_type + "] phase=" + e.phase + " | " + e.message);

const { count: mCount } = await sb.from("body_missions").select("*", { count: "exact", head: true }).eq("organization_id", orgId);
console.log("\nbody_missions: " + (mCount || 0));
const { data: ms } = await sb.from("body_missions").select("id, mission_type, status, action_payload").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(5);
for (const m of ms || []) {
  console.log("  [" + m.status + "] " + m.mission_type + " | action=" + JSON.stringify(m.action_payload).slice(0, 150));
}

// pending actions estado
const { data: paStates } = await sb.from("vera_pending_actions").select("id, action_type, status, execution_result").eq("brand_container_id", brandId);
console.log("\nvera_pending_actions:");
for (const a of paStates || []) console.log("  [" + a.status + "] " + a.action_type + " | exec=" + JSON.stringify(a.execution_result));
