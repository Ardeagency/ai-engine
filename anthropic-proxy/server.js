/**
 * Anthropic Proxy — control plane local entre OpenClaw y api.anthropic.com.
 *
 * Por qué existe:
 *   OpenClaw es third-party y autónomo. Sin medición intermedia, no sabemos
 *   cuántos tokens consume cada org y no podemos parar a un agente que se
 *   quedó pensando en círculos.
 *
 * Qué hace:
 *   1. Forward 1:1 de /v1/messages a api.anthropic.com.
 *   2. Pre-flight: chequea cap diario/mensual via RPC `claude_cap_check`.
 *      Si excede → 429 con error en formato Anthropic (OpenClaw lo respeta).
 *   3. Post-response: parsea `usage` (JSON o SSE), calcula USD según pricing
 *      del modelo, INSERT en `credit_usage` con kind='claude_tokens'.
 *
 * Identidad:
 *   El proxy corre en la VM dedicada de una org. ORGANIZATION_ID viene del
 *   .env (lo escribe hetzner.provisioner cuando crea la VM). Una sola org
 *   por proceso → no hay confusión entre clientes.
 *
 * Falla-abierta:
 *   Si el proxy no puede llegar a Supabase (cap check o log), DEJA pasar la
 *   request y solo registra warning. La prioridad es no romper Vera.
 */
import http from "node:http";
import https from "node:https";
import { createClient } from "@supabase/supabase-js";

const PORT          = Number(process.env.ANTHROPIC_PROXY_PORT) || 8788;
const ORG_ID        = process.env.ORGANIZATION_ID;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const UPSTREAM_HOST = process.env.ANTHROPIC_UPSTREAM_HOST || "api.anthropic.com";

if (!ORG_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[anthropic-proxy] FATAL: faltan ORGANIZATION_ID / SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Pricing (USD por millón de tokens). Mayo 2026.
//    Match parcial — buscamos por substring del modelo en orden de especificidad.
const PRICING = [
  ["claude-opus-4",      { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }],
  ["claude-sonnet-4",    { input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 }],
  ["claude-haiku-4",     { input:  1.00, output:  5.00, cacheRead: 0.10, cacheWrite:  1.25 }],
  ["claude-3-5-sonnet",  { input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 }],
  ["claude-3-5-haiku",   { input:  0.80, output:  4.00, cacheRead: 0.08, cacheWrite:  1.00 }],
  ["claude-3-opus",      { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }],
];
const FALLBACK_PRICE = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };

function priceFor(model) {
  const m = String(model || "").toLowerCase();
  for (const [k, p] of PRICING) if (m.includes(k)) return p;
  return FALLBACK_PRICE;
}

function computeUsd(model, usage) {
  const p = priceFor(model);
  const inT  = (usage.input_tokens || 0)              / 1e6;
  const outT = (usage.output_tokens || 0)             / 1e6;
  const crT  = (usage.cache_read_input_tokens || 0)   / 1e6;
  const cwT  = (usage.cache_creation_input_tokens||0) / 1e6;
  return inT * p.input + outT * p.output + crT * p.cacheRead + cwT * p.cacheWrite;
}

// ── Cap check via RPC (una sola query a Supabase).
async function capCheck() {
  try {
    const { data, error } = await sb.rpc("claude_cap_check", { p_org_id: ORG_ID });
    if (error) {
      console.warn("[anthropic-proxy] cap check error (fail-open):", error.message);
      return { blocked: false };
    }
    return data || { blocked: false };
  } catch (e) {
    console.warn("[anthropic-proxy] cap check exception (fail-open):", e.message);
    return { blocked: false };
  }
}

// ── Log usage (fire-and-forget; no rompe la respuesta al cliente).
async function logUsage({ model, usage, usd, conversationHint, statusCode }) {
  const { error } = await sb.from("credit_usage").insert({
    organization_id: ORG_ID,
    kind:            "vera_chat",
    credits_delta:   usd,
    usd_cost:        usd,
    source_table:    "anthropic_proxy",
    source_id:       model,
    metadata: {
      model,
      input_tokens:                usage.input_tokens || 0,
      output_tokens:               usage.output_tokens || 0,
      cache_read_input_tokens:     usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      conversation_hint:           conversationHint || null,
      upstream_status:             statusCode,
      proxy_at:                    new Date().toISOString(),
    },
  });
  if (error) console.error("[anthropic-proxy] log usage error:", error.message);
}

// ── Parse usage de respuesta JSON (non-streaming).
function parseUsageFromJson(body) {
  try {
    const j = JSON.parse(body);
    if (j.usage && j.model) return { usage: j.usage, model: j.model };
  } catch (_) {}
  return null;
}

// ── Parse usage de respuesta SSE (streaming).
//    Anthropic emite: message_start { usage: {input_tokens, cache_read, cache_creation} },
//    message_delta { usage: {output_tokens} } al final.
function parseUsageFromSse(body) {
  let model = null;
  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0;
  for (const block of body.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(5).trim());
      if (data.type === "message_start") {
        model = data.message?.model || model;
        const u = data.message?.usage || {};
        inputTokens   = u.input_tokens                ?? inputTokens;
        cacheRead     = u.cache_read_input_tokens     ?? cacheRead;
        cacheCreation = u.cache_creation_input_tokens ?? cacheCreation;
      } else if (data.type === "message_delta" && data.usage) {
        outputTokens = data.usage.output_tokens ?? outputTokens;
      }
    } catch (_) {}
  }
  if (!model) return null;
  return {
    model,
    usage: {
      input_tokens:                inputTokens,
      output_tokens:               outputTokens,
      cache_read_input_tokens:     cacheRead,
      cache_creation_input_tokens: cacheCreation,
    },
  };
}

// ── Server.
const server = http.createServer(async (req, res) => {
  // Health probe (interna).
  if (req.url === "/__proxy_health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, org: ORG_ID, port: PORT, upstream: UPSTREAM_HOST }));
    return;
  }

  const isMessages = req.url.startsWith("/v1/messages") && req.method === "POST";

  // Cap check solo en /v1/messages (es donde se cobra). Otros endpoints pasan limpio.
  let capStatus = null;
  if (isMessages) {
    capStatus = await capCheck();
    if (capStatus.blocked) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type:  "error",
        error: {
          type:    "rate_limit_error",
          message: `Cap de Claude alcanzado para esta organización ` +
                   `(hoy $${Number(capStatus.usd_today).toFixed(2)} de $${capStatus.daily_cap}, ` +
                   `mes $${Number(capStatus.usd_month).toFixed(2)} de $${capStatus.monthly_cap}). ` +
                   `Contacta a tu admin si necesitas aumentar el límite.`,
        },
      }));
      return;
    }
  }

  // Capturar body de la request (si hay).
  const reqChunks = [];
  for await (const chunk of req) reqChunks.push(chunk);
  const reqBody = Buffer.concat(reqChunks);

  // Conversation hint (si OpenClaw nos envía metadata.conversation_id).
  let conversationHint = null;
  if (isMessages && reqBody.length) {
    try {
      const parsed = JSON.parse(reqBody.toString("utf8"));
      conversationHint = parsed?.metadata?.conversation_id || parsed?.metadata?.user_id || null;
    } catch (_) {}
  }

  // Forward al upstream.
  const headers = { ...req.headers };
  delete headers["host"];
  delete headers["content-length"];
  headers["host"] = UPSTREAM_HOST;
  if (reqBody.length) headers["content-length"] = String(reqBody.length);

  const upstream = https.request({
    hostname: UPSTREAM_HOST,
    port:     443,
    path:     req.url,
    method:   req.method,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);

    // Si no es /v1/messages POST 200, pipe directo sin metering.
    if (!isMessages || upRes.statusCode !== 200) {
      upRes.pipe(res);
      return;
    }

    // Capturamos chunks para parsear usage al final, mientras pipeamos al cliente.
    const chunks = [];
    upRes.on("data", (c) => { chunks.push(c); res.write(c); });
    upRes.on("end", async () => {
      res.end();

      try {
        const body  = Buffer.concat(chunks).toString("utf8");
        const ctype = String(upRes.headers["content-type"] || "");
        const parsed = ctype.includes("event-stream")
          ? parseUsageFromSse(body)
          : parseUsageFromJson(body);

        if (parsed) {
          const usd = computeUsd(parsed.model, parsed.usage);
          await logUsage({
            model:            parsed.model,
            usage:            parsed.usage,
            usd,
            conversationHint,
            statusCode:       upRes.statusCode,
          });
        }
      } catch (e) {
        console.warn("[anthropic-proxy] post-response metering error:", e.message);
      }
    });
  });

  upstream.on("error", (e) => {
    console.error("[anthropic-proxy] upstream error:", e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type:  "error",
        error: { type: "api_error", message: `Proxy upstream error: ${e.message}` },
      }));
    } else {
      res.end();
    }
  });

  if (reqBody.length) upstream.write(reqBody);
  upstream.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[anthropic-proxy] org=${ORG_ID} listening on 127.0.0.1:${PORT} → https://${UPSTREAM_HOST}`);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
