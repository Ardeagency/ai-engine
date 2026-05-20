/**
 * OpenClaw Adapter — interfaz entre AI Engine y el agente OpenClaw de cada organización.
 *
 *   modo 'remote' → HTTP fetch al org-server dedicado en Hetzner
 *     POST http://<serverIp>:3001/agent/run  con header X-Org-Token
 *
 * Aislamiento multi-tenant:
 *   - Cada llamada DEBE incluir organizationId válido y registrado.
 *   - NO existe fallback a un agente compartido.
 *   - Si el agente no está provisionado, se retorna error (no datos de otra org).
 *   - El sessionKey siempre incluye organizationId → no hay colisión entre orgs.
 */
import { getOrgEntry } from "./openclaw.registry.js";
import { processAttachments } from "./media-processor.service.js";

const OPENCLAW_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS) || 60_000;
const SESSION_TTL_MS      = 2 * 60 * 60 * 1000; // 2 horas

// ── Session store ─────────────────────────────────────────────────────────────
// Clave: "<organizationId>:<conversationId>" — jamás sin organizationId.
const _sessionStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sessionStore.entries()) {
    if (now - v.lastUsed > SESSION_TTL_MS) _sessionStore.delete(k);
  }
}, 10 * 60 * 1000);

function _getOrCreateSessionId(sessionKey) {
  const existing = _sessionStore.get(sessionKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.clawSessionId;
  }
  const newId = `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _sessionStore.set(sessionKey, { clawSessionId: newId, lastUsed: Date.now() });
  return newId;
}

// ── Message builder ───────────────────────────────────────────────────────────

function _buildEnrichedMessage({ message, attachmentsContext, viewModel, toolResults, serializedBrandData, recentHistory = [], conversationId = null }) {
  const parts = [];

  // Conversation ID — Vera lo usa cuando invoca tools vía MCP que requieren consent.
  // ai-engine carga TASK_EVENTs (APPROVE_ACTION) desde la DB usando este id.
  if (conversationId) {
    parts.push(
      `[CONVERSATION_ID: ${conversationId}]\n` +
      `Si invocas una tool que requiere APPROVE_ACTION, pásalo como _conversationId en los params para que el consent gate lo encuentre. Ejemplo: [[TOOL:createFlowSchedule|_conversationId:${conversationId}|...]]`
    );
  }

  if (viewModel?.identity) {
    const orgName = viewModel?.brand?.name ?? "Organización";
    parts.push(
      `[SESIÓN DE TRABAJO]\n` +
      `Organización: ${orgName}\n` +
      `Plan: ${viewModel.identity.plan}\n` +
      `Rol del usuario: ${viewModel.identity.user_role}`
    );
  }

  // ── Contrato dinámico de capacidades — alimenta a Vera con la verdad del turno
  // Esto evita que Vera diga "no puedo" cuando una tool sí está habilitada,
  // y que intente llamar tools fuera de su nivel actual de autonomía.
  if (viewModel?.autonomy) {
    const aut = viewModel.autonomy;
    const autLines = [`[NIVEL DE AUTONOMÍA: ${aut.level}]`];
    if (Array.isArray(aut.instructions)) {
      for (const line of aut.instructions) autLines.push(`• ${line}`);
    }
    if (aut.permission_revoked_notice?.message) {
      autLines.push("", aut.permission_revoked_notice.message);
    }
    parts.push(autLines.join("\n"));
  }

  if (Array.isArray(viewModel?.capabilities) && viewModel.capabilities.length) {
    const level = viewModel?.autonomy?.level ?? "actual";
    parts.push(
      `[HERRAMIENTAS DISPONIBLES EN ESTE TURNO]\n` +
      `Estas son las ÚNICAS tools que puedes invocar ahora mismo.\n\n` +
      `REGLA CRÍTICA: si el usuario pide algo y la tool necesaria NO aparece en esta lista, ` +
      `NO digas "no sé hacerlo" ni "no tengo acceso". Di explícitamente: ` +
      `"Esa capacidad no está habilitada en mi nivel de autonomía actual (**${level}**). ` +
      `El usuario puede ajustar el nivel en Configuración → Organización → Nivel de autonomía."\n\n` +
      `Tools habilitadas: ${viewModel.capabilities.join(", ")}\n\n` +
      `Sintaxis para invocar: [[TOOL:nombre|param1:valor1|param2:valor2]]\n` +
      `El sistema resuelve organizationId y brandContainerId automáticamente — no los pases.`
    );
  }

  // Historial reciente — se inyecta desde la DB para que OpenClaw no repita
  if (recentHistory?.length > 1) {
    const prev = recentHistory.slice(0, -1);
    if (prev.length > 0) {
      const historyText = prev
        .map((m) => {
          const role    = m.role === "user" ? "Usuario" : "Vera";
          const content = String(m.content || "").slice(0, 400);
          return `${role}: ${content}`;
        })
        .join("\n");
      parts.push(
        `[HISTORIAL RECIENTE — solo para contexto, NO repetir]\n` +
        `${historyText}\n\n` +
        `⚠ INSTRUCCIÓN CRÍTICA: El historial anterior es solo contexto. ` +
        `NO reproduzcas ni resumas lo que ya dijiste. ` +
        `Responde ÚNICAMENTE al nuevo mensaje del usuario que aparece abajo.`
      );
    }
  }

  if (serializedBrandData) {
    parts.push(serializedBrandData);
  } else {
    const brandContainers = viewModel?.activity?.brand_containers;
    if (brandContainers?.length) {
      const brandsText = brandContainers.map((bc) => `  - ${bc.nombre_marca}`).join("\n");
      parts.push(
        `[MARCAS DE LA ORGANIZACIÓN]\n${brandsText}\n\n` +
        `Nota: No necesitas pasar ningún ID para usar las herramientas — el sistema lo resuelve automáticamente.`
      );
    }
    if (viewModel?.brand?.name) {
      parts.push(
        `[MARCA ACTIVA]: ${viewModel.brand.name}\n` +
        (viewModel.brand.tone?.length    ? `Tono: ${viewModel.brand.tone.join(", ")}\n` : "") +
        (viewModel.brand.keywords?.length ? `Keywords: ${viewModel.brand.keywords.slice(0, 8).join(", ")}` : "")
      );
    }
  }

  if (toolResults?.length) {
    const resultsText = toolResults
      .map((r) => `  • ${r.tool}: ${JSON.stringify(r.result ?? r.error).slice(0, 800)}`)
      .join("\n");
    parts.push(`[RESULTADOS ADICIONALES]\n${resultsText}`);
  }

  if (attachmentsContext) {
    parts.push(`[ARCHIVOS ADJUNTOS DEL USUARIO]\n${attachmentsContext}`);
  }

  // Permisos de formato — Vera tiene libertad Markdown completa.
  // El frontend (VeraView.renderMarkdown) renderiza tablas, code blocks con syntax
  // highlighting, mermaid, math, listas, headings, blockquotes, imágenes y links.
  // Decirle explícitamente al modelo qué puede usar evita auto-restricción.
  parts.push(
    `[FORMATO DE RESPUESTA]\n` +
    `Tienes libertad total de formato Markdown. Úsalo cuando aporte claridad y haga la respuesta más útil:\n` +
    `• Tablas Markdown (GFM) para comparaciones y datos tabulares\n` +
    `• Bloques de código con lenguaje (\`\`\`js, \`\`\`sql, \`\`\`json, etc.) — se renderizan con syntax highlighting\n` +
    `• Diagramas Mermaid para flujos, jerarquías y mapas mentales:\n` +
    `  \`\`\`mermaid\n  graph LR\n    A[Marca] --> B[Tendencia]\n  \`\`\`\n` +
    `• Listas (- / 1.), checklists (- [ ]), headings (# ## ###), blockquotes (>), separadores (---)\n` +
    `• Bold (**texto**), italic (*texto*), strikethrough (~~texto~~), inline \`code\`\n` +
    `• Imágenes ![alt](url) y links [texto](url)\n` +
    `• Math con LaTeX entre $$ ... $$ si calculas métricas\n` +
    `• Bloques especiales: \`\`\`chart (visualizaciones SVG) y \`\`\`buttons (quick replies)\n\n` +
    `NO uses HTML con <script> ni atributos de evento (onclick, onerror) — el cliente los bloquea.\n` +
    `Elige el formato más útil para la pregunta. No te limites a párrafos; aprovecha el formato.`
  );

  // Delimitadores explícitos — previene prompt injection
  const userSection = message
    ? `--- INICIO MENSAJE USUARIO ---\n${message}\n--- FIN MENSAJE USUARIO ---`
    : `--- INICIO MENSAJE USUARIO ---\n[El usuario envió archivos adjuntos sin texto adicional.]\n--- FIN MENSAJE USUARIO ---`;

  parts.push(userSection);
  return parts.join("\n\n");
}

/**
 * Parsea JSON tolerando caracteres de control no escapados dentro de strings.
 * OpenClaw a veces emite \n / \r / \t literales en sus payloads.text en lugar
 * de las secuencias escapadas \\n / \\r / \\t — JSON.parse estricto revienta.
 *
 * Estrategia: intentar parse normal primero (caso 99%); si falla, sanitizar
 * solo los caracteres de control DENTRO de strings JSON y reintentar.
 */
function _safeJsonParse(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    const sanitized = jsonStr.replace(/"((?:[^"\\]|\\.)*)"/g, (match, body) => {
      const cleaned = body.replace(/[\x00-\x1F]/g, (c) => {
        const code = c.charCodeAt(0);
        if (code === 0x0A) return "\\n";
        if (code === 0x0D) return "\\r";
        if (code === 0x09) return "\\t";
        if (code === 0x08) return "\\b";
        if (code === 0x0C) return "\\f";
        return "\\u" + code.toString(16).padStart(4, "0");
      });
      return '"' + cleaned + '"';
    });
    const result = JSON.parse(sanitized);
    console.warn("openclaw.adapter: parse recuperado tras sanitizar caracteres de control");
    return result;
  }
}

// ── Response parser ───────────────────────────────────────────────────────────

function _extractToolCallMarkers(text) {
  const tool_calls = [];
  const pattern    = /\[\[TOOL:([a-zA-Z_]+)(?:\|([^\]]*))?\]\]/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const toolName  = match[1].trim();
    const paramsRaw = match[2] || "";
    const params    = {};
    if (paramsRaw) {
      paramsRaw.split("|").forEach((pair) => {
        const colonIdx = pair.indexOf(":");
        if (colonIdx !== -1) {
          const key = pair.slice(0, colonIdx).trim();
          const val = pair.slice(colonIdx + 1).trim();
          if (key) params[key] = val;
        }
      });
    }
    tool_calls.push({ name: toolName, params });
  }

  const cleanText = text.replace(/\[\[TOOL:[^\]]*\]\]/g, "").trim();
  return { tool_calls, cleanText };
}

/**
 * Extrae UN objeto JSON balanceado del string a partir de `from`.
 * Cuenta llaves respetando strings y escapes.
 * Retorna { blob, end } o null.
 */
function _extractJsonObjectFrom(txt, from = 0) {
  const start = txt.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < txt.length; i++) {
    const c = txt[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { blob: txt.slice(start, i + 1), end: i + 1 };
    }
  }
  return null; // no balanceado
}

/**
 * Divide la respuesta cruda en segmentos ORDENADOS preservando TODO el contenido:
 *   - Texto antes del primer JSON
 *   - Cada bloque JSON (parseado si se puede)
 *   - Texto entre JSONs
 *   - Texto después del último JSON
 *
 * Esto permite que OpenClaw responda con creatividad total: prosa + JSON
 * (charts, datos estructurados, payloads) intercalados como quiera, sin que
 * ai-engine descarte nada. Cada segmento conserva su orden original.
 *
 * Retorna [{ kind: "text"|"json", content }, ...]
 */
function _splitResponseSegments(txt) {
  const segments = [];
  let cursor = 0;
  while (cursor < txt.length) {
    const nextBrace = txt.indexOf("{", cursor);

    // No quedan { → todo lo restante es texto
    if (nextBrace === -1) {
      const rest = txt.slice(cursor).trim();
      if (rest) segments.push({ kind: "text", content: rest });
      break;
    }

    // Texto previo a este { — se preserva como markdown
    const before = txt.slice(cursor, nextBrace).trim();
    if (before) segments.push({ kind: "text", content: before });

    // Intentar extraer JSON balanceado
    const obj = _extractJsonObjectFrom(txt, nextBrace);
    if (!obj) {
      // Llave sin cerrar — tratamos el resto como texto
      const rest = txt.slice(nextBrace).trim();
      if (rest) segments.push({ kind: "text", content: rest });
      break;
    }

    try {
      const parsed = _safeJsonParse(obj.blob);
      segments.push({ kind: "json", content: parsed });
    } catch (e) {
      // No era JSON real (ej: un objeto JS no estricto, o un {} accidental en prosa)
      // → preservar como texto literal, no descartar
      segments.push({ kind: "text", content: obj.blob });
      console.warn(`openclaw.adapter: bloque {} no parseable como JSON, preservado como texto: ${e.message}`);
    }
    cursor = obj.end;
  }
  return segments;
}

/**
 * Extrae el texto utilizable de un objeto JSON emitido por OpenClaw.
 * Maneja las formas conocidas (payloads[].text, .text, .message, .content);
 * para objetos de forma desconocida los embebe como bloque ```json para que
 * el frontend los renderice (Vera puede emitir charts/data como objetos).
 */
function _extractTextFromJsonSegment(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Forma estándar OpenClaw: { payloads: [{ text }] }
  if (Array.isArray(obj.payloads)) {
    const parts = [];
    for (const p of obj.payloads) {
      if (typeof p === "string") { parts.push(p); continue; }
      const t = p?.text ?? p?.content ?? p?.markdown ?? null;
      if (t) parts.push(t);
      else parts.push("```json\n" + JSON.stringify(p, null, 2) + "\n```");
    }
    if (parts.length) return parts.join("\n\n");
  }

  // Formas alternas
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.markdown === "string") return obj.markdown;

  // Objetos meta-only (solo sessionId, audit, etc.) → no aportan texto, devolver null
  const onlyMeta = Object.keys(obj).every((k) => ["meta", "sessionId", "ok", "status", "event", "at"].includes(k));
  if (onlyMeta) return null;

  // Forma desconocida → embedir como JSON code block para que Vera lo vea
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

// Raw response logging — preserves the full payload so podemos auditar lo que
// OpenClaw realmente emite (charts, multi-payload, formatos custom).
// Cap simple: si pasa de 5 MB, trunca al frente (mantiene últimas respuestas).
const RAW_LOG_PATH = "/var/log/openclaw-raw.log";
const RAW_LOG_MAX_BYTES = 5 * 1024 * 1024;
async function _logRawResponse(raw, meta) {
  try {
    const { promises: fsp, existsSync } = await import("node:fs");
    const stat = existsSync(RAW_LOG_PATH) ? await fsp.stat(RAW_LOG_PATH) : { size: 0 };
    if (stat.size > RAW_LOG_MAX_BYTES) {
      const data = await fsp.readFile(RAW_LOG_PATH);
      await fsp.writeFile(RAW_LOG_PATH, data.slice(data.length - RAW_LOG_MAX_BYTES / 2));
    }
    const header = `\n===== ${new Date().toISOString()} | org=${meta?.org || "?"} | conv=${meta?.conv || "?"} =====\n`;
    await fsp.appendFile(RAW_LOG_PATH, header + raw + "\n");
  } catch (_) { /* never block on logging */ }
}

function _normalizeOpenClawResponse(raw, meta = {}) {
  // Persistir respuesta cruda completa — clave para que el auto-repair y un
  // humano puedan ver qué formato emitió OpenClaw cuando algo se ve raro.
  _logRawResponse(raw, meta);

  try {
    const txt = String(raw || "").trim();
    if (!txt) {
      return { text: "Sin respuesta.", tool_calls: [], requires_consent: false, returnedSessionId: null };
    }

    const segments = _splitResponseSegments(txt);

    // Combinar segmentos en orden, preservando TODO lo que OpenClaw quiso decir
    const textParts = [];
    let returnedSessionId = null;
    let jsonCount = 0;
    let textCount = 0;

    for (const seg of segments) {
      if (seg.kind === "text") {
        textParts.push(seg.content);
        textCount++;
      } else {
        const o = seg.content;
        const t = _extractTextFromJsonSegment(o);
        if (t) textParts.push(t);

        // sessionId: tomar el primero que aparezca
        if (!returnedSessionId) {
          returnedSessionId = o?.meta?.agentMeta?.sessionId || o?.sessionId || null;
        }
        jsonCount++;
      }
    }

    const combinedText = textParts.filter(Boolean).join("\n\n") || "Sin respuesta.";
    const { tool_calls, cleanText } = _extractToolCallMarkers(combinedText);

    if (tool_calls.length > 0) {
      console.log(
        `openclaw.adapter: Vera solicita ${tool_calls.length} herramienta(s):`,
        tool_calls.map((t) => t.name).join(", ")
      );
    }
    if (segments.length > 1 || (jsonCount > 0 && textCount > 0)) {
      console.log(`openclaw.adapter: respuesta multi-segmento (${segments.length} segs, ${jsonCount} json, ${textCount} texto)`);
    }

    return { text: cleanText, tool_calls, requires_consent: false, returnedSessionId };
  } catch (e) {
    console.error("openclaw.adapter: parse error:", e.message);
    console.error("openclaw.adapter: raw response → /var/log/openclaw-raw.log");
    // Fail-open: devolvemos el raw como texto para que el usuario VEA algo
    // en vez de un genérico "error procesando". Si era markdown, se renderiza.
    return {
      text: String(raw || "").slice(0, 8000) || "Error procesando respuesta del agente.",
      tool_calls: [],
      requires_consent: false,
      returnedSessionId: null,
    };
  }
}

// ── Modo remoto: HTTP fetch al org-server ─────────────────────────────────────

async function _callRemoteOpenClaw({ orgEntry, agentId, enrichedMessage, clawSessionId }) {
  const url = `http://${orgEntry.ip}:${orgEntry.port}/agent/run`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Org-Token":  orgEntry.token,
    },
    body: JSON.stringify({
      agentId,
      message:   enrichedMessage,
      sessionId: clawSessionId,
    }),
    // Timeout del lado del control plane = OPENCLAW_TIMEOUT_MS + 5s de red
    signal: AbortSignal.timeout(OPENCLAW_TIMEOUT_MS + 5_000),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`org-server respondió ${res.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`org-server error: ${data.error || "respuesta inesperada"}`);
  }

  return data.output || "";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Llama al agente OpenClaw de la organización.
 *
 * Despacha a modo local o remoto según el tipo de entrada en el registry.
 *
 * SEGURIDAD:
 *   - organizationId DEBE estar presente y registrado en el registry.
 *   - NO existe fallback a un agente compartido.
 *   - Si el agente falla, se retorna error (no se redirige a otra org).
 */
export async function callOpenClaw({
  message,
  attachments = [],
  viewModel,
  sessionId,
  toolResults,
  serializedBrandData,
  recentHistory = [],
  conversationId = null,
}) {
  const organizationId = viewModel?.identity?.organization_id;

  if (!organizationId || organizationId === "unknown") {
    console.error("openclaw.adapter: llamada sin organizationId válido — bloqueada");
    return {
      text:             "Error interno: contexto de organización no disponible.",
      tool_calls:       [],
      requires_consent: false,
    };
  }

  const orgEntry = getOrgEntry(organizationId);
  if (!orgEntry) {
    console.error(`openclaw.adapter: org "${organizationId}" sin agente registrado — NO hay fallback`);
    return {
      text:             "El agente de esta organización no está disponible. Por favor intenta en unos momentos.",
      tool_calls:       [],
      requires_consent: false,
    };
  }

  // Detectar org en sleep — no tiene sentido intentar llamarla
  if (orgEntry.status === "sleeping") {
    console.warn(`openclaw.adapter: org "${organizationId}" está en sleep — despertando...`);
    return {
      text:             "Tu asistente está iniciando. Por favor vuelve a intentarlo en aproximadamente 90 segundos.",
      tool_calls:       [],
      requires_consent: false,
    };
  }

  const { agentId } = orgEntry;

  const sessionKey    = sessionId || `${organizationId}:default`;
  const clawSessionId = _getOrCreateSessionId(sessionKey);

  let attachmentsContext = "";
  if (attachments?.length) {
    try {
      attachmentsContext = await processAttachments(attachments);
    } catch (e) {
      console.warn("openclaw.adapter: error procesando attachments:", e.message);
    }
  }

  const enrichedMessage = _buildEnrichedMessage({
    message, attachmentsContext, viewModel, toolResults, serializedBrandData, recentHistory,
    conversationId,
  });

  try {
    console.log(`openclaw.adapter: [remote] org "${organizationId}" → ${orgEntry.ip}:${orgEntry.port}`);
    const raw = await _callRemoteOpenClaw({ orgEntry, agentId, enrichedMessage, clawSessionId });

    const normalized = _normalizeOpenClawResponse(raw, { org: organizationId, conv: conversationId });

    if (normalized.returnedSessionId) {
      _sessionStore.set(sessionKey, {
        clawSessionId: normalized.returnedSessionId,
        lastUsed:      Date.now(),
      });
    }

    return normalized;
  } catch (e) {
    console.error(
      `openclaw.adapter: agente "${agentId}" (org "${organizationId}" [${orgEntry.type}]) falló:`,
      e.message
    );
    return {
      text:             "El agente no pudo procesar la solicitud en este momento. Por favor intenta nuevamente.",
      tool_calls:       [],
      requires_consent: false,
    };
  }
}
