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
import { renderEnabledToolsBlock } from "../lib/tool-catalog.js";

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

  // Conversation ID — INTERNO. Vera lo usa solo para invocar tools que requieren
  // consent (APPROVE_ACTION). NUNCA debe aparecer en la respuesta al usuario.
  if (conversationId) {
    parts.push(
      `[SYSTEM_INTERNAL — NO MOSTRAR AL USUARIO]\n` +
      `Este bloque es plomería interna. NO lo cites, NO lo repitas, NO lo muestres ` +
      `en tu respuesta al usuario. El usuario NO debe enterarse de que existe un ` +
      `conversation_id ni de ningún ID interno.\n\n` +
      `conversation_id = ${conversationId}\n\n` +
      `Uso permitido (único): si invocas una tool que requiere APPROVE_ACTION, pásalo ` +
      `como _conversationId en los params. Ejemplo:\n` +
      `[[TOOL:createFlowSchedule|_conversationId:${conversationId}|...]]\n` +
      `Cualquier otro uso (citar, mostrar, mencionar) es una violación de la regla.`
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
    // Renderizado desde el catalogo unico (lib/tool-catalog.js): cada tool que
    // necesita params se muestra con su forma exacta; el resto por nombre.
    // Antes aqui se volcaba solo `capabilities.join(", ")` (nombres pelados),
    // y Vera adivinaba el shape de params → errores.
    parts.push(renderEnabledToolsBlock(viewModel.capabilities, level));
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
      .map((r) => `  • ${r.tool}: ${JSON.stringify(r.result ?? r.error).slice(0, 4000)}`)
      .join("\n");
    parts.push(`[RESULTADOS ADICIONALES]\n${resultsText}`);
  }

  if (attachmentsContext) {
    parts.push(`[ARCHIVOS ADJUNTOS DEL USUARIO]\n${attachmentsContext}`);
  }

  // Permisos de formato + protocolo de componentes interactivos.
  // El frontend (VeraView.renderMarkdown) renderiza markdown vía marked+DOMPurify
  // y los bloques propios [CLARIFY] [PILLS] [STEPS] [METRICS] [ACTIONS] vía
  // VeraView._renderInteractiveBlock. Decirle al modelo la sintaxis exacta evita
  // que invente variantes que el render no reconoce.
  parts.push(
    `[FORMATO DE RESPUESTA]\n` +
    `Tienes libertad total de formato. Usa Markdown estándar cuando aporte claridad:\n` +
    `• Tablas GFM, bloques de código con lenguaje, listas, headings, blockquotes, separadores\n` +
    `• Bold (**texto**), italic (*texto*), inline \`code\`, links [texto](url)\n` +
    `• Diagramas Mermaid (\`\`\`mermaid), visualizaciones (\`\`\`chart), quick replies (\`\`\`buttons)\n` +
    `• Widgets HTML completos con \`\`\`html — HTML + CSS + JS en un bloque. Se ejecuta ` +
    `en iframe sandbox null-origin (sin acceso a la sesión del usuario). Puedes usar ` +
    `Chart.js, ECharts, D3, cualquier CDN público. El iframe se auto-redimensiona.\n` +
    `• Artifacts interactivos con \`\`\`artifact — igual que \`\`\`html pero con barra ` +
    `de título y botón de pantalla completa. Úsalo para dashboards, calculadoras o ` +
    `herramientas complejas que el usuario vaya a usar más de una vez.\n\n` +
    `PROTOCOLO DE COMPONENTES INTERACTIVOS\n` +
    `Cuando necesites que el usuario aclare algo, usa [CLARIFY] en lugar de hacer preguntas en prosa:\n\n` +
    `[CLARIFY]\n` +
    `PREGUNTA: ¿Cuál es tu objetivo principal?\n` +
    `- CARD | 🎯 | Crecer audiencia | Llegar a nuevos seguidores\n` +
    `- CARD | 💰 | Vender productos | Convertir seguidores en compradores\n` +
    `- CARD | ❤️ | Fidelizar comunidad | Engagement con audiencia existente\n` +
    `[/CLARIFY]\n\n` +
    `Para opciones rápidas tipo selección múltiple:\n` +
    `[PILLS]\n` +
    `LABEL: ¿Cuántos posts al mes?\n` +
    `- 8–12 posts\n` +
    `- 16–20 posts\n` +
    `- +30 posts\n` +
    `[/PILLS]\n\n` +
    `Para procesos o instrucciones paso a paso:\n` +
    `[STEPS]\n` +
    `1. Primer paso del proceso\n` +
    `2. Segundo paso\n` +
    `3. Tercer paso\n` +
    `[/STEPS]\n\n` +
    `Para mostrar números o métricas clave:\n` +
    `[METRICS]\n` +
    `- Alcance estimado | 45K | cuentas únicas/mes\n` +
    `- Engagement rate | 4.2% | promedio del sector\n` +
    `[/METRICS]\n\n` +
    `Para sugerir el siguiente paso. CADA accion es un mensaje que el usuario te ENVIARA si la clickea — redactala como una peticion del usuario hacia ti (ej. \"Genera el brief\", \"Conecta la cuenta de IGNIS\"), NUNCA como \"ir a tal pagina\" o navegacion:\n` +
    `[ACTIONS]\n` +
    `- Generar brief de contenido para el mes\n` +
    `- Analizar competencia en Instagram\n` +
    `[/ACTIONS]\n\n` +
    `REGLAS DE USO:\n` +
    `• Usa [CLARIFY] cuando necesites información del usuario antes de proceder — nunca hagas preguntas en párrafo si puedes usar cards.\n` +
    `• Usa [PILLS] para selecciones rápidas de 2-5 opciones cortas.\n` +
    `• Usa [STEPS] para cualquier proceso secuencial de 3+ pasos.\n` +
    `• Usa [METRICS] cuando presentes 2+ números o KPIs juntos.\n` +
    `• Usa [ACTIONS] al final de analisis largos. Cada item se envia como mensaje conversacional del usuario al clickearlo — frasealo como peticion directa, no como redireccion.\n` +
    `• Los bloques van en su propio párrafo, nunca dentro de una oración.\n` +
    `• NO uses HTML con <script> ni atributos de evento (onclick, onerror).`
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
  let cleanText = "";
  const N = text.length;
  let i = 0;

  while (i < N) {
    const idx = text.indexOf("[[TOOL:", i);
    if (idx === -1) { cleanText += text.slice(i); break; }
    cleanText += text.slice(i, idx);

    // 1) Tool name: chars validos despues de "[[TOOL:"
    let j = idx + 7; // length of "[[TOOL:"
    let nameEnd = j;
    while (nameEnd < N && /[a-zA-Z0-9_]/.test(text[nameEnd])) nameEnd++;
    const toolName = text.slice(j, nameEnd);
    j = nameEnd;

    // 2) Cuerpo: cero params -> "]]", o params -> "|...]]"
    if (text[j] === "]" && text[j + 1] === "]") {
      tool_calls.push({ name: toolName, params: {} });
      i = j + 2; continue;
    }
    if (text[j] !== "|") {
      // marker mal formado; preservar el "[" en cleanText y avanzar 1 char
      cleanText += "[";
      i = idx + 1;
      continue;
    }

    // 3) Leer params hasta "]]" balanceado al nivel 0 (respetando {}, [], "")
    let depth = 0;
    let inStr = false;
    let escape = false;
    const pStart = j + 1;
    let pEnd = -1;
    let k = j + 1;
    while (k < N) {
      const c = text[k];
      if (escape) { escape = false; k++; continue; }
      if (inStr) {
        if (c === "\\") escape = true;
        else if (c === "\"") inStr = false;
        k++; continue;
      }
      if (c === "\"") { inStr = true; k++; continue; }
      if (c === "{" || c === "[") { depth++; k++; continue; }
      if (c === "}") { if (depth > 0) depth--; k++; continue; }
      if (c === "]") {
        if (depth > 0) { depth--; k++; continue; }
        // depth 0 -> chequear si es "]]" cierre del marker
        if (text[k + 1] === "]") { pEnd = k; break; }
        k++; continue;
      }
      k++;
    }
    if (pEnd === -1) {
      // No hay cierre -> tratar como texto y avanzar 1
      cleanText += "[";
      i = idx + 1;
      continue;
    }

    const paramsRaw = text.slice(pStart, pEnd);
    const params = {};

    // 4) Split params en pairs por "|" a nivel 0
    const pairs = _splitTopLevel(paramsRaw, "|");
    for (const pair of pairs) {
      const colonIdx = _firstTopLevelChar(pair, ":");
      if (colonIdx === -1) continue;
      const key = pair.slice(0, colonIdx).trim();
      const valRaw = pair.slice(colonIdx + 1).trim();
      if (!key) continue;
      // Si el valor parece JSON (objeto o array) intentar parse; si no, string
      let val = valRaw;
      if ((valRaw.startsWith("{") && valRaw.endsWith("}")) ||
          (valRaw.startsWith("[") && valRaw.endsWith("]"))) {
        try { val = JSON.parse(valRaw); } catch { /* keep as raw string */ }
      }
      params[key] = val;
    }

    tool_calls.push({ name: toolName, params });
    i = pEnd + 2; // skip "]]"
  }

  return { tool_calls, cleanText: cleanText.trim() };
}

// Split de un string por separador `sep` solo al nivel 0 (respeta {}, [], "")
function _splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{" || c === "[") { depth++; continue; }
    if (c === "}" || c === "]") { if (depth > 0) depth--; continue; }
    if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start <= s.length) parts.push(s.slice(start));
  return parts;
}

// Indice del primer caracter `ch` a nivel 0 (respeta {}, [], "")
function _firstTopLevelChar(s, ch) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{" || c === "[") { depth++; continue; }
    if (c === "}" || c === "]") { if (depth > 0) depth--; continue; }
    if (c === ch && depth === 0) return i;
  }
  return -1;
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
 * Detecta si un objeto JSON tiene forma de chart spec del frontend.
 * El renderer (parseChartSpec en VeraView.js) requiere `type` y suele usar `data`.
 * Aceptamos variantes comunes (`kind`, `chartType`) y las normalizamos.
 *
 * Retorna { isChart, normalized } — normalized tiene `type` siempre presente.
 */
function _detectChartShape(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { isChart: false };

  const CHART_TYPES = ["bar", "line", "area", "pie", "donut", "pyramid", "scatter", "radar", "column", "horizontalbar", "stacked", "stacked_bar"];

  // Normalizamos: type | kind | chartType, en cualquier capitalización
  const rawType = String(o.type ?? o.kind ?? o.chartType ?? o.chart_type ?? "").trim().toLowerCase();
  const hasChartType = CHART_TYPES.includes(rawType);

  // Algunos LLMs envuelven el chart como { chart: { type, data } }
  if (!hasChartType && o.chart && typeof o.chart === "object") {
    const inner = _detectChartShape(o.chart);
    if (inner.isChart) return inner;
  }

  // Heurística positiva: tiene `type` chart-like + algún campo de datos
  const hasData = Array.isArray(o.data) || Array.isArray(o.values) || Array.isArray(o.series) || Array.isArray(o.points);
  if (hasChartType && hasData) {
    const normalized = { ...o, type: rawType };
    // Normalizar `values` → `data` si hace falta
    if (!normalized.data && Array.isArray(o.values)) normalized.data = o.values;
    if (!normalized.data && Array.isArray(o.series)) normalized.data = o.series;
    return { isChart: true, normalized };
  }

  return { isChart: false };
}

/**
 * Detecta forma de quick-reply buttons.
 * El renderer acepta { buttons: [...] } o array directo de botones.
 */
function _detectButtonsShape(o) {
  if (!o || typeof o !== "object") return { isButtons: false };

  // Variantes que pueden venir: buttons, actions, quick_replies, quickReplies, options
  const candidates = [o.buttons, o.actions, o.quick_replies, o.quickReplies, o.options];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const looksLikeButtons = c.every(
        (b) => b && typeof b === "object" && (b.label || b.text || b.title)
      );
      if (looksLikeButtons) {
        return {
          isButtons: true,
          normalized: { title: o.title, buttons: c.map((b) => ({
            label: b.label ?? b.text ?? b.title,
            text:  b.text  ?? b.value ?? b.label ?? b.title,
            variant: b.variant ?? b.style ?? "secondary",
          })) },
        };
      }
    }
  }
  return { isButtons: false };
}

/**
 * Detecta forma de diagrama mermaid (texto con sintaxis flowchart/graph/sequenceDiagram/etc).
 */
function _detectMermaidShape(o) {
  if (!o || typeof o !== "object") return { isMermaid: false };
  const candidates = [o.mermaid, o.diagram, o.flowchart];
  for (const c of candidates) {
    if (typeof c === "string" && /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|mindmap|journey|erDiagram)\b/m.test(c)) {
      return { isMermaid: true, source: c.trim() };
    }
  }
  // O directamente { type: "mermaid", code: "..." }
  if ((o.type === "mermaid" || o.kind === "mermaid") && typeof o.code === "string") {
    return { isMermaid: true, source: o.code.trim() };
  }
  return { isMermaid: false };
}

/**
 * Convierte un objeto JSON desconocido en el bloque markdown adecuado para
 * que el frontend lo RENDERICE en vez de mostrar JSON crudo (mala UX).
 *
 * Orden de detección: chart → buttons → mermaid → fallback JSON block.
 * El usuario nunca debería ver ```json``` salvo casos muy raros.
 */
function _wrapJsonAsRenderableBlock(o) {
  const chart = _detectChartShape(o);
  if (chart.isChart) {
    return "```chart\n" + JSON.stringify(chart.normalized, null, 2) + "\n```";
  }
  const buttons = _detectButtonsShape(o);
  if (buttons.isButtons) {
    return "```buttons\n" + JSON.stringify(buttons.normalized, null, 2) + "\n```";
  }
  const mermaid = _detectMermaidShape(o);
  if (mermaid.isMermaid) {
    return "```mermaid\n" + mermaid.source + "\n```";
  }
  // Último recurso — JSON desconocido. Mejor que perderlo, pero idealmente
  // este branch no se toca: si pasa seguido, sumar el shape a las heurísticas.
  return "```json\n" + JSON.stringify(o, null, 2) + "\n```";
}

/**
 * Extrae el texto utilizable de un objeto JSON emitido por OpenClaw.
 * Para objetos conocidos (payloads/text/message) devuelve el texto;
 * para objetos con shape de chart/buttons/mermaid los envuelve en el bloque
 * markdown correspondiente para que el frontend los renderice nativamente.
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
      else if (p && typeof p === "object") parts.push(_wrapJsonAsRenderableBlock(p));
    }
    if (parts.length) return parts.join("\n\n");
  }

  // Formas alternas con texto plano
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.markdown === "string") return obj.markdown;

  // Objetos meta-only (solo sessionId, audit, etc.) → no aportan texto
  const onlyMeta = Object.keys(obj).every((k) => ["meta", "sessionId", "ok", "status", "event", "at"].includes(k));
  if (onlyMeta) return null;

  // Forma desconocida → intentar renderizar como chart/buttons/mermaid
  return _wrapJsonAsRenderableBlock(obj);
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

/**
 * Filtra noise de telemetría que OpenClaw emite junto con la respuesta real
 * y que NO debería verse en el chat del usuario:
 *   - [agent/embedded] [trace:...]
 *   - [TRACE], [DEBUG], [AUDIT] al inicio de línea
 *   - Líneas standalone con runId=oc_..., sessionId=oc_..., phase=..., totalMs=...
 *   - Líneas que son SOLO stages=workspace:Xms@Yms,...
 *
 * Solo borra LÍNEAS COMPLETAS que matchean; nunca toca prosa con el patrón
 * embebido (ej: si Vera literalmente escribe "el runId fue X", se preserva).
 */
function _stripTracingNoise(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((rawLine) => {
    const line = rawLine.trim();
    if (!line) return true; // preserve blank lines (paragraph spacing)

    // Brackets de telemetría conocidos al inicio
    if (/^\[(agent\/|trace:|TRACE\]|DEBUG\]|AUDIT\]|telemetry\]|openclaw\.)/i.test(line)) return false;

    // Líneas que son puramente key=value de trace (varios pares separados por espacio)
    // Ej: "runId=oc_X sessionId=oc_Y phase=attempt-dispatch totalMs=5612"
    if (/^(runId|sessionId|trace_id|phase|totalMs|stages)=\S+/i.test(line)) {
      // Confirmar que la línea es mayormente kv pairs (no prosa)
      const kvCount = (line.match(/\b\w+=\S+/g) || []).length;
      const words = line.split(/\s+/).length;
      if (kvCount >= 2 && kvCount / words > 0.5) return false;
    }

    // Línea standalone de stages timing: "stages=workspace:1ms@1ms,runtime-plugins:..."
    if (/^stages=\w+:\d+ms@\d+ms/i.test(line)) return false;

    return true;
  });
  // Colapsar más de 2 newlines consecutivos (queda limpio tras filtrar)
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

    // Filtrar líneas de telemetría/trace de OpenClaw que NO deberían
    // mostrarse al usuario (ej: "[agent/embedded] [trace:...]" o "runId=oc_X ...")
    const cleanedParts = textParts.map((t) => _stripTracingNoise(t)).filter(Boolean);
    let combinedText = cleanedParts.join("\n\n") || "Sin respuesta.";

    // Red de seguridad: si Vera filtró el conversation_id pese al prompt,
    // borramos esa línea/bullet/inline mention antes de mostrarlo al usuario.
    if (meta?.conv) {
      const convId = String(meta.conv);
      const convEsc = convId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Borra líneas completas tipo "Conversation ID: <uuid>" o "ID: <uuid>"
      combinedText = combinedText.replace(
        new RegExp(`^[\\s\\-•*]*(?:Conversation\\s*ID|conversation_id|conv_id|ID)\\s*[:=]\\s*\`?${convEsc}\`?\\s*$`, "gmi"),
        ""
      );
      // Y borra el UUID inline en cualquier contexto restante (defensa total)
      combinedText = combinedText.replace(new RegExp(`\`?${convEsc}\`?`, "g"), "");
      // Limpiar líneas que quedaron con basura sintáctica residual ("- ", "ID:")
      combinedText = combinedText.replace(/^[\s\-•*]*(?:Conversation\s*ID|conversation_id|conv_id)\s*[:=]?\s*$/gmi, "");
      combinedText = combinedText.replace(/\n{3,}/g, "\n\n").trim();
    }

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

    // enriched_input_length: largo en caracteres del envelope completo que se
    // mando al modelo (system+context+history+message). ai.service.js lo usa
    // para estimar input_tokens (chars/4) y cobrar dinamicamente via
    // use_credits_numeric. El modelo y conteo real de tokens vive aguas abajo
    // en el anthropic-proxy del org-server; aca solo aproximamos.
    return { ...normalized, enriched_input_length: enrichedMessage.length };
  } catch (e) {
    console.error(
      `openclaw.adapter: agente "${agentId}" (org "${organizationId}" [${orgEntry.type}]) falló:`,
      e.message
    );
    return {
      text:             "El agente no pudo procesar la solicitud en este momento. Por favor intenta nuevamente.",
      tool_calls:       [],
      requires_consent: false,
      enriched_input_length: enrichedMessage.length,
    };
  }
}
