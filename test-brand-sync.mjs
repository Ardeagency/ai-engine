import { createClient } from "@supabase/supabase-js";
import { runBrandSensorSync } from "./src/services/brand-sensor-sync.service.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const orgId = "a1000000-0000-0000-0000-000000000001";

// Get a valid user_id
const { data: members } = await sb.from("organization_members").select("user_id").eq("organization_id", orgId).limit(1);
const userId = members?.[0]?.user_id;

// 1) Create temp brand_container
const { data: tempBrand, error: bcErr } = await sb.from("brand_containers").insert({
  user_id:         userId,
  organization_id: orgId,
  nombre_marca:    "_TEST_BRAND_SYNC_" + Date.now(),
}).select("id").maybeSingle();

if (bcErr || !tempBrand) {
  console.error("Failed to create temp brand:", bcErr?.message);
  process.exit(1);
}
const tempBrandId = tempBrand.id;
console.log("Temp brand creado: " + tempBrandId);

// 2) Create temp brand_integration with is_active=true
const { error: intErr } = await sb.from("brand_integrations").insert({
  brand_container_id:     tempBrandId,
  platform:               "facebook",
  external_account_id:    "test_account_999",
  external_account_name:  "Test Account (sync test)",
  access_token:           "test_token_placeholder",
  is_active:              true,
});
if (intErr) {
  console.error("Failed to create integration:", intErr.message);
  await sb.from("brand_containers").delete().eq("id", tempBrandId);
  process.exit(1);
}
console.log("Temp integration creada");

// 3) Verificar: 0 sensores antes
const { count: before } = await sb.from("monitoring_triggers").select("*", { count: "exact", head: true }).eq("brand_container_id", tempBrandId);
console.log("Sensores antes del sync: " + (before || 0));

// 4) Correr sync
console.log("\nEjecutando runBrandSensorSync()...");
await runBrandSensorSync();

// 5) Verificar sensores creados
const { data: sensors } = await sb.from("monitoring_triggers").select("sensor_type, status, next_run_at, config").eq("brand_container_id", tempBrandId).is("entity_id", null);
console.log("\nSensores después del sync: " + (sensors?.length || 0));
for (const s of sensors || []) {
  console.log("  ✓ " + s.sensor_type + " | status=" + s.status + " | auto_by=" + s.config?.auto_created_by);
}

// 6) Cleanup
console.log("\nLimpiando recursos de test...");
await sb.from("monitoring_triggers").delete().eq("brand_container_id", tempBrandId);
await sb.from("brand_integrations").delete().eq("brand_container_id", tempBrandId);
await sb.from("brand_containers").delete().eq("id", tempBrandId);
console.log("Cleanup OK");

// Resultado del test
const expected = 7;
const got = sensors?.length || 0;
console.log("\n" + (got === expected ? "✅ TEST PASS" : "❌ TEST FAIL") + " — esperado " + expected + ", obtenido " + got);
