/**
 * Herramientas de lectura de flows y ejecuciones.
 * brandContainerId es OPCIONAL — si no se pasa, se auto-descubre desde organizationId.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { enqueueComfyFlow } from "../services/comfy-flow-runner.service.js";

async function getBrandIdsForOrg(brandContainerId, organizationId) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data: brands } = await supabase
    .from("brands")
    .select("id")
    .eq("project_id", bc.id);

  return { bc, brandIds: (brands || []).map((b) => b.id) };
}

/**
 * Flujos disponibles en el catálogo público (no requiere org).
 */
export async function getAvailableFlows(filters = {}, organizationId = null) {
  let query = supabase
    .from("content_flows")
    .select(
      "id, name, description, output_type, flow_category_type, flow_image_url, " +
      "execution_mode, execution_strategy, token_cost, likes_count, saves_count, run_count, slug"
    )
    .eq("is_active", true)
    .eq("show_in_catalog", true);

  if (filters.category_type) query = query.eq("flow_category_type", filters.category_type);
  if (filters.output_type) query = query.eq("output_type", filters.output_type);

  const { data, error } = await query.order("run_count", { ascending: false }).limit(30);
  if (error) throw error;
  const flows = Array.isArray(data) ? data : [];
  if (!flows.length) return flows;

  // Tarjeta liviana (anti-saturacion de tokens): NO adjuntamos los inputs aqui.
  // Vera elige un flow por su tarjeta y luego pide sus inputs con getFlowInputs.
  // Marcamos cuales ya tiene guardados la org.
  if (organizationId) {
    try {
      const { data: saves } = await supabase
        .from("org_flow_saves")
        .select("flow_id")
        .eq("organization_id", organizationId);
      const savedSet = new Set((saves || []).map((s) => s.flow_id));
      for (const f of flows) f.saved_in_org = savedSet.has(f.id);
    } catch (_) { /* best-effort */ }
  }
  return flows;
}

/**
 * Inputs que un flow especifico requiere (paso 2 del descubrimiento). Se llama
 * SOLO cuando Vera ya eligio un flow por su tarjeta — asi el catalogo no carga
 * los inputs de todos los flows y no se satura el contexto.
 */
export async function getFlowInputs(flowId, brandContainerId, organizationId) {
  if (!flowId) throw new Error("getFlowInputs: flowId es requerido");
  const { data: flow } = await supabase
    .from("content_flows")
    .select("id, name, slug, output_type, execution_mode, execution_strategy, token_cost")
    .eq("id", flowId)
    .maybeSingle();
  if (!flow) throw new Error(`getFlowInputs: flow ${flowId} no encontrado`);

  const { data: modules } = await supabase
    .from("flow_modules")
    .select("input_schema, is_human_approval_required")
    .eq("content_flow_id", flowId)
    .eq("step_order", 1);
  const fields = Array.isArray(modules?.[0]?.input_schema?.fields) ? modules[0].input_schema.fields : [];

  return {
    flow_id: flow.id,
    name: flow.name,
    slug: flow.slug,
    output_type: flow.output_type,
    execution_mode: flow.execution_mode,
    execution_strategy: flow.execution_strategy,
    token_cost: flow.token_cost,
    is_sequential: Boolean(modules?.[0]?.is_human_approval_required) || flow.execution_strategy === "sequential",
    inputs: fields.map((fld) => ({
      key: fld.key,
      label: fld.label || fld.key,
      required: Boolean(fld.required),
      input_type: fld.input_type || fld.type || null,
      options: Array.isArray(fld.options) ? fld.options.map((o) => o.value).filter((v) => v !== "") : undefined,
      placeholder: fld.placeholder || undefined,
    })),
  };
}

export async function getFlowSchedules(brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) return [];

  const { data, error } = await supabase
    .from("flow_schedules")
    .select("id, flow_id, brand_id, cron_expression, status, production_count, aspect_ratio, created_at")
    .in("brand_id", brandIds)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getFlowRuns(brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) return [];

  const { data, error } = await supabase
    .from("flow_runs")
    .select("id, flow_id, brand_id, status, created_at, tokens_consumed, is_paused")
    .in("brand_id", brandIds)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getFlowRunOutputs(runId, brandContainerId, organizationId) {
  const { brandIds } = await getBrandIdsForOrg(brandContainerId, organizationId);
  if (!brandIds.length) {
    throw Object.assign(new Error("No hay brands en esta org"), { statusCode: 404 });
  }

  // Verifica que el run pertenece a esta org
  const { data: run } = await supabase
    .from("flow_runs")
    .select("id, brand_id")
    .eq("id", runId)
    .in("brand_id", brandIds)
    .maybeSingle();

  if (!run) {
    throw Object.assign(
      new Error("flow_run no encontrado para esta organización"),
      { statusCode: 404 }
    );
  }

  const { data, error } = await supabase
    .from("runs_outputs")
    .select("id, output_type, text_content, generated_copy, generated_hashtags, created_at")
    .eq("run_id", runId)
    .limit(10);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}


// Dispara (encola) un flow ComfyUI para esta org. FEAT-033. Lo usa VERA y el webhook.
export async function runContentFlow({ flowSlug, inputs, organizationId, brandContainerId } = {}) {
  if (!flowSlug) throw new Error("flowSlug requerido");
  const jobId = await enqueueComfyFlow({ organizationId, brandContainerId, flowSlug, inputs: inputs || {}, source: "vera" });
  return { enqueued: true, jobId, flowSlug };
}


// ── Fase 2: Vera como aprobador de etapas en flujos secuenciales/multimodales ──
// La orquestacion secuencial vive en flow_runs (is_paused, current_module_order)
// + rpc_advance_run_stage (lo que el humano de Studio dispara al aprobar). Estas
// dos tools sientan a Vera en esa silla: ver runs pausados y aprobar/ajustar.

// Runs pausados esperando la decision de Vera, con el output de la etapa actual
// (imagen/guion/copy + rationale) para que lo revise. El output_id es lo que
// luego se pasa a approveRunStage.
export async function getRunsAwaitingApproval(brandContainerId, organizationId) {
  const { data: runs, error } = await supabase
    .from("flow_runs")
    .select("id, flow_id, status, current_module_order, total_modules_count, step_history, created_at")
    .eq("organization_id", organizationId)
    .eq("is_paused", true)
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) throw error;
  if (!Array.isArray(runs) || !runs.length) return [];

  const flowIds = [...new Set(runs.map((r) => r.flow_id).filter(Boolean))];
  const namesById = {};
  if (flowIds.length) {
    const { data: flows } = await supabase
      .from("content_flows").select("id, name, output_type").in("id", flowIds);
    for (const f of flows || []) namesById[f.id] = f;
  }

  const out = [];
  for (const r of runs) {
    const { data: outputs } = await supabase
      .from("runs_outputs")
      .select("id, output_type, storage_path, text_content, generated_copy, creative_rationale, flow_module_id, created_at")
      .eq("run_id", r.id)
      .order("created_at", { ascending: false })
      .limit(6);
    out.push({
      run_id: r.id,
      flow: namesById[r.flow_id]?.name || null,
      etapa_actual: r.current_module_order,
      de_etapas: r.total_modules_count,
      created_at: r.created_at,
      outputs_a_revisar: (outputs || []).map((o) => ({
        output_id: o.id,
        tipo: o.output_type,
        asset: o.storage_path || null,
        texto: o.text_content || o.generated_copy || null,
        rationale: o.creative_rationale || null,
      })),
    });
  }
  return out;
}

// Vera aprueba (y opcionalmente ajusta con edits) la etapa actual de un run
// pausado -> avanza a la siguiente. Reusa rpc_advance_run_stage, la MISMA que
// dispara el humano en Studio. Mueve un run de produccion real -> requiere consent.
export async function approveRunStage(params = {}, brandContainerId, organizationId) {
  const runId = params.runId || params.run_id;
  if (!runId) throw new Error("approveRunStage: runId es requerido");

  const { data: run } = await supabase
    .from("flow_runs")
    .select("id, current_module_order, is_paused, organization_id")
    .eq("id", runId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!run) {
    throw Object.assign(new Error("flow_run no encontrado para esta organizacion"), { statusCode: 404 });
  }
  if (!run.is_paused) {
    throw new Error("approveRunStage: el run no esta pausado esperando aprobacion");
  }

  const fromOrder = params.fromOrder ?? params.from_order ?? run.current_module_order;

  let approvedOutputId = params.approvedOutputId || params.approved_output_id || null;
  if (!approvedOutputId) {
    const { data: latest } = await supabase
      .from("runs_outputs").select("id").eq("run_id", runId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    approvedOutputId = latest?.id || null;
  }

  const { data, error } = await supabase.rpc("rpc_advance_run_stage", {
    p_run_id: runId,
    p_from_order: fromOrder,
    p_approved_output_id: approvedOutputId,
    p_edits: params.edits || {},
  });
  if (error) throw new Error(`approveRunStage: ${error.message}`);
  return { advanced: true, run_id: runId, from_order: fromOrder, approved_output_id: approvedOutputId, result: data };
}
