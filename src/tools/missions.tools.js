/**
 * missions.tools.js — Misiones de VERA: los PASOS de una estrategia.
 *
 * MODELO (JC+Shenoa 2026-07-17):
 *   estrategia (canvas_strategies) = el OBJETIVO que VERA avanza entre sesiones.
 *   misiones   (body_missions)     = los PASOS ordenados (investigar/buscar/crear…),
 *                                    con strategy_id = la estrategia padre y seq = orden.
 *   Una misión que MUTA (crear campaña/audiencia) enlaza a su Tarea atómica
 *   (vera_pending_actions) vía pending_action_id → el humano la ve/cancela.
 *
 * RETOMAR: VERA lee getOpenMissions al inicio de sesión y continúa los pasos
 * pendientes de sus estrategias en curso (continuidad entre sesiones).
 *
 * Escritura vía service_role (control-plane), igual que daily-briefing-job. El org
 * llega verificado desde secCtx (dispatchTool lo inyecta) — no del cliente.
 */
import { supabase } from "../lib/supabase.js";

// Registra un PASO (misión) de una estrategia. Nace 'pending' (en cola).
export async function logMission({ organizationId, brandContainerId, strategyId, seq = 1, missionType, description, pendingActionId = null }) {
  if (!strategyId) throw new Error("logMission: strategyId (estrategia padre) requerido");
  if (!missionType) throw new Error("logMission: missionType requerido");
  const { data, error } = await supabase.from("body_missions").insert({
    organization_id:    organizationId,
    brand_container_id: brandContainerId || null,
    strategy_id:        strategyId,
    seq:                Number(seq) || 1,
    mission_type:       String(missionType),
    status:             "pending",
    action_payload:     { description: String(description || "").slice(0, 500) },
    pending_action_id:  pendingActionId || null,
  }).select("id, seq, mission_type, status").single();
  if (error) throw new Error(`logMission: ${error.message}`);
  return data;
}

// Avanza una misión: 'running' | 'completed' | 'failed', con su resultado (para retomar).
export async function completeMission({ missionId, status = "completed", summary = null, resultReference = null, pendingActionId = null }) {
  if (!missionId) throw new Error("completeMission: missionId requerido");
  const patch = { status, updated_at: new Date().toISOString() };
  if (summary || resultReference) {
    patch.result_reference = resultReference || { summary: String(summary).slice(0, 500) };
  }
  if (pendingActionId) patch.pending_action_id = pendingActionId;  // enlaza la Tarea que generó
  const { data, error } = await supabase.from("body_missions")
    .update(patch).eq("id", missionId).select("id, status").single();
  if (error) throw new Error(`completeMission: ${error.message}`);
  return data;
}

// Misiones ABIERTAS (pending/running) de la org — o de una estrategia. Para RETOMAR.
export async function getOpenMissions({ organizationId, strategyId = null, limit = 30 }) {
  let q = supabase.from("body_missions")
    .select("id, strategy_id, seq, mission_type, status, action_payload, created_at")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .order("strategy_id", { ascending: true })
    .order("seq", { ascending: true })
    .limit(Number(limit) || 30);
  if (strategyId) q = q.eq("strategy_id", strategyId);
  const { data, error } = await q;
  if (error) throw new Error(`getOpenMissions: ${error.message}`);
  return data || [];
}
