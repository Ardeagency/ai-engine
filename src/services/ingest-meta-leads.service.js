/**
 * ingest-meta-leads.service.js — trae los LEADS de Meta Lead Ads para ANALIZARLOS,
 * NO para ser un CRM (fila 19). Funcional + GATED.
 *
 * AISC hoy no usa los leadgen. Este servicio, con el Page Access Token ya guardado
 * en brand_integrations (+ permiso leads_retrieval + appsecret_proof), lee
 * /{page_id}/leadgen_forms y /{form_id}/leads, y persiste SOLO metadata de routing
 * (form/campaign/adset/ad/created_time) + respuestas de CALIFICACION no-PII en
 * meta_leads. NUNCA guarda PII de contacto (nombre/email/telefono/direccion): el
 * schema de meta_leads no tiene esas columnas y aqui se filtran explicitamente.
 *
 * GATED: si la marca no tiene integracion facebook, o el token no tiene
 * leads_retrieval, hace NO-OP LIMPIO (devuelve {gated:true, reason}) sin romper.
 * El permiso leads_retrieval requiere Meta App Review por cliente; el scheduler
 * (start/stop) queda listo pero NO auto-arranca hasta META_LEADS_INGEST_ENABLED=true.
 *
 * Alimenta analyze_lead_intelligence (CPL real) y a Vera: resultado de negocio real,
 * no engagement.
 */
import crypto from "crypto";
import { supabase } from "../lib/supabase.js";
import { getIntegrationToken } from "../lib/integration-token.js";

const META_GRAPH_BASE = "https://graph.facebook.com/v22.0";
const APP_SECRET = () => process.env.META_APP_SECRET || "";
// Igual que sync-meta-ad-insights: appsecret_proof solo si el flag lo exige (default
// off en prod; enviarlo sin que el app lo requiera da "Invalid appsecret_proof").
const REQUIRE_PROOF = String(process.env.META_REQUIRE_APPSECRET_PROOF || "").toLowerCase() === "true";

// Nombres de campo de Meta Lead Ads que son PII de contacto → NUNCA se persisten.
const PII_FIELDS = new Set([
  "email", "work_email", "phone_number", "work_phone_number", "phone",
  "full_name", "first_name", "last_name", "name", "user_first_name", "user_last_name",
  "street_address", "city", "state", "province", "zip_postal_code", "post_code",
  "country", "dob", "date_of_birth", "gender", "id_number", "national_id",
  "marital_status", "relationship_status", "military_status",
]);

// Codigos de error Meta que significan "no tienes el permiso" → gate, no crash.
const PERMISSION_CODES = new Set([10, 200, 190, 100, 3]);

async function _metaGet(path, token, params = {}) {
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", token);
  if (REQUIRE_PROOF && APP_SECRET()) {
    const proof = crypto.createHmac("sha256", APP_SECRET()).update(token).digest("hex");
    url.searchParams.set("appsecret_proof", proof);
  }
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (json?.error) {
    const err = new Error(`Meta API: ${json.error.message || json.error.type}`);
    err.code = json.error.code;
    err.subcode = json.error.error_subcode;
    err.isPermission = PERMISSION_CODES.has(json.error.code) || /permission|leads_retrieval|scope/i.test(json.error.message || "");
    throw err;
  }
  return json;
}

async function _resolvePageToken(userToken, metadata) {
  const accounts = await _metaGet("/me/accounts", userToken, { fields: "id,name,access_token", limit: 50 });
  const pages = accounts?.data || [];
  if (!pages.length) return null;
  const wantId = metadata?.selected_page_id || metadata?.pages?.[0]?.id;
  const page = wantId ? pages.find((p) => p.id === String(wantId)) : pages[0];
  return page ? { pageId: page.id, pageName: page.name, pageToken: page.access_token } : null;
}

// Filtra field_data → solo respuestas de calificacion NO-PII (para analisis, no CRM).
function _qualifyingFields(fieldData) {
  const out = {};
  for (const f of fieldData || []) {
    const key = String(f.name || "").toLowerCase();
    if (!key || PII_FIELDS.has(key)) continue;                 // descarta PII de contacto
    if (/email|phone|tel|name|nombre|correo|direccion|address|cedula|dni|dob|birth/i.test(key)) continue;
    const val = Array.isArray(f.values) ? f.values.slice(0, 3) : f.values;
    out[key] = val;                                            // respuesta de calificacion (ej. presupuesto, interes)
  }
  return out;
}

/**
 * ingestMetaLeadsForBrand — ingesta gateada de leads de una marca.
 * @returns {{gated:boolean, reason?:string, forms?:number, leads_ingested?:number, brand_container_id?:string}}
 */
export async function ingestMetaLeadsForBrand(brandContainerId, organizationId, opts = {}) {
  const sinceDays = Math.max(1, Math.min(Number(opts.sinceDays) || 30, 90));
  const maxFormsLeads = Math.max(1, Math.min(Number(opts.maxLeadsPerForm) || 200, 500));

  // 1. Integracion facebook (gate suave)
  let integ;
  try {
    integ = await getIntegrationToken(brandContainerId, organizationId, "facebook");
  } catch (e) {
    if (e.noIntegration || e.statusCode === 404) return { gated: true, reason: "sin integracion facebook activa" };
    throw e;
  }

  // 2. Page token
  let page;
  try {
    page = await _resolvePageToken(integ.access_token, integ.metadata);
  } catch (e) {
    if (e.isPermission) return { gated: true, reason: `token sin permiso de paginas: ${e.message}` };
    throw e;
  }
  if (!page) return { gated: true, reason: "no hay pagina de Facebook resoluble" };

  // 3. leadgen_forms (aqui pega el gate de leads_retrieval)
  let forms;
  try {
    const r = await _metaGet(`/${page.pageId}/leadgen_forms`, page.pageToken, { fields: "id,name,status", limit: 100 });
    forms = (r?.data || []).filter((f) => (f.status || "ACTIVE") === "ACTIVE");
  } catch (e) {
    if (e.isPermission) return { gated: true, reason: `leads_retrieval no disponible para esta marca (Meta App Review pendiente): ${e.message}` };
    throw e;
  }
  if (!forms.length) return { gated: false, forms: 0, leads_ingested: 0, brand_container_id: brandContainerId, reason: "sin formularios de leadgen" };

  // 4. leads por formulario
  const sinceTs = Math.floor((Date.now() - sinceDays * 86400000) / 1000);
  let ingested = 0;
  for (const form of forms) {
    let leads;
    try {
      const r = await _metaGet(`/${form.id}/leads`, page.pageToken, {
        fields: "id,created_time,ad_id,adset_id,campaign_id,platform,is_organic,field_data",
        limit: maxFormsLeads,
        filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceTs }]),
      });
      leads = r?.data || [];
    } catch (e) {
      if (e.isPermission) return { gated: true, reason: `leads_retrieval no disponible (form ${form.id}): ${e.message}` };
      console.warn(`[meta-leads] form ${form.id} leads: ${e.message}`);
      continue;
    }
    if (!leads.length) continue;

    // dedupe: no re-insertar lead_id ya guardado
    const ids = leads.map((l) => l.id);
    const { data: existing } = await supabase.from("meta_leads").select("lead_id").in("lead_id", ids);
    const seen = new Set((existing || []).map((e) => e.lead_id));

    const rows = leads.filter((l) => !seen.has(l.id)).map((l) => ({
      organization_id:     organizationId,
      brand_container_id:  brandContainerId,
      integration_id:      integ.id,
      lead_id:             l.id,
      form_id:             form.id,
      form_name:           form.name || null,
      external_campaign_id: l.campaign_id || null,
      external_adset_id:   l.adset_id || null,
      external_ad_id:      l.ad_id || null,
      platform:            l.platform || "facebook",
      is_organic:          Boolean(l.is_organic),
      lead_created_time:   l.created_time || null,
      qualifying_fields:   _qualifyingFields(l.field_data),   // SIN PII
      quality:             null,
      captured_at:         new Date().toISOString(),
    }));
    if (rows.length) {
      const { error } = await supabase.from("meta_leads").insert(rows);
      if (error) console.warn(`[meta-leads] insert form ${form.id}: ${error.message}`);
      else ingested += rows.length;
    }
  }

  return { gated: false, forms: forms.length, leads_ingested: ingested, brand_container_id: brandContainerId };
}

// ── Scheduler (listo pero NO auto-arranca hasta META_LEADS_INGEST_ENABLED=true) ──
let _timer = null;
const INTERVAL_MS = parseInt(process.env.META_LEADS_INGEST_INTERVAL_MS || "21600000", 10); // 6h

async function _cycle() {
  const { data: integs } = await supabase
    .from("brand_integrations")
    .select("brand_container_id, brand_containers!inner(organization_id)")
    .eq("platform", "facebook").eq("is_active", true);
  let gatedN = 0, okN = 0;
  for (const it of integs || []) {
    try {
      const r = await ingestMetaLeadsForBrand(it.brand_container_id, it.brand_containers.organization_id, {});
      if (r.gated) gatedN++; else okN += (r.leads_ingested || 0);
    } catch (e) { console.warn(`[meta-leads] ciclo brand=${it.brand_container_id}: ${e.message}`); }
  }
  console.log(`[meta-leads] ciclo: ${okN} leads ingeridos, ${gatedN} marcas gated (sin permiso/integracion)`);
}

export function startMetaLeadsIngestion(intervalMs = INTERVAL_MS) {
  if (process.env.META_LEADS_INGEST_ENABLED !== "true") {
    console.log("meta-leads: ingesta DESACTIVADA (META_LEADS_INGEST_ENABLED!=true) — se activa tras Meta App Review de leads_retrieval");
    return;
  }
  if (_timer) return;
  console.log(`meta-leads: ingesta iniciada (cada ${intervalMs / 60000} min, primera corrida en 120s)`);
  setTimeout(() => _cycle().catch((e) => console.warn(`[meta-leads] primera corrida: ${e.message}`)), 120000);
  _timer = setInterval(() => _cycle().catch((e) => console.warn(`[meta-leads] ciclo: ${e.message}`)), intervalMs);
}

export function stopMetaLeadsIngestion() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
