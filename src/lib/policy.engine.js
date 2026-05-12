/**
 * Policy Engine — decide si una acción está permitida para una org/usuario.
 *
 * Capas de verificación (en orden):
 *   1. Plan de la organización   (tabla subscriptions)
 *   2. Rol del usuario           (organization_members / organizations.owner_user_id)
 *   3. Créditos disponibles      (organization_credits) — solo para acciones que los consumen
 */
import { supabase } from "./supabase.js";

// ── Tier maps ──────────────────────────────────────────────────────────────
const PLAN_TIER = { basico: 0, basic: 0, starter: 1, pro: 2, business: 2, enterprise: 3 };
const ROLE_TIER = { viewer: 0, member: 1, user: 1, admin: 2, dev: 2, owner: 3 };

// ── Action rules ───────────────────────────────────────────────────────────
// minPlan / minRole usan los mismos strings de las tablas del DB.
const ACTION_RULES = {
  triggerFlowRun: {
    minPlan: "pro",
    minRole: "admin",
    creditCost: 1,
  },
  createFlowSchedule: {
    minPlan: "starter",
    minRole: "admin",
    creditCost: 0,
  },
  CREATE_CAMPAIGN: {
    minPlan: "basico",
    minRole: "admin",
    creditCost: 0,
  },
  SCHEDULE_FLOW: {
    minPlan: "starter",
    minRole: "admin",
    creditCost: 0,
  },
  TRIGGER_FLOW_RUN: {
    minPlan: "pro",
    minRole: "admin",
    creditCost: 1,
  },
  PUBLISH_ACTIONS: {
    minPlan: "starter",
    minRole: "admin",
    creditCost: 1,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function getOrgContext(organizationId, userId) {
  const [subResult, memberResult, orgResult] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("plan_type, status")
      .eq("organization_id", organizationId)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .maybeSingle(),

    supabase
      .from("organizations")
      .select("owner_user_id")
      .eq("id", organizationId)
      .maybeSingle(),
  ]);

  const isOwner = orgResult.data?.owner_user_id === userId;
  const memberRole = memberResult.data?.role || "viewer";
  const resolvedRole = isOwner ? "owner" : memberRole;
  const planType = subResult.data?.plan_type || "basico";

  return { planType, role: resolvedRole, isOwner };
}

async function checkCredits(organizationId, creditCost) {
  if (!creditCost || creditCost <= 0) return { ok: true };

  const { data } = await supabase
    .from("organization_credits")
    .select("credits_available")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data || data.credits_available < creditCost) {
    return {
      ok: false,
      reason: `Créditos insuficientes. Se necesitan ${creditCost} crédito(s), disponibles: ${data?.credits_available ?? 0}.`,
    };
  }
  return { ok: true };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Verifica si la acción está permitida para esta org/usuario.
 *
 * @param {string} action           — nombre del tool o consent key
 * @param {string} organizationId
 * @param {string} userId
 * @returns {{ allowed: boolean, reason?: string, planType?: string, role?: string }}
 */
export async function checkPolicy(action, organizationId, userId) {
  const rule = ACTION_RULES[action];
  if (!rule) return { allowed: true }; // sin regla = permitido

  const { planType, role } = await getOrgContext(organizationId, userId);

  // 1. Plan check
  const orgPlanTier = PLAN_TIER[planType] ?? 0;
  const requiredPlanTier = PLAN_TIER[rule.minPlan] ?? 0;
  if (orgPlanTier < requiredPlanTier) {
    return {
      allowed: false,
      reason:
        `Tu plan actual ("${planType}") no incluye esta función. ` +
        `Se requiere el plan "${rule.minPlan}" o superior.`,
      planType,
      role,
    };
  }

  // 2. Role check
  const userRoleTier = ROLE_TIER[role] ?? 0;
  const requiredRoleTier = ROLE_TIER[rule.minRole] ?? 0;
  if (userRoleTier < requiredRoleTier) {
    return {
      allowed: false,
      reason: `Tu rol ("${role}") no tiene permisos para ejecutar esta acción.`,
      planType,
      role,
    };
  }

  // 3. Credits check
  if (rule.creditCost > 0) {
    const credCheck = await checkCredits(organizationId, rule.creditCost);
    if (!credCheck.ok) {
      return { allowed: false, reason: credCheck.reason, planType, role };
    }
  }

  return { allowed: true, planType, role };
}

/**
 * Expone el costo en créditos de una acción (0 si no aplica).
 */
export function getActionCreditCost(action) {
  return ACTION_RULES[action]?.creditCost ?? 0;
}
