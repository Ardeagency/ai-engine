/**
 * AI Service — orquestador principal.
 *
 * REGLA FUNDAMENTAL:
 *   OpenClaw puede pensar, sugerir y pedir.
 *   AI-ENGINE decide, ejecuta y registra.
 *
 * Flujo por request:
 *  1. Historial → extraer TASK_EVENTs → approved intents
 *  2. Memoria (short + long + goal)
 *  3. Sesión de OpenClaw (aislada por org+conv, con presupuesto)
 *  4. Consent gate pre-OpenClaw (acciones de escritura)
 *  5. Policy gate (plan + rol) — chequeo previo
 *  6. Contexto org-scoped → View Model (lo que OpenClaw ve)
 *  7. Loop de tool-calls controlado:
 *       a. validateToolCallBatch  — schema + injection
 *       b. checkToolBudget        — límite de sesión
 *       c. dispatchTool           — phase + allowlist + policy + consent + timeout
 *  8. Audit log del request
 *  9. Trigger asíncrono de maybeSummarize
 */
import { supabase } from "../lib/supabase.js";
import {
  registerConversation,
  unregisterConversation,
  emitActivity,
  clearActivities,
} from "../lib/activity-emitter.js";
import { buildOrgContext, buildFullBrandContext } from "./context.builder.js";
import { serializeOrgContext } from "../lib/context.serializer.js";
import { callOpenClaw } from "./openclaw.adapter.js";
import { dispatchTool } from "./tool.dispatcher.js";
import { validateToolCallBatch } from "../lib/tool-call.validator.js";
import { checkPolicy } from "../lib/policy.engine.js";
import { CostController, TOOL_LIMITS } from "../lib/cost.controller.js";
import { buildConversationMemory, maybeSummarize } from "./memory.service.js";
import { buildViewModel } from "../lib/view-model.builder.js";
import {
  getOrCreateSession,
  checkToolBudget,
  recordToolCalls,
  checkAndRecordTokens,
  estimateTokens,
} from "../lib/session.manager.js";
import { TOOLS_BY_PHASE } from "../lib/tool-phases.js";
import { getOrgAutonomy, getBlockedByAutonomyMessage, consumeAutonomyChangeNotice } from "../lib/autonomy.js";
import { audit } from "../lib/audit-logger.js";
import { canLaunchAgent } from "./resource.governor.js";
import { getOrSpawnAgent, markAgentBusy, markAgentIdle } from "./agent.manager.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseTaskEventContent(content) {
  const c = String(content || "");
  if (!c.startsWith("TASK_EVENT ")) return null;
  try { return JSON.parse(c.slice("TASK_EVENT ".length)); } catch (_) { return null; }
}

function extractApprovedIntents(taskEvents) {
  const approved = new Set();
  for (const ev of taskEvents) {
    if (!ev?.checked) continue;
    const m = String(ev.task_text || "").match(/^APPROVE_ACTION:([A-Z0-9_:-]+)$/);
    if (m?.[1]) approved.add(m[1]);
  }
  return approved;
}

function looksLikePublishOrWrite(t) {
  return (
    t.includes("publicar") || t.includes("postear") || t.includes("publicacion") ||
    t.includes("crear campaña") || t.includes("ejecutar flow") || t.includes("ejecutar") ||
    t.includes("programar flow") || t.includes("programar") ||
    t.includes("una vez al dia") || t.includes("una vez al día") ||
    t.includes("cada dia") || t.includes("cada día") || t.includes("diario")
  );
}

function inferConsentKey(t) {
  if (t.includes("diario") || t.includes("una vez al dia") ||
      t.includes("una vez al día") || t.includes("cada dia") ||
      t.includes("cada día") || t.includes("programar"))
    return "SCHEDULE_FLOW";
  if (t.includes("ejecutar") || t.includes("trigger")) return "TRIGGER_FLOW_RUN";
  if (t.includes("crear campaña") || t.includes("campaign")) return "CREATE_CAMPAIGN";
  return "PUBLISH_ACTIONS";
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateAssistantReply(ctx) {
  const message        = String(ctx?.message ?? "").trim();
  const attachments    = ctx?.attachments ?? [];
  const organizationId = ctx?.organizationId;
  const userId         = ctx?.userId;
  const conversationId = ctx?.conversationId;
  const brandContainerId = ctx?.brandContainerId || null;

  const auditCtx = { organizationId, userId, conversationId };

  if (!message && !attachments.length) {
    return { message: "Hola, soy Vera. ¿En qué puedo ayudarte?", actions: [] };
  }

  audit.requestStart(auditCtx, { messageLen: message.length });

  // ── 1. Historial → TASK_EVENTs → approved intents ────────────────────────
  const { data: historyRaw } = await supabase
    .from("ai_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(50);

  const history = historyRaw || [];

  const taskEvents = history
    .filter((m) => m?.role === "system")
    .map((m) => parseTaskEventContent(m?.content))
    .filter(Boolean);

  const approvedIntents = extractApprovedIntents(taskEvents);

  // ── 2. Memoria ────────────────────────────────────────────────────────────
  const memory = await buildConversationMemory(conversationId).catch((e) => {
    console.warn("ai.service: memory error:", e.message);
    return { recent: [], summary: null, goal: null, totalMessages: 0 };
  });

  // ── 3. Autonomía de la organización ──────────────────────────────────────
  const autonomy = await getOrgAutonomy(organizationId);
  // Aviso de cambio de nivel — se consume una sola vez (limpia el registro al leerlo)
  const _rawNotice = consumeAutonomyChangeNotice(organizationId);
  const autonomyNotice = _rawNotice ? { ..._rawNotice, orgName: autonomy.orgName } : null;

  // ── 4. Sesión OpenClaw (aislada por org+conv) ─────────────────────────────
  const session = getOrCreateSession(organizationId, conversationId, approvedIntents);

  // Verificar presupuesto de tokens antes de hacer cualquier cosa
  try {
    checkAndRecordTokens(session, estimateTokens(message));
  } catch (e) {
    return { message: e.message, actions: [] };
  }

  // ── 5. Cost Controller (per-request) ─────────────────────────────────────
  const costController = new CostController({ organizationId, userId, conversationId });

  const t = message.toLowerCase();

  // ── 5b. Resource Governor: ¿puede levantarse el agente? ────────────────
  const launchCheck = await canLaunchAgent(organizationId, "high").catch(() => ({ allowed: true }));
  if (!launchCheck.allowed) {
    return { message: `Servidor ocupado. ${launchCheck.reason}`, actions: [] };
  }

  // ── 5c. Provisionar/levantar el agente de esta org ───────────────────────
  let agentEntry = null;
  try {
    agentEntry = await getOrSpawnAgent(organizationId);
    markAgentBusy(organizationId, `chat:${conversationId}`);
  } catch (e) {
    if (e.agentFailed) return { message: e.message, actions: [] };
    console.warn("ai.service: no se pudo levantar agente:", e.message);
  }

  await emitActivity(conversationId, "Construyendo contexto…", { step: "context" });

  // ── 6. Consent gate — depende del nivel de autonomía ─────────────────────
  //
  //   restringido → bloquea TODO intent de escritura con mensaje explicativo.
  //   parcial     → pide APPROVE_ACTION (comportamiento original).
  //   total       → salta el gate; consent se auto-aprueba en tool.dispatcher.
  //
  if (looksLikePublishOrWrite(t)) {
    if (autonomy.consentMode === "block_all") {
      audit.consentGate(auditCtx, "BLOCKED_BY_AUTONOMY_RESTRINGIDO");
      return {
        message: getBlockedByAutonomyMessage("restringido", autonomy.orgName),
        actions: [],
      };
    }

    if (autonomy.consentMode === "require") {
      const consentKey = inferConsentKey(t);
      if (!session.approvedIntents.has(consentKey)) {
        const policy = await checkPolicy(consentKey, organizationId, userId);
        if (!policy.allowed) {
          audit.policyDenied(auditCtx, consentKey, policy.reason);
          return { message: `No es posible ejecutar esta acción: ${policy.reason}`, actions: [] };
        }
        audit.consentGate(auditCtx, consentKey);
        // parcial: el usuario debe aprobar manualmente — devolvemos botón de publicación
        return {
          message: getBlockedByAutonomyMessage("parcial", autonomy.orgName),
          actions: [
            {
              type: "MANUAL_PUBLISH_BUTTON",
              label: "Publicar manualmente",
              consent_key: consentKey,
              description:
                `Aprueba esta acción para que ai-engine la ejecute: APPROVE_ACTION:${consentKey}`,
            },
          ],
        };
      }
    }
    // consentMode === "auto" → no hacemos nada, tool.dispatcher saltará el gate
  }

  // ── 8. Contexto org-scoped + View Model ───────────────────────────────────
  let orgContext = { organization_id: organizationId, brand_containers: [] };
  try {
    orgContext = await buildOrgContext(organizationId, brandContainerId);
  } catch (e) {
    console.error("ai.service: buildOrgContext error:", e.message);
  }

  // Resolver rol y plan del usuario (necesarios para el view model)
  let userRole = "member";
  let planType = "basico";
  try {
    const [memberRes, subRes] = await Promise.all([
      supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("subscriptions")
        .select("plan_type")
        .eq("organization_id", organizationId)
        .in("status", ["active", "trialing"])
        .limit(1)
        .maybeSingle(),
    ]);
    userRole = memberRes.data?.role || "member";
    planType = subRes.data?.plan_type || "basico";
  } catch (_) { /* non-fatal */ }

  // brandContainerId efectivo de la conversacion: el explicito, o el unico de
  // la org si solo hay uno. Se pasa al dispatcher para que las tools operen
  // sobre la marca correcta (no la mas antigua por auto-resolve).
  let effectiveBrandContainerId = brandContainerId;
  if (!effectiveBrandContainerId && orgContext.brand_containers?.length === 1) {
    effectiveBrandContainerId = orgContext.brand_containers[0].id;
  }

  // allowedTools deriva directamente del nivel de autonomía
  const allowedTools = TOOLS_BY_PHASE[autonomy.phase] ?? TOOLS_BY_PHASE["A"];

  const viewModel = buildViewModel({
    orgContext,
    organizationId,
    userRole,
    planType,
    allowedTools,
    approvedIntents: session.approvedIntents,
    memory,
    autonomy,
    autonomyNotice,
  });

  // ── 8b. Contexto completo de la marca (productos, audiencias, campañas…) ──
  // pull-via-tools (CHAT_PULL_VIA_TOOLS_ORGS): las orgs listadas NO reciben el
  // bloque de catalogo inyectado — Vera lo LEE con tools. Vacio = viejo comportamiento.
  const _pullOrgs = (process.env.CHAT_PULL_VIA_TOOLS_ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const pullViaTools = _pullOrgs.includes("*") || _pullOrgs.includes(organizationId);

  let serializedBrandData = null;
  if (!pullViaTools && brandContainerId) {
    try {
      const fullCtx = await buildFullBrandContext(brandContainerId, organizationId);
      serializedBrandData = serializeOrgContext(fullCtx);
    } catch (e) {
      console.warn("ai.service: buildFullBrandContext error:", e.message);
    }
  } else if (!pullViaTools && orgContext.brand_containers?.length === 1) {
    // Si solo hay una marca en la org, la cargamos automáticamente
    try {
      const autoId = orgContext.brand_containers[0].id;
      const fullCtx = await buildFullBrandContext(autoId, organizationId);
      serializedBrandData = serializeOrgContext(fullCtx);
    } catch (e) {
      console.warn("ai.service: buildFullBrandContext (auto) error:", e.message);
    }
  }

  // ── 9. Loop de tool-calls ─────────────────────────────────────────────────
  const sessionId = `${organizationId}:${conversationId}`;

  await emitActivity(conversationId, "Analizando solicitud…", { step: "thinking" });

  let openClawResp = await callOpenClaw({
    message,
    attachments,
    viewModel,
    sessionId,
    toolResults: null,
    serializedBrandData,
    pullViaTools,
    recentHistory: memory.recent ?? [],
    conversationId,
  });

  let allToolResults = [];

  for (let iteration = 0; iteration < TOOL_LIMITS.maxToolIterations; iteration++) {
    const toolCalls = openClawResp.tool_calls;
    if (!toolCalls?.length) break;

    // ── 9a. Validar batch ───────────────────────────────────────────────
    const batchValidation = validateToolCallBatch(toolCalls);
    if (!batchValidation.valid) {
      audit.schemaInvalid(auditCtx, "tool_calls_batch", batchValidation.errors);
      return {
        message: `Error interno procesando herramientas: ${batchValidation.errors[0]}`,
        actions: [],
      };
    }

    // ── 9b. Presupuesto de sesión ────────────────────────────────────────
    try {
      checkToolBudget(session, toolCalls.length);
      costController.checkToolRoundLimit(toolCalls.length);
    } catch (e) {
      audit.budgetExceeded(auditCtx, "tool_round", toolCalls.length, TOOL_LIMITS.maxToolsPerRound);
      return { message: e.message, actions: [] };
    }

    costController.recordToolCalls(toolCalls.length);
    recordToolCalls(session, toolCalls.length);

    // ── 9c. Ejecutar cada tool ───────────────────────────────────────────
    const roundResults = [];

    for (const tc of toolCalls) {
      try {
        const result = await dispatchTool(tc.name, tc.params || {}, {
          organizationId,
          userId,
          conversationId,
          brandContainerId: effectiveBrandContainerId,
          approvedIntents: session.approvedIntents,
          allowedTools,
          costController,
          consentMode: autonomy.consentMode,
          orgName: autonomy.orgName,
        });
        roundResults.push({ tool: tc.name, result });
      } catch (e) {
        if (e.requiresConsent) {
          return {
            message:
              `Para ejecutar \`${tc.name}\` necesito tu confirmación:\n\n` +
              `- [ ] APPROVE_ACTION:${e.consentKey}`,
            actions: [],
          };
        }
        if (e.policyDenied || e.statusCode === 402) {
          return { message: e.message, actions: [] };
        }
        console.error(`ai.service: tool "${tc.name}" error:`, e.message);
        roundResults.push({ tool: tc.name, error: e.message });
      }
    }

    allToolResults = [...allToolResults, ...roundResults];

    openClawResp = await callOpenClaw({
      message,
      attachments,
      viewModel,
      sessionId,
      toolResults: allToolResults,
      serializedBrandData,
      pullViaTools,
      recentHistory: memory.recent ?? [],
      conversationId,
    });
  }

  const finalText = openClawResp.text || "Hola, soy Vera. ¿En qué puedo ayudarte?";
  // Largo del envelope final que se mando al modelo — sirve a processAndSaveReply
  // para estimar input_tokens (chars/4) en el cobro dinamico de vera_chat.
  const enrichedInputLength = openClawResp.enriched_input_length ?? 0;

  await emitActivity(conversationId, "Preparando respuesta…", { step: "finalizing" });

  // Marcar agente idle al terminar
  if (agentEntry) markAgentIdle(organizationId);

  // ── 10. Audit del request ─────────────────────────────────────────────────
  const costSummary = costController.summary();
  audit.requestEnd(auditCtx, {
    toolCount: costSummary.toolCallCount,
    creditsDeducted: costSummary.creditsDeducted,
    durationMs: costSummary.durationMs,
  });

  // ── 11. Resumen asíncrono (no bloquea) ───────────────────────────────────
  if (memory.totalMessages > 0 && memory.totalMessages % 5 === 0) {
    setImmediate(() => {
      maybeSummarize(conversationId, organizationId).catch((e) =>
        console.warn("ai.service: maybeSummarize error:", e.message)
      );
    });
  }

  return { message: finalText, actions: [], enriched_input_length: enrichedInputLength, agent_failed: openClawResp.agent_failed === true };
}

// ── Background processor ───────────────────────────────────────────────────────
// Ejecuta generateAssistantReply y persiste el resultado (o el error) en
// ai_messages para que el frontend lo recoja via Supabase Realtime o polling.
// No lanza excepciones — todos los errores se guardan en la DB.

export async function processAndSaveReply({ message, attachments = [], organizationId, userId, conversationId, simplifyRequest = false }) {
  // Registrar conversación en el emitter — habilita los status updates en tiempo real
  registerConversation(conversationId, organizationId);

  let aiText;
  let metadata = {};
  let enrichedInputLength = 0;
  let agentFailed = false;

  // Si el usuario aprobo el [CONFIRM] pidiendo version simplificada, inyectamos
  // una nota system al mensaje para que VERA reduzca scope sin perder calidad.
  const effectiveMessage = simplifyRequest
    ? `[INSTRUCCION DEL USUARIO]: Autorizo la tarea pero pide version SIMPLIFICADA. Entrega un plan compacto, ve directo a lo esencial, sin perder calidad ni rigor. No expandas mas alla de lo necesario.\n\n[MENSAJE ORIGINAL]:\n${message || ""}`
    : message;

  try {
    const { message: text, actions = [], enriched_input_length = 0, agent_failed = false } = await generateAssistantReply({
      message: effectiveMessage,
      attachments,
      organizationId,
      userId,
      conversationId,
    });
    aiText = text;
    if (actions.length) metadata.actions = actions;
    enrichedInputLength = enriched_input_length;
    agentFailed = agent_failed === true;
  } catch (err) {
    console.error(`ai.service: processAndSaveReply error [org=${organizationId}]:`, err.message);
    aiText =
      err.message?.length < 500
        ? err.message
        : "Ocurrió un error inesperado al procesar tu solicitud. Por favor intenta de nuevo.";
    metadata.error = true;
    // Fallback: si el modelo nunca se llamo (pre-flight), aproximamos input con
    // el mensaje del usuario. Es peor que 0 para no infra-cobrar el minimo.
    enrichedInputLength = (message || "").length;
  } finally {
    unregisterConversation(conversationId);
  }

  // Limpiar status messages ANTES de insertar la respuesta final.
  // El orden importa: el frontend debe recibir el mensaje del asistente
  // sin ver status obsoletos mezclados.
  await clearActivities(conversationId);

  // ── Estimacion de costo del intercambio (heuristica chars/4) ────────────
  // Aproximacion: 1 token ~= 4 caracteres (regla GPT-tokenizer).
  // Pricing Sonnet 4: $3/MTok input + $15/MTok output.
  // 1 credito = $1 USD (modelo 1:1 desde 2026-05-21). Sin margen aqui — el
  // margen vive en el precio del plan mensual.
  // Minimo 0.01 credito ($0.01) por intercambio para auditabilidad.
  const inputTokens   = Math.ceil(enrichedInputLength / 4);
  const outputTokens  = Math.ceil((aiText || "").length / 4);
  const usdCost       = inputTokens * (3 / 1_000_000) + outputTokens * (15 / 1_000_000);
  const creditsCharge = Math.max(0.01, usdCost);

  const row = {
    conversation_id: conversationId,
    role: metadata.error ? "error" : "assistant",
    content: aiText,
    organization_id: organizationId,
    tokens_used: inputTokens + outputTokens,
  };
  // metadata es opcional — solo se incluye si la columna existe y hay datos
  if (Object.keys(metadata).length) row.metadata = metadata;

  // Capturamos el id del mensaje para source_id del ledger
  let insertSucceeded = true;
  let insertedMessageId = null;
  const { data: inserted, error: dbErr } = await supabase
    .from("ai_messages")
    .insert(row)
    .select("id")
    .single();
  if (dbErr) {
    insertSucceeded = false;
    // Si la columna metadata aún no existe, reintentar sin ella
    if (dbErr.code === "42703" && row.metadata !== undefined) {
      console.warn(
        `ai.service: columna metadata no existe en ai_messages — reintentando sin ella. ` +
        `Ejecuta SQL/migrate_v7_ai_messages_metadata.sql en Supabase.`
      );
      delete row.metadata;
      const { data: retryInserted, error: retryErr } = await supabase
        .from("ai_messages")
        .insert(row)
        .select("id")
        .single();
      if (retryErr) {
        console.error(
          `ai.service: no se pudo guardar respuesta en DB (retry) [conv=${conversationId}]:`,
          retryErr.message
        );
      } else {
        insertSucceeded = true;
        insertedMessageId = retryInserted?.id || null;
      }
    } else {
      console.error(
        `ai.service: no se pudo guardar respuesta en DB [conv=${conversationId}]:`,
        dbErr.message
      );
    }
  } else {
    insertedMessageId = inserted?.id || null;
  }

  // ── Cobro vera_chat dinamico (por tokens estimados) ─────────────────────
  // RPC use_credits_numeric acepta decimales, hace SELECT + UPDATE balance +
  // INSERT credit_usage atomicamente. Retorna false si saldo insuficiente.
  // Fire-and-forget: cualquier fallo de cobro NUNCA bloquea el chat.
  // Pre-flight errors (auth/budget antes del LLM) deberian no cobrarse:
  // el guard `row.role !== 'error_preflight'` queda preparado para cuando
  // marquemos esos casos explicitamente (hoy NUNCA matchea, se cobra todo
  // lo que se persistio).
  if (insertSucceeded && row.role !== "error_preflight" && !metadata.error && !agentFailed) {
    try {
      const { data: charged, error: chargeErr } = await supabase.rpc("use_credits_numeric", {
        p_organization_id: organizationId,
        p_user_id:         userId,
        p_credits_amount:  Number(creditsCharge.toFixed(6)),
        p_kind:            "vera_chat",
        p_usd_cost:        Number(creditsCharge.toFixed(6)),
        p_source_table:    "ai_messages",
        p_source_id:       insertedMessageId,
        p_metadata: {
          conversation_id: conversationId,
          role:            row.role,
          model:           "claude-sonnet-4",
          input_tokens:    inputTokens,
          output_tokens:   outputTokens,
          input_chars:     enrichedInputLength,
          output_chars:    (aiText || "").length,
          estimated:       true,
        },
      });
      if (chargeErr) {
        console.error(`[credits] vera_chat RPC error [org=${organizationId}]:`, chargeErr.message);
      } else if (charged === false) {
        console.warn(`[credits] vera_chat: saldo insuficiente [org=${organizationId}] — cobro saltado (cr=${creditsCharge} usd=$${usdCost.toFixed(6)})`);
      } else {
        console.log(`[credits] vera_chat charged ${creditsCharge}cr usd=$${usdCost.toFixed(6)} (in:${inputTokens}t out:${outputTokens}t) org=${organizationId}`);
      }
    } catch (creditErr) {
      console.error(`[credits] vera_chat deduct failed [org=${organizationId}]:`, creditErr?.message || creditErr);
    }
  }
}
