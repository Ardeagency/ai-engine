// ─────────────────────────────────────────────────────────────────────────────
// grounded-llm.js — clientes LLM en modo GROUNDED (con busqueda web en vivo).
//
// Por que existe: preguntarle a la API "pelada" de un LLM devuelve su memoria de
// entrenamiento, NO lo que ve un usuario real. Para medir visibilidad en IA
// (Radiografia de Visibilidad) hay que correr cada motor CON busqueda web y capturar
// las CITAS. Este modulo normaliza los 3 motores a una sola forma:
//   { engine, text, citations: [{ url, domain, title }], usage: {input,output}, costUsd }
//
// Motores fase 1: openai (Responses API + web_search), gemini (google_search grounding),
// claude (web_search tool). Perplexity entra tras api-onboarding (fase 1.1).
//
// Ref: docs/radiografia-visibilidad.md seccion 3 (regla grounded, cero dato falso).
// ─────────────────────────────────────────────────────────────────────────────

// Pricing aproximado USD por 1M tokens (solo para accounting en credit_usage, no billing
// critico). Se puede afinar; lo importante es no reportar costo 0 (cero dato falso).
const PRICING = {
  openai:     { in: 2.5,  out: 10.0, searchFlat: 0.010 }, // gpt-4o + web_search call
  gemini:     { in: 0.30, out: 2.50, searchFlat: 0.000 }, // gemini-2.5-flash + grounding
  claude:     { in: 3.0,  out: 15.0, searchFlat: 0.010 }, // sonnet + web_search
  perplexity: { in: 1.0,  out: 1.0,  searchFlat: 0.005 },
};

function _domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function _cost(engine, inTok, outTok, searches = 1) {
  const p = PRICING[engine] || { in: 1, out: 1, searchFlat: 0 };
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out + (searches ? p.searchFlat : 0);
}

function _normCitations(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const url = c?.url || c?.uri;
    if (!url) continue;
    const domain = _domainOf(url);
    const key = domain || url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, domain, title: c?.title || null });
  }
  return out;
}

// ── OpenAI: Responses API con herramienta web_search ────────────────────────────
async function askOpenAI(prompt, { model = process.env.VISIBILITY_OPENAI_MODEL || "gpt-4o", timeoutMs = 60_000 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY ausente");
  const ctrl = AbortController ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, tools: [{ type: "web_search" }], input: prompt }),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    let text = "";
    const citations = [];
    for (const item of j.output || []) {
      if (item.type !== "message") continue;
      for (const block of item.content || []) {
        if (block.type === "output_text") {
          text += block.text || "";
          for (const a of block.annotations || []) {
            if (a.type === "url_citation") citations.push({ url: a.url, title: a.title });
          }
        }
      }
    }
    const inTok = j.usage?.input_tokens || 0;
    const outTok = j.usage?.output_tokens || 0;
    return { engine: "openai", text, citations: _normCitations(citations), usage: { input: inTok, output: outTok }, costUsd: _cost("openai", inTok, outTok) };
  } finally { if (timer) clearTimeout(timer); }
}

// ── Gemini: generateContent con google_search (grounding) ────────────────────────
async function askGemini(prompt, { model = process.env.VISIBILITY_GEMINI_MODEL || "gemini-2.5-flash", timeoutMs = 60_000 } = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY ausente");
  const ctrl = AbortController ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const cand = j.candidates?.[0];
    let text = "";
    for (const part of cand?.content?.parts || []) text += part.text || "";
    const chunks = cand?.groundingMetadata?.groundingChunks || [];
    const citations = chunks.map((c) => ({ url: c.web?.uri, title: c.web?.title })).filter((c) => c.url);
    const inTok = j.usageMetadata?.promptTokenCount || 0;
    const outTok = j.usageMetadata?.candidatesTokenCount || 0;
    return { engine: "gemini", text, citations: _normCitations(citations), usage: { input: inTok, output: outTok }, costUsd: _cost("gemini", inTok, outTok) };
  } finally { if (timer) clearTimeout(timer); }
}

// ── Claude: Messages API con herramienta web_search ─────────────────────────────
async function askClaude(prompt, { model = process.env.VISIBILITY_ANTHROPIC_MODEL || "claude-sonnet-4-5", timeoutMs = 60_000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY ausente");
  const ctrl = AbortController ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    let text = "";
    const citations = [];
    for (const block of j.content || []) {
      if (block.type === "text") {
        text += block.text || "";
        for (const cit of block.citations || []) {
          if (cit.url) citations.push({ url: cit.url, title: cit.title });
        }
      }
    }
    const inTok = j.usage?.input_tokens || 0;
    const outTok = j.usage?.output_tokens || 0;
    return { engine: "claude", text, citations: _normCitations(citations), usage: { input: inTok, output: outTok }, costUsd: _cost("claude", inTok, outTok) };
  } finally { if (timer) clearTimeout(timer); }
}

// ── Perplexity: chat/completions (OpenAI-compatible, grounded por diseño) ────────
// Doc: ~/.claude/arde-tools/perplexity/RESEARCH.md. Devuelve search_results (fuentes)
// y content directo. Se activa cuando exista PERPLEXITY_API_KEY.
async function askPerplexity(prompt, { model = process.env.VISIBILITY_PERPLEXITY_MODEL || "sonar", timeoutMs = 60_000 } = {}) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY ausente (pendiente de que el usuario la genere)");
  const ctrl = AbortController ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`Perplexity ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content || "";
    // search_results es el campo actual; citations (array de urls) es legacy fallback.
    let citations = (j.search_results || []).map((s) => ({ url: s.url, title: s.title }));
    if (!citations.length && Array.isArray(j.citations)) citations = j.citations.map((u) => ({ url: u, title: null }));
    const inTok = j.usage?.prompt_tokens || 0;
    const outTok = j.usage?.completion_tokens || 0;
    return { engine: "perplexity", text, citations: _normCitations(citations), usage: { input: inTok, output: outTok }, costUsd: _cost("perplexity", inTok, outTok) };
  } finally { if (timer) clearTimeout(timer); }
}

// Dispatcher por nombre de motor.
export const ENGINES = {
  openai: askOpenAI,
  gemini: askGemini,
  claude: askClaude,
  perplexity: askPerplexity,
};

export async function askEngine(engine, prompt, opts) {
  const fn = ENGINES[engine];
  if (!fn) throw new Error(`motor desconocido: ${engine}`);
  return fn(prompt, opts);
}
