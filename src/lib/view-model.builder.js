/**
 * View Model Builder — construye la "visión del mundo" que OpenClaw recibe.
 *
 * PRINCIPIO RECTOR:
 *   OpenClaw puede pensar, sugerir y pedir.
 *   AI-ENGINE decide, ejecuta y registra.
 *
 * OpenClaw no ve:
 *   - Tokens, credenciales ni access_tokens
 *   - Filas crudas de la DB
 *   - IDs internos irrelevantes
 *   - Variables de entorno del servidor
 *
 * OpenClaw sí ve:
 *   - identity   → quién es el usuario y qué puede hacer
 *   - brand      → datos de marca interpretados (no crudos)
 *   - integrations → plataformas conectadas (sin tokens, solo disponibilidad)
 *   - capabilities → lista de tools habilitadas en la fase actual
 *   - constraints  → reglas explícitas de lo que NO puede hacer
 *   - memory     → resumen de conversación + objetivo actual
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeTruncate(arr, limit = 10) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, limit);
}

function safeString(val, fallback = null) {
  return typeof val === "string" && val.trim() ? val.trim() : fallback;
}

// ── View model builders por sección ──────────────────────────────────────────

function buildIdentity({ organizationId, userRole, planType }) {
  return {
    organization_id: organizationId,
    user_role: safeString(userRole, "member"),
    plan: safeString(planType, "basico"),
  };
}

function buildBrandView(activeBrand) {
  if (!activeBrand) return null;

  const identity = activeBrand.brand_identity || {};

  return {
    id: activeBrand.id ?? null,          // brandContainerId — necesario para tool calls
    name: safeString(activeBrand.nombre_marca, "Sin nombre"),
    markets: safeTruncate(activeBrand.mercado_objetivo, 5),
    languages: safeTruncate(activeBrand.idiomas_contenido, 5),
    tone: safeTruncate(identity.tono_comunicacion, 5),
    writing_style: safeTruncate(identity.estilo_escritura, 5),
    keywords: safeTruncate(identity.palabras_clave, 15),
    objectives: safeTruncate(identity.objetivos_marca, 5),
    niche: safeTruncate(identity.nicho_mercado, 5),
    archetype: safeTruncate(identity.arquetipo_personalidad, 3),
  };
}

function buildIntegrationsView(integrations) {
  // OpenClaw solo ve plataformas disponibles y si están activas
  // NUNCA tokens, refresh_tokens, ni encryption_iv
  return safeTruncate(integrations, 10).map((i) => ({
    platform: i.platform ?? null,
    account: i.external_account_name ?? null,
    active: Boolean(i.is_active),
    last_sync: i.last_sync_at ?? null,
  }));
}

function buildActivityView(orgContext) {
  return {
    brand_containers_count: (orgContext.brand_containers || []).length,
    // IDs expuestos para que Vera pueda usarlos en tool calls
    brand_containers: (orgContext.brand_containers || []).map((bc) => ({
      id: bc.id,
      nombre_marca: bc.nombre_marca,
    })),
    active_schedules_count: (orgContext.active_schedules || []).length,
    recent_run_statuses: (orgContext.recent_flow_runs || [])
      .slice(0, 5)
      .map((r) => ({ status: r.status, flow_id: r.flow_id })),
  };
}

// ── CONSTRAINTS base (siempre aplican) ───────────────────────────────────────

const BASE_CONSTRAINTS = [
  "no_direct_db_access",
  "no_direct_credentials",
  "no_cross_org_data",
  "no_browser_access",
  "no_external_api_calls",
];

// Constraints adicionales según el nivel de autonomía
const CONSTRAINTS_BY_CONSENT_MODE = {
  block_all: ["no_write_actions_allowed", "read_only_mode"],
  require:   ["write_actions_require_human_consent"],
  auto:      ["write_actions_within_policy_and_credits"],
};

// ── Public API ────────────────────────────────────────────────────────────────

// ── Autonomy section ──────────────────────────────────────────────────────────

const AUTONOMY_DESCRIPTIONS = {
  restringido: {
    label: "restringido",
    can_publish: false,
    // can_use_integration_tokens omitido a propósito — en restringido Vera
    // no debe enterarse de que el concepto "integraciones/tokens" existe.
    instructions: [
      "SOLO puedes leer datos de la organización, analizar y redactar contenido. No ejecutas ninguna acción.",
      "Si el usuario pide modificar datos, publicar o programar algo: explícale que necesita subir el nivel de autonomía a 'parcial' o 'total' en Configuración → Organización.",
      "Ofrece siempre dejar el contenido listo para que el usuario lo aplique manualmente.",
    ],
  },
  parcial: {
    label: "parcial",
    can_publish: false,
    can_use_integration_tokens: true,
    instructions: [
      "Puedes LEER y MODIFICAR libremente todo lo que vive dentro de la plataforma: perfil de marca, audiencias, productos, colores, fuentes, reglas, monitoreo de competidores, etc. Esos cambios NO requieren confirmación.",
      "Puedes consultar métricas de redes sociales — ai-engine actúa como puente con las APIs externas, tú nunca ves los tokens.",
      "Lo que SÍ requiere aprobación humana: publicar, programar o ejecutar flows que actúan SOBRE plataformas externas (publicación en Meta/Instagram, schedule de campañas que afectan al exterior). Para esas acciones presenta el plan y pide APPROVE_ACTION.",
      "Si el usuario quiere publicación autónoma sin aprobar cada vez: explícale que debe cambiar a nivel 'total' en Configuración → Organización.",
    ],
  },
  total: {
    label: "total",
    can_publish: true,
    can_use_integration_tokens: true,
    instructions: [
      "Tienes autonomía completa: puedes leer y modificar todo dentro de la plataforma, y además publicar, programar y ejecutar flows hacia plataformas externas sin pedir confirmación.",
      "Opera dentro de los límites de crédito y las reglas de marca de la organización.",
      "Aún en este nivel, ai-engine es quien usa los tokens de integración — tú nunca los ves directamente.",
    ],
  },
};

function buildAutonomyView(autonomy) {
  const desc = AUTONOMY_DESCRIPTIONS[autonomy?.level] ?? AUTONOMY_DESCRIPTIONS.restringido;
  const view = {
    level: desc.label,
    org_name: autonomy?.orgName ?? "tu organización",
    can_publish_autonomously: desc.can_publish,
    instructions: desc.instructions,
  };
  // En restringido NO exponemos el concepto de tokens de integración —
  // Vera ni siquiera debe saber que ese eje existe en este nivel.
  if (desc.can_use_integration_tokens !== undefined) {
    view.can_use_integration_tokens = desc.can_use_integration_tokens;
  }
  return view;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Construye el view model seguro para OpenClaw.
 *
 * @param {object} opts
 * @param {object}   opts.orgContext        — retornado por buildOrgContext()
 * @param {string}   opts.organizationId
 * @param {string}   opts.userRole          — rol resuelto del usuario en la org
 * @param {string}   opts.planType          — plan activo de la org
 * @param {string[]} opts.allowedTools      — tools habilitadas en la fase actual
 * @param {Set}      opts.approvedIntents   — intents que el usuario ya aprobó
 * @param {object}   opts.memory            — { summary, goal, totalMessages }
 * @param {object}   [opts.autonomy]        — retornado por getOrgAutonomy()
 * @param {object}   [opts.autonomyNotice]  — aviso de cambio de nivel (from/to/changedAt)
 * @returns {object} view model — lo único que OpenClaw recibe como contexto
 */
export function buildViewModel({
  orgContext,
  organizationId,
  userRole,
  planType,
  allowedTools,
  approvedIntents,
  memory,
  autonomy,
  autonomyNotice,
}) {
  const capabilities = Array.isArray(allowedTools) ? [...allowedTools] : [];

  const approvedList =
    approvedIntents instanceof Set ? [...approvedIntents] : [];

  return {
    identity: buildIdentity({ organizationId, userRole, planType }),

    brand: buildBrandView(orgContext?.active_brand ?? null),

    // En restringido Vera no debe enterarse de que existen integraciones —
    // ni en la lista ni en los hints de can_use_tokens. Cero menciones.
    integrations: autonomy?.level === "restringido"
      ? []
      : buildIntegrationsView(orgContext?.integrations ?? []),

    activity: buildActivityView(orgContext ?? {}),

    autonomy: {
      ...buildAutonomyView(autonomy),
      // Si el nivel bajó recientemente, Vera recibe este aviso una sola vez
      permission_revoked_notice: autonomyNotice
        ? {
            message:
              `⚠️ AVISO DE SISTEMA: El usuario de ${autonomyNotice.orgName ?? "la organización"} ` +
              `ha reducido tu nivel de autonomía de **${autonomyNotice.from}** a **${autonomyNotice.to}**. ` +
              `Todos tus permisos anteriores han sido revocados. ` +
              `Desde ahora opera exclusivamente en modo **${autonomyNotice.to}** — ` +
              `si el usuario solicita acciones que ya no están permitidas, ` +
              `explícale que necesitará restaurar el nivel de autonomía para que puedas ejecutarlas.`,
            previous_level: autonomyNotice.from,
            current_level: autonomyNotice.to,
          }
        : null,
    },

    capabilities,

    approved_intents: approvedList,

    constraints: [
      ...BASE_CONSTRAINTS,
      ...(CONSTRAINTS_BY_CONSENT_MODE[autonomy?.consentMode] ?? CONSTRAINTS_BY_CONSENT_MODE.require),
    ],

    memory: {
      conversation_summary: memory?.summary ?? null,
      current_goal: memory?.goal ?? null,
      message_count: memory?.totalMessages ?? 0,
    },
  };
}
