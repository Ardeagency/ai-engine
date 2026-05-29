/**
 * Comfy Flow Runner — FEAT-033 (puente ai-engine <> content-flows)
 * Consume comfy_flow_jobs, carga el graph+bindings del flow, y lo ejecuta via el
 * dispatcher de content-flows (que normaliza UI->API, aplica inputs por tenant y balancea).
 * Patron clonado de job-worker.service.js (lock + poll + retry + stale-recovery).
 * INERTE salvo COMFY_BRIDGE_ENABLED === "true". NO toca flows n8n (execution_type=webhook).
 */
import { createClient } from "@supabase/supabase-js";
import { resolvePromptBindings } from "./prompt-resolver.service.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

const WORKER_ID        = `comfy_${process.pid}_${Date.now()}`;
const POLL_INTERVAL_MS = 10_000;
const LOCK_TTL_MIN     = 10;
const MAX_CONCURRENT   = 5;
const DISPATCHER_URL   = process.env.DISPATCHER_URL || "https://comfyui.aismartcontent.io";
const DISPATCHER_TOKEN = process.env.DISPATCHER_TOKEN || "";

let _active = 0, _timer = null;

async function tryLockJob(id) {
  const { data } = await supabase.from("comfy_flow_jobs")
    .update({ status: "assigned", locked_by: WORKER_ID, locked_at: new Date().toISOString(), started_at: new Date().toISOString() })
    .eq("id", id).eq("status", "queued").is("locked_by", null).select().maybeSingle();
  return data || null;
}
async function releaseStaleJobs() {
  const cutoff = new Date(Date.now() - LOCK_TTL_MIN * 60_000).toISOString();
  await supabase.from("comfy_flow_jobs").update({ status: "queued", locked_by: null, locked_at: null })
    .eq("status", "assigned").lt("locked_at", cutoff).neq("locked_by", WORKER_ID);
}
async function markDone(job, runId, result) {
  await supabase.from("comfy_flow_jobs").update({ status: "completed", completed_at: new Date().toISOString(), output_run_id: runId, result }).eq("id", job.id);
}
async function markFailed(job, msg) {
  const attempts = (job.attempts || 0) + 1, final = attempts >= (job.max_attempts || 3);
  await supabase.from("comfy_flow_jobs").update({ status: final ? "failed" : "queued", attempts, locked_by: null, locked_at: null,
    error_message: String(msg).slice(0, 500), run_after: new Date(Date.now() + 30_000).toISOString() }).eq("id", job.id);
}

// Carga la definicion del flow (graph UI + bindings campo->nodos) desde comfy_flow_definitions.
async function loadFlowDef(slug) {
  const { data } = await supabase.from("comfy_flow_definitions").select("content_flow_id, graph, bindings, prompt_slots").eq("slug", slug).maybeSingle();
  if (!data) throw new Error(`flow def no encontrada: ${slug}`);
  return { contentFlowId: data.content_flow_id, graph: data.graph, bindings: data.bindings || {}, promptSlots: data.prompt_slots || [] };
}

async function dispatch(path, body) {
  const res = await fetch(`${DISPATCHER_URL}${path}`, { method: "POST",
    headers: { "Authorization": `Bearer ${DISPATCHER_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`dispatcher ${path} -> ${res.status}`);
  return res.json();
}
async function getHistory(promptId, worker) {
  const u = `${DISPATCHER_URL}/history/${promptId}?worker=${encodeURIComponent(worker)}`;
  const res = await fetch(u, { headers: { "Authorization": `Bearer ${DISPATCHER_TOKEN}` } });
  return res.ok ? res.json() : {};
}

// FEAT-033/034 persistencia enriquecida: baja outputs -> Supabase -> runs_outputs (prompt/modelo/params/producto) + runs_inputs + creditos
async function fetchView(worker, filename, subfolder) {
  const u = `${DISPATCHER_URL}/view?worker=${encodeURIComponent(worker)}&filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || "")}&type=output`;
  const r = await fetch(u, { headers: { "Authorization": `Bearer ${DISPATCHER_TOKEN}` } });
  if (!r.ok) throw new Error(`view ${filename} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function kieCredits() {
  try {
    const r = await fetch(`${DISPATCHER_URL}/kie-credits`, { headers: { "Authorization": `Bearer ${DISPATCHER_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.credits === "number" ? d.credits : null;
  } catch { return null; }
}

// FEAT-036: cuenta nodos KIE_* del graph (cada uno dispara un createTask contra el
// limite global de KIE: 20/10s POR CUENTA). Soporta formato UI (nodes[].type) o API
// ({id:{class_type}}). Cuenta sobre la definicion cruda (puede sobre-contar nodos que
// el dispatcher prune; sobre-contar = mas throttle = mas seguro para KIE).
function countKieNodes(graph) {
  try {
    if (graph && Array.isArray(graph.nodes)) {
      return graph.nodes.filter(n => String(n?.type || "").startsWith("KIE_")).length;
    }
    if (graph && typeof graph === "object") {
      return Object.values(graph).filter(n => String(n?.class_type || "").startsWith("KIE_")).length;
    }
  } catch { /* noop */ }
  return 0;
}

// FEAT-036: reserva cupo en el MISMO token bucket Postgres que usa el frontend
// (RPC kie_rate_acquire). Pide token a token (robusto si cost > capacidad). Background
// => presupuesto de espera generoso (el bucket refilla 1.8/s). Fail-open si la RPC no
// existe/falla, para no romper Path B. Devuelve false si agota el presupuesto.
async function acquireKieSlots(cost, maxWaitMs = 60_000) {
  if (!cost || cost < 1) return true;
  const deadline = Date.now() + maxWaitMs;
  let remaining = cost;
  while (remaining > 0) {
    let data = null;
    try {
      const { data: d, error } = await supabase.rpc("kie_rate_acquire", { p_provider: "kie", p_cost: 1 });
      if (error) return true; // RPC no disponible -> fail-open
      data = d;
    } catch { return true; }
    if (data && data.acquired) { remaining--; continue; }
    const retry = Math.min(Math.max(Number(data?.retry_after_ms) || 250, 100), 1500);
    if (Date.now() + retry > deadline) return false;
    await new Promise(r => setTimeout(r, retry));
  }
  return true;
}

// Resuelve entity_ids (identities) -> {entity_id, name, image_url} (producto+imagen). Orden preservado.
async function resolveIdentities(entityIds) {
  const ids = (entityIds || []).filter(x => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x));
  if (!ids.length) return [];
  const { data } = await supabase.from("products").select("entity_id, nombre_producto, product_images(image_url, image_order)").in("entity_id", ids);
  const by = {};
  (data || []).forEach(pr => { const img = (pr.product_images || []).slice().sort((a,b)=>(a.image_order||0)-(b.image_order||0))[0]; by[pr.entity_id] = { entity_id: pr.entity_id, name: pr.nombre_producto, image_url: img ? img.image_url : null }; });
  return ids.map(id => by[id]).filter(Boolean);
}

const MODEL_MAP = { KIE_NanoBananaPro_Image: "nano-banana-pro", KIE_NanoBanana2_Image: "nano-banana-2", KIE_GPTImage2_I2I: "gpt-image-2", KIE_GPTImage2_T2I: "gpt-image-2", KIE_Kling3_Video: "kling-3.0", KIE_Seedance2_Video: "seedance-2" };
function modelFor(ct) { return MODEL_MAP[ct] || (String(ct).startsWith("KIE_") ? String(ct).replace("KIE_", "").toLowerCase() : ct); }
// Costo en creditos por modelo (CALIBRAR contra pricing real de KIE). 1 credito ~= 1 USD.
const CREDIT_RATE = { "nano-banana-pro": 15, "nano-banana-2": 10, "gpt-image-2": 12, "kling-3.0": 40, "seedance-2": 35, default: 10 };

// traza el nodo generador (KIE con prompt) siguiendo el input images
function findGenNode(api, nodeId, depth = 0) {
  const n = api?.[String(nodeId)];
  if (!n || depth > 6) return null;
  if (String(n.class_type).startsWith("KIE_") && n.inputs && n.inputs.prompt !== undefined) return n;
  const src = n.inputs?.images;
  if (Array.isArray(src) && src.length === 2) return findGenNode(api, src[0], depth + 1);
  return null;
}

async function persistOutputs(job, def, worker, outputs, apiGraph, realCost, identities) {
  const bc = job.brand_container_id, inp = job.inputs || {}, userId = job.user_id || null;
  const { data: run } = await supabase.from("flow_runs").insert({ flow_id: def.contentFlowId, organization_id: job.organization_id, brand_id: bc, user_id: userId, status: "completed" }).select("id").maybeSingle();
  const runId = run?.id || null;
  // briefing
  const briefInputs = { ...inp }; delete briefInputs.productos; delete briefInputs.referencias_estilo;
  if (Array.isArray(identities) && identities.length) briefInputs.identities = identities;
  await supabase.from("runs_inputs").insert({ run_id: runId, organization_id: job.organization_id, input_data: briefInputs, metadata: { flow_slug: job.flow_slug, source: job.source } }).then(()=>{}, ()=>{});
  const date = new Date().toISOString().slice(0, 10), batch = "batch_comfy_" + Date.now();
  const entityMap = inp.entity_map || {};
  let count = 0, cost = 0;
  for (const [nid, o] of Object.entries(outputs || {})) {
    const media = [...(o.images || []).map(x => ({ ...x, ot: "image", ct: "image/png" })), ...(o.gifs || []).map(x => ({ ...x, ot: "video", ct: "image/gif" })), ...(o.videos || []).map(x => ({ ...x, ot: "video", ct: "video/mp4" }))];
    for (const m of media) {
      if (m.type !== "output") continue;
      try {
        const bytes = await fetchView(worker, m.filename, m.subfolder);
        const objPath = `${bc}/${date}/${batch}/${m.filename}`;
        await supabase.storage.from("production-outputs").upload(objPath, bytes, { contentType: m.ct, upsert: true });
        const gen = findGenNode(apiGraph, nid);
        const model = gen ? modelFor(gen.class_type) : "comfy";
        cost += (CREDIT_RATE[model] ?? CREDIT_RATE.default);
        const prefix = String(m.filename).split("_")[0];
        await supabase.from("runs_outputs").insert({
          output_type: m.ot === "video" ? "video" : "ai_content", status: "completed", provider: "comfy",
          storage_path: `production-outputs/${objPath}`, organization_id: job.organization_id, brand_container_id: bc, run_id: runId,
          prompt_used: gen?.inputs?.prompt || null, models: [model],
          technical_params: gen ? { aspect_ratio: gen.inputs?.aspect_ratio, resolution: gen.inputs?.resolution, output_format: gen.inputs?.output_format } : null,
          reference_image_url: (inp.productos && inp.productos[0]) || null, entity_id: entityMap[prefix] || inp.entity_id || null,
          metadata: { node: nid, flow_slug: job.flow_slug, variant: prefix },
        });
        count++;
      } catch (e) { console.warn("persist", m.filename, e.message); }
    }
  }
  if (count > 0) {
    const finalCost = (typeof realCost === "number" && realCost > 0) ? realCost : cost;  // costo REAL de KIE (diff balance); estimado solo fallback
    try { await supabase.rpc("observe_flow_credit", { p_flow_id: def.contentFlowId, p_amount: finalCost }); } catch (e) { console.warn("observe_flow_credit:", e.message); }
    try { await supabase.rpc("use_credits", { p_organization_id: job.organization_id, p_user_id: userId, p_credits_needed: Math.ceil(finalCost), p_operation_type: "comfy_flow", p_description: `${job.flow_slug} (${count} outputs, ${finalCost} cr ${(typeof realCost==="number"&&realCost>0)?"real":"est"})` }); } catch (e) { console.warn("use_credits:", e.message); }
  }
  return runId;
}

async function processJob(job) {
  _active++;
  try {
    const def = await loadFlowDef(job.flow_slug);
    let bindings = { ...(def.bindings || {}) };
    // FEAT-034: prompts dinamicos por tenant -> set_widget bindings
    if (Array.isArray(def.promptSlots) && def.promptSlots.length) {
      const ctx = { product: job.inputs?.product || {}, brandBrief: job.inputs?.brand_brief, hardConstraints: job.inputs?.hard_constraints };
      const { bindings: pb } = await resolvePromptBindings(def.promptSlots, ctx);
      bindings = { ...bindings, ...pb };
    }
    const identities = await resolveIdentities(job.inputs?.productos || []);
    const dispatchInputs = { ...(job.inputs || {}) };
    if (identities.length) dispatchInputs.productos = identities.map(i => i.image_url).filter(Boolean);
    const creditsBefore = await kieCredits();
    // FEAT-036: reservar cupo KIE (1 token por nodo KIE_* = 1 createTask) antes de
    // dispatchar, compartiendo bucket con el frontend. Sin cupo tras el presupuesto =>
    // re-encolar suave SIN quemar intento (es trabajo background, puede esperar).
    const kieNodes = countKieNodes(def.graph);
    if (kieNodes > 0) {
      const got = await acquireKieSlots(kieNodes);
      if (!got) {
        await supabase.from("comfy_flow_jobs").update({ status: "queued", locked_by: null, locked_at: null,
          run_after: new Date(Date.now() + 15_000).toISOString() }).eq("id", job.id);
        console.warn(`comfy-runner: job ${job.id} re-encolado (KIE rate busy, ${kieNodes} nodos KIE)`);
        return;
      }
    }
    const sub = await dispatch("/run-flow", { graph: def.graph, inputs: dispatchInputs, bindings, client_id: job.id });
    const promptId = sub?.comfy?.prompt_id;
    if (!promptId) throw new Error(`sin prompt_id: ${JSON.stringify(sub?.comfy || sub).slice(0, 200)}`);

    let outputs = null;
    for (let i = 0; i < 180; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const h = await getHistory(promptId, sub.worker);
      const st = h?.[promptId]?.status;
      if (st?.completed === true) { outputs = h[promptId].outputs; break; }
      if (st?.status_str === "error") throw new Error("ComfyUI exec error");
    }
    if (!outputs) throw new Error("timeout esperando ComfyUI");

    const creditsAfter = await kieCredits();
    const realCost = (creditsBefore != null && creditsAfter != null) ? Math.max(0, creditsBefore - creditsAfter) : null;
    const runId = await persistOutputs(job, def, sub.worker, outputs, sub.api, realCost, identities);
    await markDone(job, runId, { promptId, worker: sub.worker, nodes: sub.nodes });
  } catch (e) {
    await markFailed(job, e.message);
  } finally { _active--; }
}

async function pollJobs() {
  await releaseStaleJobs().catch(() => {});
  const free = MAX_CONCURRENT - _active;
  if (free <= 0) return;
  const { data: jobs } = await supabase.from("comfy_flow_jobs").select("*").eq("status", "queued").is("locked_by", null)
    .lte("run_after", new Date().toISOString()).order("priority", { ascending: false }).order("run_after", { ascending: true }).limit(free);
  for (const job of jobs || []) {
    const locked = await tryLockJob(job.id);
    if (locked) processJob(locked).catch(e => console.error("comfy-runner:", e.message));
  }
}

export function startComfyFlowRunner() {
  if (process.env.COMFY_BRIDGE_ENABLED !== "true") { console.log("comfy-flow-runner: DESACTIVADO"); return; }
  if (_timer) return;
  const poll = async () => { try { await pollJobs(); } catch (e) { console.warn("comfy-runner poll:", e.message); } _timer = setTimeout(poll, POLL_INTERVAL_MS); };
  poll();
  console.log(`comfy-flow-runner: iniciado (id=${WORKER_ID}, dispatcher=${DISPATCHER_URL})`);
}
export function stopComfyFlowRunner() { if (_timer) { clearTimeout(_timer); _timer = null; } }

// Helper para encolar (lo usan webhook y la tool de VERA)
export async function enqueueComfyFlow({ organizationId, brandContainerId, scheduleId, flowSlug, inputs, source = "user" }) {
  const { data, error } = await supabase.from("comfy_flow_jobs").insert({
    organization_id: organizationId, brand_container_id: brandContainerId, schedule_id: scheduleId,
    flow_slug: flowSlug, inputs: inputs || {}, source,
  }).select("id").maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id;
}
