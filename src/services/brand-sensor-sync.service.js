/**
 * Brand Sensor Sync Service — auto-crea sensores brand-wide para cada
 * brand_container con al menos una brand_integration activa.
 *
 * Por qué existe:
 *   Cuando un usuario conecta su primera integración (Meta/Google/etc), la marca
 *   pasa a tener data disponible para los sensores brand-wide (demographics,
 *   alignment, heatmap, etc). Sin este servicio, alguien tendría que insertar
 *   manualmente los 7 monitoring_triggers por cada marca nueva.
 *
 * Idempotente: solo inserta si el trigger no existe (UNIQUE por brand_container_id +
 * sensor_type + entity_id IS NULL). Re-runs cada 5 min son free.
 *
 * Sensores brand-wide cubiertos (NO los per-entity como social/meta_page_insights —
 * esos requieren intelligence_entities y se crean cuando el usuario configura
 * competidores/cuentas a vigilar):
 *   1. meta_audience_demographics       — daily — pulla composición demográfica de IG/FB
 *   2. ga4_audience_demographics        — daily — pulla demografía de GA4
 *   3. meta_ads_audiences_sync          — daily — sync de custom/saved audiences de Meta Ads
 *   4. audience_alignment_analysis      — daily — calcula alignment_score persona vs real
 *   5. brand_audience_heatmap_compute   — daily — agrega engagement por hora/día
 *   6. mission_generation               — 5 min — convierte pending_actions aprobadas en body_missions
 *   7. brand_indexer                    — daily — embeddings de brand_profiles + DNA + entidades
 *
 * Patrón: igual a org-sync.service.js — interval, idempotente, log discreto.
 */
import { supabase } from "../lib/supabase.js";

const SYNC_INTERVAL_MS = parseInt(process.env.BRAND_SENSOR_SYNC_INTERVAL_MS || "300000", 10); // 5 min

const BRAND_WIDE_SENSORS = [
  { sensor_type: "meta_audience_demographics",     cadence: "daily",    cadence_value: "1", priority: 6 },
  { sensor_type: "ga4_audience_demographics",      cadence: "daily",    cadence_value: "1", priority: 6 },
  { sensor_type: "meta_ads_audiences_sync",        cadence: "daily",    cadence_value: "1", priority: 5 },
  { sensor_type: "meta_campaign_audience_demographics", cadence: "daily", cadence_value: "1", priority: 5 },
  { sensor_type: "meta_campaign_ad_insights",      cadence: "daily",    cadence_value: "1", priority: 6 },
  { sensor_type: "audience_alignment_analysis",    cadence: "daily",    cadence_value: "1", priority: 4 },
  { sensor_type: "brand_audience_heatmap_compute", cadence: "daily",    cadence_value: "1", priority: 5 },
  { sensor_type: "mission_generation",             cadence: "interval", cadence_value: "5", priority: 7 },
  { sensor_type: "strategic_review",               cadence: "daily",    cadence_value: "1", priority: 6 },
  { sensor_type: "brand_indexer",                  cadence: "daily",    cadence_value: "1", priority: 4 },
  { sensor_type: "threat_detection",               cadence: "daily",    cadence_value: "1", priority: 6 },
  { sensor_type: "meta_ad_library_sync",           cadence: "daily",    cadence_value: "1", priority: 5 },
  // Trends engine — pipeline Apify+NewsAPI+OpenAI+Sonnet que genera briefs
  // estratégicos. Costo ~$0.08-0.15 por ciclo, daily es suficiente.
  { sensor_type: "trends_run",                     cadence: "daily",    cadence_value: "1", priority: 7 },
];

let _interval = null;

// Resuelve cadencia del sensor `trends_run` desde plans.trends_cadence_days.
// Plan agency = daily, team = 2 días, creator = 7 días. Fallback 7 (lo más
// conservador) si la org no tiene plan activo.
async function _resolveTrendsCadence(organizationId) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plans!inner(trends_cadence_days)")
    .eq("organization_id", organizationId)
    .in("status", ["trial", "active", "past_due"])
    .maybeSingle();
  const days = sub?.plans?.trends_cadence_days ?? 7;
  // cadence_value en minutos para soportar valores arbitrarios sin nuevo type
  return { cadence: "interval", cadence_value: String(days * 24 * 60) };
}

async function ensureSensorsForBrand(brandContainerId, organizationId) {
  let created = 0, existed = 0;
  for (let i = 0; i < BRAND_WIDE_SENSORS.length; i++) {
    const s = BRAND_WIDE_SENSORS[i];

    const { data: existing } = await supabase
      .from("monitoring_triggers")
      .select("id")
      .eq("brand_container_id", brandContainerId)
      .eq("sensor_type", s.sensor_type)
      .is("entity_id", null)
      .maybeSingle();

    if (existing?.id) {
      existed++;
      continue;
    }

    // Para trends_run, derivar cadencia del plan de la org (no del array estático).
    let cadence = s.cadence;
    let cadenceValue = s.cadence_value;
    if (s.sensor_type === "trends_run") {
      const resolved = await _resolveTrendsCadence(organizationId);
      cadence = resolved.cadence;
      cadenceValue = resolved.cadence_value;
    }

    // Escalonar next_run_at por 2 min para evitar stampede
    const nextRunAt = new Date(Date.now() + i * 2 * 60_000).toISOString();
    const { error } = await supabase.from("monitoring_triggers").insert({
      brand_container_id: brandContainerId,
      organization_id:    organizationId,
      entity_id:          null,
      sensor_type:        s.sensor_type,
      cadence,
      cadence_value:      cadenceValue,
      priority:           s.priority,
      status:             "active",
      next_run_at:        nextRunAt,
      config:             { auto_created_by: "brand-sensor-sync", created_at: new Date().toISOString() },
    });

    if (error) {
      console.warn(`[brand-sensor-sync] insert ${s.sensor_type} para brand ${brandContainerId} falló: ${error.message}`);
    } else {
      created++;
    }
  }
  return { created, existed };
}

async function runBrandSensorSync() {
  try {
    // 1. Lee todas las brand_integrations activas con su brand_container y org
    const { data: activeIntegrations, error: readErr } = await supabase
      .from("brand_integrations")
      .select("brand_container_id, brand_containers!inner(id, organization_id)")
      .eq("is_active", true);

    if (readErr) {
      console.warn(`[brand-sensor-sync] read brand_integrations falló: ${readErr.message}`);
      return;
    }
    if (!activeIntegrations?.length) return;

    // 2. Únicos brand_container_ids con su org
    const uniqueBrands = new Map();
    for (const i of activeIntegrations) {
      const bcId  = i.brand_container_id;
      const orgId = i.brand_containers?.organization_id;
      if (!bcId || !orgId) continue;
      if (!uniqueBrands.has(bcId)) uniqueBrands.set(bcId, orgId);
    }
    if (!uniqueBrands.size) return;

    // 3. Por cada brand, asegurar los 7 sensores
    let totalCreated = 0;
    const brandsWithNew = [];
    for (const [brandId, orgId] of uniqueBrands) {
      const r = await ensureSensorsForBrand(brandId, orgId);
      if (r.created > 0) {
        totalCreated += r.created;
        brandsWithNew.push({ brandId, created: r.created });
      }
    }

    if (totalCreated > 0) {
      console.log(`brand-sensor-sync: ${totalCreated} sensor(es) creado(s) en ${brandsWithNew.length} brand(s)`);
      for (const b of brandsWithNew) {
        console.log(`  brand ${b.brandId} → +${b.created}`);
      }
    }
  } catch (e) {
    console.warn(`[brand-sensor-sync] error inesperado: ${e.message}`);
  }
}

/**
 * Arranca el ciclo periódico. Default: cada 5 min, primera corrida en 30s.
 */
export function startBrandSensorSync(intervalMs = SYNC_INTERVAL_MS) {
  console.log(`brand-sensor-sync: arrancando — primera ejecución en 30s, luego cada ${intervalMs / 60000}min`);
  setTimeout(() => {
    runBrandSensorSync().catch((e) => console.warn(`[brand-sensor-sync] init: ${e.message}`));
  }, 30_000);
  _interval = setInterval(() => {
    runBrandSensorSync().catch((e) => console.warn(`[brand-sensor-sync] tick: ${e.message}`));
  }, intervalMs);
}

export function stopBrandSensorSync() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}

// Export para uso ad-hoc (testing, REPL, etc.)
export { runBrandSensorSync, ensureSensorsForBrand };
