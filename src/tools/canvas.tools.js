/**
 * canvas.tools.js — Tools de Vera para INTERACTUAR con el Command Center.
 *
 * Vera puede:
 *   A) Colocar / mover / quitar / conectar / pulsar nodos del canvas.
 *   B) Crear y listar estrategias (containers tipo n8n-flow).
 *   C) Anotar con sticky notes y agrupar zonas (frames).
 *   D) Proponer acciones EXTERNAS (las que tocan plataforma/dinero/posts).
 *   E) Orquestar una construccion completa (buildStrategy macro).
 *
 * AUTONOMIA PARCIAL: Vera ejecuta lo interno (placements, edges, stickies,
 * groups, vera_state) sin pedir aprobacion. Solo abre vera_pending_actions
 * para acciones EXTERNAS que tocan el mundo fuera de la plataforma.
 *
 * Convenciones:
 *   - Cada write requiere `reason` (auditoria + aprendizaje).
 *   - Cada write valida org-scope (no se permite cross-tenant).
 *   - vera_state cambia disparan Realtime → frontend pinta pulse.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

// ──────────────────────────────────────────────────────────────────────────────
// Constantes compartidas con frontend
// ──────────────────────────────────────────────────────────────────────────────

const NODE_TYPES = new Set([
  "product", "service", "place",
  "audience", "brief", "flow",
  "campaign",
  "sticky", "group",
]);

const VERA_STATES = new Set([
  "idle", "analizando", "creando", "iterando",
  "publicando", "midiendo", "esperando_aprobacion",
]);

// Mismas reglas que CC_CONNECTION_RULES en CanvasStore.js
const CONNECTION_RULES = {
  // Pipeline de la estrategia (solo hacia adelante):
  // campana CONCEPTUAL (trigger) -> audiencia -> identities -> produccion -> campana REAL (cierre)
  campaign:  ["audience"],                              // campana conceptual -> a quien
  audience:  ["product", "service", "place", "brief", "flow"],  // a quien -> con que / produccion
  product:   ["brief", "flow"],
  service:   ["brief", "flow"],
  place:     ["brief", "flow"],
  brief:     ["flow", "campaign"],                      // produccion -> campana real (cierre del loop)
  flow:      ["campaign"],
  sticky:    [],
  group:     [],
};

// Acciones que tocan el mundo EXTERIOR (Meta/Google/Insta/spend).
// SOLO estas pueden ir a vera_pending_actions desde proposeExternalAction.
const EXTERNAL_ACTION_TYPES = new Set([
  "pause_campaign", "resume_campaign", "launch_campaign",
  "publish_post", "modify_segment",
]);

const STICKY_COLORS    = new Set(["yellow", "pink", "blue", "green", "purple", "gray"]);
const GROUP_COLORS     = new Set(["blue", "purple", "green", "orange", "gray", "red"]);
const STRATEGY_COLORS  = new Set(["white","blue","purple","green","orange","red","cyan","yellow","pink","gray"]);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function need(field, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${field} requerido`);
  }
}

async function getStrategyOrThrow(strategyId, organizationId) {
  if (!strategyId) throw new Error("strategy_id requerido");
  const { data, error } = await supabase
    .from("canvas_strategies")
    .select("id, organization_id, brand_container_id")
    .eq("id", strategyId)
    .single();
  if (error || !data) throw new Error(`canvas_strategies: estrategia ${strategyId} no encontrada`);
  if (data.organization_id !== organizationId) {
    throw new Error("strategy_id no pertenece a esta organizacion");
  }
  return data;
}

async function getPlacementOrThrow(placementId, organizationId) {
  if (!placementId) throw new Error("placement_id requerido");
  const { data, error } = await supabase
    .from("canvas_node_placements")
    .select("id, strategy_id, node_type, node_id, position_x, position_y, vera_state, canvas_strategies!inner(organization_id, brand_container_id)")
    .eq("id", placementId)
    .single();
  if (error || !data) throw new Error(`canvas_node_placements: placement ${placementId} no encontrado`);
  if (data.canvas_strategies.organization_id !== organizationId) {
    throw new Error("placement no pertenece a esta organizacion");
  }
  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// BLOQUE A — Placement (canvas_node_placements + canvas_edges + vera_state)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * placeNodeOnCanvas(strategy_id, node_type, node_id, position_x?, position_y?, reason)
 * Vera la usa cuando: "Necesito que esta entidad este visible en el mapa de esta estrategia."
 */
export async function placeNodeOnCanvas(params, _brand, organizationId, userId) {
  const {
    strategy_id, strategyId,
    node_type, nodeType,
    node_id, nodeId,
    position_x = 0, position_y = 0,
    reason,
  } = params || {};

  const sid = strategy_id || strategyId;
  const nt  = node_type   || nodeType;
  const nid = node_id     || nodeId;
  need("strategy_id", sid);
  need("node_type", nt);
  need("node_id", nid);
  need("reason", reason);
  if (!NODE_TYPES.has(nt)) throw new Error(`node_type invalido: ${nt}`);

  const strategy = await getStrategyOrThrow(sid, organizationId);

  // Idempotencia: si ya existe el placement, retornamos el existente
  const { data: existing } = await supabase
    .from("canvas_node_placements")
    .select("id, position_x, position_y")
    .eq("strategy_id", sid)
    .eq("node_type", nt)
    .eq("node_id", String(nid))
    .maybeSingle();
  if (existing) {
    return {
      success: true,
      placement_id: existing.id,
      idempotent: true,
      message: `${nt}:${nid} ya estaba en el canvas`,
    };
  }

  const { data, error } = await supabase
    .from("canvas_node_placements")
    .insert({
      strategy_id: sid,
      node_type: nt,
      node_id: String(nid),
      position_x: Number(position_x) || 0,
      position_y: Number(position_y) || 0,
      vera_state: "idle",
      vera_reasoning: reason,
      created_by: userId || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`placeNodeOnCanvas: ${error.message}`);

  return {
    success: true,
    placement_id: data.id,
    strategy_id: sid,
    brand_container_id: strategy.brand_container_id,
    message: `${nt}:${nid} colocado en canvas`,
  };
}

/**
 * moveNodeOnCanvas(placement_id, position_x, position_y, reason)
 */
export async function moveNodeOnCanvas(params, _brand, organizationId) {
  const { placement_id, placementId, position_x, position_y, reason } = params || {};
  const pid = placement_id || placementId;
  need("placement_id", pid);
  if (position_x === undefined || position_y === undefined) {
    throw new Error("position_x y position_y requeridos");
  }
  need("reason", reason);

  await getPlacementOrThrow(pid, organizationId);

  const { error } = await supabase
    .from("canvas_node_placements")
    .update({
      position_x: Number(position_x),
      position_y: Number(position_y),
      vera_reasoning: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pid);
  if (error) throw new Error(`moveNodeOnCanvas: ${error.message}`);

  return { success: true, placement_id: pid, message: "Nodo movido" };
}

/**
 * removeNodeFromCanvas(placement_id, reason)
 * NO borra la entidad subyacente, solo el placement (la presencia en el mapa).
 */
export async function removeNodeFromCanvas(params, _brand, organizationId) {
  const { placement_id, placementId, reason } = params || {};
  const pid = placement_id || placementId;
  need("placement_id", pid);
  need("reason", reason);

  const placement = await getPlacementOrThrow(pid, organizationId);

  // Borramos primero edges que tocan este node (source o target)
  await supabase
    .from("canvas_edges")
    .delete()
    .eq("strategy_id", placement.strategy_id)
    .or(`and(source_type.eq.${placement.node_type},source_id.eq.${placement.node_id}),and(target_type.eq.${placement.node_type},target_id.eq.${placement.node_id})`);

  const { error } = await supabase
    .from("canvas_node_placements")
    .delete()
    .eq("id", pid);
  if (error) throw new Error(`removeNodeFromCanvas: ${error.message}`);

  return {
    success: true,
    placement_id: pid,
    node_type: placement.node_type,
    node_id: placement.node_id,
    message: "Nodo retirado del canvas (entidad subyacente intacta)",
  };
}

/**
 * connectNodes(strategy_id, source_type, source_id, target_type, target_id, reason, edge_kind?, label?)
 * Valida las CONNECTION_RULES bidireccionales del Command Center.
 */
export async function connectNodes(params, _brand, organizationId, userId) {
  const {
    strategy_id, strategyId,
    source_type, sourceType,
    source_id, sourceId,
    target_type, targetType,
    target_id, targetId,
    edge_kind = "free",
    label = null,
    reason,
  } = params || {};

  const sid  = strategy_id || strategyId;
  const sT   = source_type || sourceType;
  const sI   = String(source_id || sourceId || "");
  const tT   = target_type || targetType;
  const tI   = String(target_id || targetId || "");

  need("strategy_id", sid);
  need("source_type", sT);
  need("source_id", sI);
  need("target_type", tT);
  need("target_id", tI);
  need("reason", reason);

  if (!NODE_TYPES.has(sT)) throw new Error(`source_type invalido: ${sT}`);
  if (!NODE_TYPES.has(tT)) throw new Error(`target_type invalido: ${tT}`);
  if (sT === tT && sI === tI) throw new Error("no se puede conectar nodo consigo mismo");

  // Valida CC_CONNECTION_RULES (source.allows.target)
  const allowed = CONNECTION_RULES[sT] || [];
  if (!allowed.includes(tT)) {
    throw new Error(`conexion no permitida: ${sT} -> ${tT} (allowed: ${allowed.join(", ") || "ninguna"})`);
  }

  const strategy = await getStrategyOrThrow(sid, organizationId);

  // Idempotencia
  const { data: existing } = await supabase
    .from("canvas_edges")
    .select("id")
    .eq("strategy_id", sid)
    .eq("source_type", sT).eq("source_id", sI)
    .eq("target_type", tT).eq("target_id", tI)
    .maybeSingle();
  if (existing) {
    return { success: true, edge_id: existing.id, idempotent: true, message: "Edge ya existia" };
  }

  const { data, error } = await supabase
    .from("canvas_edges")
    .insert({
      organization_id: organizationId,
      brand_container_id: strategy.brand_container_id,
      strategy_id: sid,
      source_type: sT, source_id: sI,
      target_type: tT, target_id: tI,
      edge_kind,
      label,
      metadata: { created_by_vera: true, reason },
      created_by: userId || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`connectNodes: ${error.message}`);

  return {
    success: true,
    edge_id: data.id,
    strategy_id: sid,
    message: `Conexion ${sT}:${sI} -> ${tT}:${tI} creada`,
  };
}

/**
 * disconnectNodes(edge_id, reason)
 */
export async function disconnectNodes(params, _brand, organizationId) {
  const { edge_id, edgeId, reason } = params || {};
  const eid = edge_id || edgeId;
  need("edge_id", eid);
  need("reason", reason);

  const { data: edge } = await supabase
    .from("canvas_edges")
    .select("id, organization_id")
    .eq("id", eid)
    .single();
  if (!edge) throw new Error(`edge ${eid} no encontrado`);
  if (edge.organization_id !== organizationId) {
    throw new Error("edge no pertenece a esta organizacion");
  }

  const { error } = await supabase.from("canvas_edges").delete().eq("id", eid);
  if (error) throw new Error(`disconnectNodes: ${error.message}`);

  return { success: true, edge_id: eid, message: "Edge eliminado" };
}

/**
 * setVeraState(placement_id, state, reasoning)
 * Cambia el pulse visual del nodo. Realtime push automatico al frontend.
 */
export async function setVeraState(params, _brand, organizationId) {
  const { placement_id, placementId, state, reasoning } = params || {};
  const pid = placement_id || placementId;
  need("placement_id", pid);
  need("state", state);
  need("reasoning", reasoning);
  if (!VERA_STATES.has(state)) {
    throw new Error(`vera_state invalido: ${state} (valid: ${[...VERA_STATES].join(", ")})`);
  }

  await getPlacementOrThrow(pid, organizationId);

  const { error } = await supabase
    .from("canvas_node_placements")
    .update({
      vera_state: state,
      vera_state_changed_at: new Date().toISOString(),
      vera_reasoning: reasoning,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pid);
  if (error) throw new Error(`setVeraState: ${error.message}`);

  return {
    success: true,
    placement_id: pid,
    state,
    message: `Vera ahora ${state} en este nodo`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// BLOQUE B — Strategy (canvas_strategies)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * createStrategy(brand_container_id, name, icon?, color?, description?, reason)
 */
export async function createStrategy(params, brandContainerId, organizationId, userId) {
  const {
    brand_container_id, brandContainerId: bcid2,
    name, icon = "fa-bullseye", color = "white",
    description = null,
    reason,
  } = params || {};

  const bcid = brand_container_id || bcid2 || brandContainerId;
  need("brand_container_id", bcid);
  need("name", name);
  need("reason", reason);
  if (!STRATEGY_COLORS.has(color)) throw new Error(`color invalido: ${color}`);

  // Verificar que el brand pertenece a la org
  const brand = await resolveBrandContainer(bcid, organizationId).catch(() => null);
  if (!brand) throw new Error("brand_container_id no pertenece a esta organizacion");

  const { data, error } = await supabase
    .from("canvas_strategies")
    .insert({
      organization_id: organizationId,
      brand_container_id: bcid,
      name: String(name).slice(0, 120),
      description: description ? String(description).slice(0, 500) : null,
      icon,
      color,
      is_default: false,
      created_by: userId || null,
    })
    .select("id, name, icon, color")
    .single();
  if (error) throw new Error(`createStrategy: ${error.message}`);

  return {
    success: true,
    strategy_id: data.id,
    name: data.name,
    icon: data.icon,
    color: data.color,
    message: `Estrategia '${data.name}' creada`,
  };
}

/**
 * listStrategies(brand_container_id)
 */
export async function listStrategies(params, brandContainerId, organizationId) {
  const { brand_container_id, brandContainerId: bcid2 } = params || {};
  const bcid = brand_container_id || bcid2 || brandContainerId;
  need("brand_container_id", bcid);

  const { data, error } = await supabase
    .from("canvas_strategies")
    .select("id, name, description, icon, color, is_default, created_at, updated_at")
    .eq("organization_id", organizationId)
    .eq("brand_container_id", bcid)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listStrategies: ${error.message}`);

  return {
    success: true,
    strategies: data || [],
    count: (data || []).length,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// BLOQUE C — Annotations (canvas_stickies + canvas_groups)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * createStickyNote(strategy_id, content, position_x?, position_y?, color?, width?, height?, reason)
 */
export async function createStickyNote(params, _brand, organizationId, userId) {
  const {
    strategy_id, strategyId,
    content,
    position_x = 0, position_y = 0,
    color = "yellow",
    width = 200, height = 160,
    reason,
  } = params || {};

  const sid = strategy_id || strategyId;
  need("strategy_id", sid);
  need("content", content);
  need("reason", reason);
  if (!STICKY_COLORS.has(color)) throw new Error(`color invalido: ${color}`);

  const strategy = await getStrategyOrThrow(sid, organizationId);

  const { data, error } = await supabase
    .from("canvas_stickies")
    .insert({
      organization_id: organizationId,
      brand_container_id: strategy.brand_container_id,
      strategy_id: sid,
      content: String(content).slice(0, 2000),
      color,
      position_x: Number(position_x) || 0,
      position_y: Number(position_y) || 0,
      width: Number(width) || 200,
      height: Number(height) || 160,
      created_by: userId || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createStickyNote: ${error.message}`);

  return {
    success: true,
    sticky_id: data.id,
    strategy_id: sid,
    message: "Sticky note creada",
  };
}

/**
 * createGroup(strategy_id, title, position_x?, position_y?, width?, height?, color?, reason)
 */
export async function createGroup(params, _brand, organizationId, userId) {
  const {
    strategy_id, strategyId,
    title,
    position_x = 0, position_y = 0,
    width = 400, height = 300,
    color = "blue",
    reason,
  } = params || {};

  const sid = strategy_id || strategyId;
  need("strategy_id", sid);
  need("title", title);
  need("reason", reason);
  if (!GROUP_COLORS.has(color)) throw new Error(`color invalido: ${color}`);

  const strategy = await getStrategyOrThrow(sid, organizationId);

  const { data, error } = await supabase
    .from("canvas_groups")
    .insert({
      organization_id: organizationId,
      brand_container_id: strategy.brand_container_id,
      strategy_id: sid,
      title: String(title).slice(0, 120),
      color,
      position_x: Number(position_x) || 0,
      position_y: Number(position_y) || 0,
      width: Number(width) || 400,
      height: Number(height) || 300,
      created_by: userId || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createGroup: ${error.message}`);

  return {
    success: true,
    group_id: data.id,
    strategy_id: sid,
    message: `Grupo '${title}' creado`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// BLOQUE D — External action proposal (vera_pending_actions)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * proposeExternalAction(action_type, target_table, target_id, vera_reasoning,
 *                       vera_confidence?, impact_estimate?, priority?, expires_in_hours?, proposed_payload?)
 *
 * SOLO para acciones que tocan el mundo exterior. Si action_type es interno
 * Vera debe ejecutarlo directo, no proponerlo.
 */
export async function proposeExternalAction(params, brandContainerId, organizationId) {
  const {
    action_type, actionType,
    target_table, targetTable,
    target_id, targetId = null,
    vera_reasoning, reasoning,
    vera_confidence = null, confidence,
    impact_estimate = null, impact,
    priority = 5,
    expires_in_hours = 72,
    proposed_payload = {},
  } = params || {};

  const at = action_type || actionType;
  const tt = target_table || targetTable;
  const tid = target_id || targetId;
  const reas = vera_reasoning || reasoning;
  const conf = vera_confidence ?? confidence;
  const imp  = impact_estimate ?? impact;

  need("action_type", at);
  need("target_table", tt);
  need("vera_reasoning", reas);

  if (!EXTERNAL_ACTION_TYPES.has(at)) {
    throw new Error(
      `action_type '${at}' es INTERNO. Ejecutalo directo con la tool correspondiente, ` +
      `no abras pending_action. Externos validos: ${[...EXTERNAL_ACTION_TYPES].join(", ")}`,
    );
  }

  const expiresAt = new Date(Date.now() + Math.max(1, expires_in_hours) * 36e5).toISOString();

  const { data, error } = await supabase
    .from("vera_pending_actions")
    .insert({
      organization_id: organizationId,
      brand_container_id: brandContainerId || null,
      action_type: at,
      target_table: tt,
      target_id: tid,
      proposed_payload: proposed_payload || {},
      vera_reasoning: String(reas).slice(0, 2000),
      vera_confidence: conf !== null && conf !== undefined ? Number(conf) : null,
      impact_estimate: imp || null,
      priority: Math.max(1, Math.min(10, Number(priority) || 5)),
      expires_at: expiresAt,
      status: "pending",
    })
    .select("id, expires_at, priority")
    .single();
  if (error) throw new Error(`proposeExternalAction: ${error.message}`);

  return {
    success: true,
    pending_action_id: data.id,
    action_type: at,
    target: `${tt}:${tid || "(sin target)"}`,
    expires_at: data.expires_at,
    priority: data.priority,
    message: `Vera propuso ${at}; espera aprobacion humana`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// BLOQUE E — Macro: buildStrategy
// ──────────────────────────────────────────────────────────────────────────────

/**
 * buildStrategy(brand_container_id, name, goal, reason)
 * Orquestador: crea strategy + selecciona top productos + selecciona audiencia
 * con mejor match + propone brief + place nodes en layout + connect segun reglas.
 *
 * NO usa LLM por ahora (costo). Hace seleccion deterministica:
 *   - Top 3 productos mas recientes con ficha completa
 *   - Top 1 audiencia activa
 *   - Brief vacio como "container" (no se genera copy, eso lo hace otra tool)
 *   - Layout en columnas: productos izquierda, audiencia centro, brief y flow derecha
 *
 * Si se quiere LLM, otro pase agrega selectBest...() con OpenAI.
 */
export async function buildStrategy(params, brandContainerId, organizationId, userId) {
  const {
    brand_container_id, brandContainerId: bcid2,
    name, goal,
    reason,
  } = params || {};

  const bcid = brand_container_id || bcid2 || brandContainerId;
  need("brand_container_id", bcid);
  need("name", name);
  need("goal", goal);
  need("reason", reason);

  const trace = [];

  // 1. Crear la estrategia (el pizarron)
  const strategyRes = await createStrategy(
    { brand_container_id: bcid, name, description: goal, reason, icon: "fa-rocket", color: "purple" },
    bcid, organizationId, userId,
  );
  const strategyId = strategyRes.strategy_id;
  trace.push({ step: "createStrategy", id: strategyId });

  const placements = [];
  const edges = [];
  const _place = async (node_type, node_id, x, y, why) => {
    const res = await placeNodeOnCanvas(
      { strategy_id: strategyId, node_type, node_id, position_x: x, position_y: y, reason: why },
      bcid, organizationId, userId,
    );
    placements.push({ type: node_type, id: node_id, placement_id: res.placement_id });
    return res.placement_id;
  };
  const _connect = async (sT, sI, tT, tI) => {
    try {
      const e = await connectNodes(
        { strategy_id: strategyId, source_type: sT, source_id: sI, target_type: tT, target_id: tI, reason: `buildStrategy '${name}'` },
        bcid, organizationId, userId,
      );
      if (e?.edge_id) edges.push(e.edge_id);
    } catch (e) { /* regla/idempotencia; seguimos */ }
  };

  // ── CAPA 1: Campana CONCEPTUAL = el trigger (objetivo: que transmitir / como / que decir) ──
  const campRow = {
    organization_id: organizationId,
    brand_container_id: bcid,
    nombre_campana: name,
    descripcion_interna: goal,
    status: "conceptual",
  };
  // Objetivo de campana (etapa de embudo / platform objective) — opcional.
  const _obj = params.platform_objective || params.objetivo;
  if (_obj) campRow.platform_objective = _obj;
  // PRESUPUESTO OPCIONAL: si la campana es de contenido organico NO lleva presupuesto;
  // si lleva, define el camino hacia pauta paga. Default moneda COP (agencia).
  if (params.budget_total != null && params.budget_total !== "") campRow.budget_total = Number(params.budget_total);
  if (params.budget_daily != null && params.budget_daily !== "") campRow.budget_daily = Number(params.budget_daily);
  if (campRow.budget_total != null || campRow.budget_daily != null) campRow.budget_currency = params.budget_currency || "COP";
  const { data: campaign, error: campErr } = await supabase
    .from("campaigns")
    .insert(campRow)
    .select("id")
    .single();
  if (campErr) throw new Error(`buildStrategy: campaign insert ${campErr.message}`);
  trace.push({ step: "createConceptualCampaign", id: campaign.id });
  await _place("campaign", campaign.id, 100, 220, `buildStrategy: campana conceptual (objetivo) de '${name}'`);

  // ── CAPA 2: Audiencia = a quien va dirigida ──
  const { data: audiences } = await supabase
    .from("audience_personas")
    .select("id, name, created_at")
    .eq("brand_container_id", bcid)
    .order("created_at", { ascending: false })
    .limit(1);
  trace.push({ step: "selectAudience", id: audiences?.[0]?.id || null });
  let audId = null;
  if (audiences?.[0]) {
    audId = audiences[0].id;
    await _place("audience", audId, 500, 220, `buildStrategy: audiencia objetivo`);
    await _connect("campaign", campaign.id, "audience", audId);   // objetivo -> a quien
  }

  // ── CAPA 3: Identities = productos que la campana usa para producir contenido ──
  const { data: products } = await supabase
    .from("products")
    .select("id, nombre_producto, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(3);
  trace.push({ step: "selectProducts", count: (products || []).length });
  let py = 100;
  for (const p of products || []) {
    await _place("product", p.id, 900, py, `buildStrategy: ${p.nombre_producto}`);
    if (audId) await _connect("audience", audId, "product", p.id);  // a quien -> con que
    py += 200;
  }

  // ── CAPA 4: Produccion = brief (plan creativo) ──
  const { data: brief, error: briefErr } = await supabase
    .from("campaign_briefs")
    .insert({
      organization_id: organizationId,
      brand_container_id: bcid,
      nombre: name,
      descripcion_interna: goal,
      objetivo_comercial: goal,
      status: "draft",
      is_conceptual_only: true,
    })
    .select("id")
    .single();
  if (briefErr) throw new Error(`buildStrategy: brief insert ${briefErr.message}`);
  trace.push({ step: "createBrief", id: brief.id });
  const briefPid = await _place("brief", brief.id, 1300, 220, `buildStrategy: brief de produccion`);
  for (const p of products || []) await _connect("product", p.id, "brief", brief.id);  // con que -> produccion

  trace.push({ step: "placeNodes", count: placements.length });
  trace.push({ step: "connectEdges", count: edges.length });

  // Marcar el brief como "creando" para que pulse en el frontend
  await setVeraState(
    { placement_id: briefPid, state: "creando", reasoning: `buildStrategy: redactando brief de '${name}'` },
    bcid, organizationId,
  ).catch(() => null);

  // CAPA 5 (campana REAL / publicada) NO se crea aqui: es el estado publicado en
  // Meta/Google. Se conecta como nodo de cierre (brief/flow -> campaign) cuando la
  // campana se publica, para que Vera mida impacto vs plan y aprenda.

  return {
    success: true,
    strategy_id: strategyId,
    name,
    placements,
    edges,
    conceptual_campaign_id: campaign.id,
    brief_id: brief.id,
    trace,
    message: `Estrategia '${name}': pipeline conceptual->audiencia->identities->brief (${placements.length} nodos, ${edges.length} conexiones). La campana real cierra al publicar.`,
  };
}
