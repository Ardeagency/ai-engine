import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

// Mapa de tablas con su scope esperado y categoría
// scope: brand | org | global | user | none
// category: auto (por scraper/sensor) | manual (UI/user) | system (logs/runtime) | feature_missing
const TABLES = [
  // ─── Marca / Branding ───
  { t: "brand_containers",         scope: "org",   cat: "manual",          fills: "Usuario crea marca en onboarding" },
  { t: "brand_profiles",           scope: "brand", cat: "manual",          fills: "Usuario edita en UI Brand DNA" },
  { t: "brand_colors",             scope: "org",   cat: "manual",          fills: "Usuario sube paleta" },
  { t: "brand_fonts",              scope: "org",   cat: "manual",          fills: "Usuario sube tipografías" },
  { t: "brand_rules",              scope: "brand", cat: "manual",          fills: "Usuario define reglas" },
  { t: "brand_assets",             scope: "brand", cat: "manual",          fills: "Usuario sube assets" },
  { t: "brand_entities",           scope: "org",   cat: "manual",          fills: "Usuario crea productos/servicios" },
  { t: "brand_places",             scope: "none",  cat: "manual",          fills: "Por entity" },
  { t: "products",                 scope: "org",   cat: "manual",          fills: "Usuario sube catálogo" },
  { t: "services",                 scope: "org",   cat: "manual",          fills: "Usuario sube servicios" },
  { t: "product_images",           scope: "none",  cat: "manual",          fills: "Por product" },
  { t: "product_options",          scope: "org",   cat: "manual",          fills: "Usuario configura" },
  { t: "product_option_values",    scope: "org",   cat: "manual",          fills: "Usuario configura" },
  { t: "product_variants",         scope: "org",   cat: "manual",          fills: "Usuario configura" },
  { t: "product_variant_images",   scope: "org",   cat: "manual",          fills: "Usuario sube" },
  { t: "product_variant_option_values", scope: "none", cat: "manual",      fills: "Pivot" },
  { t: "business_units",           scope: "org",   cat: "manual",          fills: "Usuario configura" },
  { t: "business_unit_products",   scope: "none",  cat: "manual",          fills: "Pivot" },
  { t: "user_business_units",      scope: "none",  cat: "manual",          fills: "Pivot" },
  { t: "visual_references",        scope: "brand", cat: "manual",          fills: "Usuario sube refs" },

  // ─── Audiencia (lo que arreglamos) ───
  { t: "audience_personas",        scope: "brand", cat: "manual",          fills: "Usuario crea persona conceptual" },
  { t: "audience_segments",        scope: "brand", cat: "auto",            fills: "Sensor meta_ads_audiences_sync (vacío porque marca no tiene custom audiences)" },
  { t: "brand_audience_heatmap",   scope: "brand", cat: "auto",            fills: "Sensor brand_audience_heatmap_compute" },

  // ─── Contenido / Posts ───
  { t: "brand_posts",              scope: "brand", cat: "auto",            fills: "Sensores social/meta_posts (own + competitor)" },
  { t: "brand_content_analysis",   scope: "brand", cat: "auto",            fills: "Analyzer rule-based (pipeline scraper)" },
  { t: "brand_narrative_pillars",  scope: "brand", cat: "auto",            fills: "Agregación post-análisis" },
  { t: "brand_analytics_snapshots", scope: "brand", cat: "auto",           fills: "Sensores meta_page_insights / ga4_analytics + writeCycleSnapshot" },

  // ─── Inteligencia / Vigilancia ───
  { t: "intelligence_entities",    scope: "brand", cat: "manual",          fills: "Usuario configura competidores/marketplace/news" },
  { t: "intelligence_signals",     scope: "none",  cat: "auto",            fills: "Pipeline scraper (signal por post nuevo)" },
  { t: "monitoring_triggers",      scope: "brand", cat: "manual",          fills: "Auto al crear entidad (debería) o manual" },
  { t: "sensor_runs",              scope: "brand", cat: "system",          fills: "Log de cada ejecución de scraper" },
  { t: "url_watchers",             scope: "brand", cat: "manual",          fills: "Usuario configura URLs a vigilar" },
  { t: "trend_topics",             scope: "brand", cat: "auto",            fills: "Pipeline scraper (keywords de posts)" },
  { t: "competitor_ads",           scope: "brand", cat: "feature_missing", fills: "🚫 No hay sensor — ad_library scraper no implementado" },
  { t: "retail_prices",            scope: "brand", cat: "feature_missing", fills: "🚫 Scraper Amazon implementado pero sin sensor_type=marketplace en uso" },
  { t: "brand_vulnerabilities",    scope: "brand", cat: "auto",            fills: "Pipeline detection (algunos)" },
  { t: "external_api_cache",       scope: "none",  cat: "system",          fills: "Cache interno de APIs" },

  // ─── Campañas / Briefs ───
  { t: "campaign_briefs",          scope: "org",   cat: "manual",          fills: "Usuario crea brief en UI" },
  { t: "campaign_brief_entities",  scope: "none",  cat: "manual",          fills: "Pivot" },
  { t: "campaign_entities",        scope: "none",  cat: "manual",          fills: "Pivot" },
  { t: "campaigns",                scope: "org",   cat: "auto+manual",     fills: "🟡 Manual (creación) / Auto (sync de Meta Ads — no implementado)" },

  // ─── Flows / Producción ───
  { t: "content_categories",       scope: "global", cat: "manual",         fills: "Admin/seeders" },
  { t: "content_subcategories",    scope: "global", cat: "manual",         fills: "Admin/seeders" },
  { t: "content_flows",            scope: "global", cat: "manual",         fills: "Devs crean flows" },
  { t: "flow_modules",             scope: "global", cat: "manual",         fills: "Devs configuran" },
  { t: "flow_technical_details",   scope: "global", cat: "manual",         fills: "Devs configuran" },
  { t: "flow_test_cases",          scope: "global", cat: "manual",         fills: "Devs prueban" },
  { t: "flow_collaborators",       scope: "global", cat: "manual",         fills: "Devs invitan" },
  { t: "flow_schedules",           scope: "org",   cat: "manual",          fills: "Usuario programa autopilot" },
  { t: "flow_runs",                scope: "org",   cat: "system",          fills: "Auto al ejecutar flow" },
  { t: "runs_inputs",              scope: "none",  cat: "system",          fills: "Auto por flow_run" },
  { t: "runs_outputs",             scope: "none",  cat: "system",          fills: "Auto por flow_run" },
  { t: "ui_component_templates",   scope: "global", cat: "manual",         fills: "Admin/seeders" },
  { t: "user_flow_favorites",      scope: "user",  cat: "manual",          fills: "Usuario marca favoritos" },

  // ─── Vera / Agentes ───
  { t: "ai_agents",                scope: "org",   cat: "system",          fills: "Auto al provisionar org (signal-webhook)" },
  { t: "ai_agent_runtime",         scope: "org",   cat: "system",          fills: "Auto al iniciar agente" },
  { t: "agent_queue_jobs",         scope: "org",   cat: "auto",            fills: "Encolado por signal-webhook al detectar señales" },
  { t: "mission_runs",             scope: "org",   cat: "system",          fills: "Auto cuando agente toma misión" },
  { t: "body_missions",            scope: "org",   cat: "auto",            fills: "Generadas por trigger_signal" },
  { t: "openclaw_instances",       scope: "org",   cat: "system",          fills: "Auto vía hetzner.provisioner" },
  { t: "provisioning_events",      scope: "org",   cat: "system",          fills: "Log de provisionamiento" },
  { t: "vera_pending_actions",     scope: "brand", cat: "auto",            fills: "Pipeline alignment + futuras heurísticas" },

  // ─── Chat / Conversaciones ───
  { t: "ai_conversations",         scope: "org",   cat: "system",          fills: "Auto al chatear con Vera" },
  { t: "ai_messages",              scope: "org",   cat: "system",          fills: "Auto al enviar msg" },
  { t: "ai_chat_actions",          scope: "none",  cat: "system",          fills: "Auto cuando Vera ejecuta acción" },
  { t: "ai_chat_context",          scope: "none",  cat: "system",          fills: "Auto al cargar contexto" },
  { t: "ai_brand_vectors",         scope: "brand", cat: "auto",            fills: "Embeddings de assets de la marca (si hay job de indexing)" },
  { t: "ai_global_vectors",        scope: "global", cat: "system",         fills: "Embeddings globales" },

  // ─── Outputs IA / Storage ───
  { t: "system_ai_outputs",        scope: "brand", cat: "system",          fills: "Cuando Vera/flows generan media" },
  { t: "storage_usage",            scope: "org",   cat: "system",          fills: "Tracker de storage" },

  // ─── Org / Auth ───
  { t: "organizations",            scope: "global", cat: "manual",         fills: "Onboarding" },
  { t: "organization_members",     scope: "org",   cat: "manual",          fills: "Onboarding + invitaciones" },
  { t: "organization_invitations", scope: "org",   cat: "manual",          fills: "Admin invita" },
  { t: "organization_features",    scope: "org",   cat: "manual",          fills: "Admin habilita features" },
  { t: "organization_credits",     scope: "org",   cat: "system",          fills: "Auto al cargar plan" },
  { t: "credit_usage",             scope: "org",   cat: "system",          fills: "Auto al consumir crédito" },
  { t: "subscriptions",            scope: "org",   cat: "system",          fills: "Auto al pagar" },
  { t: "profiles",                 scope: "global", cat: "manual",         fills: "Auto al sign-up + edición usuario" },
  { t: "user_notifications",       scope: "user",  cat: "system",          fills: "Auto" },
  { t: "developer_stats",          scope: "user",  cat: "system",          fills: "Auto" },
  { t: "developer_notifications",  scope: "user",  cat: "system",          fills: "Auto" },
  { t: "developer_logs",           scope: "global", cat: "system",         fills: "Auto" },
  { t: "system_metrics",           scope: "global", cat: "system",         fills: "Auto vía resource.governor" },

  // ─── CRM / Leads ───
  { t: "contact_leads",            scope: "global", cat: "manual",         fills: "Form público" },
  { t: "contact_lead_notes",       scope: "none",  cat: "manual",          fills: "Sales escribe notas" },

  // ─── Brand integrations ───
  { t: "brand_integrations",       scope: "brand", cat: "manual",          fills: "Usuario conecta OAuth en UI" },
];

console.log("Tabla".padEnd(34) + "Filas (brand)".padEnd(15) + "Filas (org)".padEnd(13) + "Filas (global)".padEnd(15) + "Categoría");
console.log("=".repeat(110));

const summary = { auto_OK: [], auto_EMPTY: [], manual_filled: [], manual_empty: [], system: [], feature_missing: [] };

for (const row of TABLES) {
  let brandCount = "—", orgCount = "—", globalCount = "—";
  try {
    if (row.scope === "brand") {
      const { count } = await sb.from(row.t).select("*", { count: "exact", head: true }).eq("brand_container_id", brandId);
      brandCount = count != null ? String(count) : "ERR";
    } else if (row.scope === "org") {
      const { count } = await sb.from(row.t).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
      orgCount = count != null ? String(count) : "ERR";
    } else if (row.scope === "global" || row.scope === "user" || row.scope === "none") {
      const { count } = await sb.from(row.t).select("*", { count: "exact", head: true });
      globalCount = count != null ? String(count) : "ERR";
    }
  } catch (e) {
    brandCount = "ERR"; orgCount = "ERR"; globalCount = "ERR";
  }

  console.log(row.t.padEnd(34) + brandCount.padEnd(15) + orgCount.padEnd(13) + globalCount.padEnd(15) + row.cat);

  // Clasificar para summary
  const total = parseInt(brandCount) || parseInt(orgCount) || parseInt(globalCount) || 0;
  const isEmpty = total === 0;
  const item = { t: row.t, fills: row.fills, count: total };
  if (row.cat === "auto" || row.cat === "auto+manual") {
    if (isEmpty) summary.auto_EMPTY.push(item); else summary.auto_OK.push(item);
  } else if (row.cat === "manual") {
    if (isEmpty) summary.manual_empty.push(item); else summary.manual_filled.push(item);
  } else if (row.cat === "feature_missing") {
    summary.feature_missing.push(item);
  } else {
    summary.system.push(item);
  }
}

console.log("\n" + "═".repeat(110));
console.log("📊 RESUMEN POR CATEGORÍA");
console.log("═".repeat(110));

console.log("\n✅ AUTO-pobladas funcionando (" + summary.auto_OK.length + "):");
for (const i of summary.auto_OK) console.log("   • " + i.t + " (" + i.count + " filas) — " + i.fills);

console.log("\n🔴 AUTO que deberían poblarse pero están vacías (" + summary.auto_EMPTY.length + "):");
for (const i of summary.auto_EMPTY) console.log("   • " + i.t + " — " + i.fills);

console.log("\n🚫 FEATURE FALTANTE — sin sensor implementado (" + summary.feature_missing.length + "):");
for (const i of summary.feature_missing) console.log("   • " + i.t + " — " + i.fills);

console.log("\n👤 MANUAL llenas (" + summary.manual_filled.length + ", usuario/admin las llena):");
for (const i of summary.manual_filled) console.log("   • " + i.t + " (" + i.count + ")");

console.log("\n👤 MANUAL vacías (" + summary.manual_empty.length + ", esperan acción del usuario):");
for (const i of summary.manual_empty) console.log("   • " + i.t + " — " + i.fills);
