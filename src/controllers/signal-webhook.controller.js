/**
 * Signal Webhook Controller — procesa señales de competidores en tiempo real.
 *
 * Integración con el schema real de Supabase:
 *   intelligence_signals → el INSERT dispara este webhook (Database Webhook)
 *   body_missions        → creamos una misión con trigger_signal_id = signal.id
 *   agent_queue_jobs     → encolamos un job de tipo "analysis" con priority
 *   mission_runs         → se crea junto al job para tracking completo
 *   brand_vulnerabilities → si threat_level es HIGH/CRITICAL, se crea aquí
 *
 * Endpoints:
 *   POST /webhooks/signal      → Supabase Database Webhook (INSERT en intelligence_signals)
 *   POST /webhooks/url-trigger → URL manual → análisis inmediato + url_watchers
 *   POST /webhooks/run-scraper → Admin: fuerza ciclo de scraping
 */
import crypto from "crypto";
import { supabase } from "../lib/supabase.js";
import { getOrgByBrandContainer } from "../lib/org-resolver.js";
import { runCompetitorScraper } from "../services/social-scraper.service.js";

// ── HMAC validation (Supabase webhook signature) ─────────────────────────────
// IMPORTANTE: Supabase firma el body raw (bytes), no el JSON re-serializado.
// Por eso este controller DEBE montarse con express.raw() antes que express.json().
// En index.js, la ruta /webhooks/signal usa rawBodyMiddleware (ver abajo).
// Si se usara JSON.stringify(req.body), la firma no coincidiría cuando Supabase
// envía propiedades en un orden diferente o con espacios distintos.

function verifySupabaseSignature(req) {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  // FAIL-CLOSED (2026-07-02): antes `if (!secret) return true` aceptaba TODO webhook
  // si la env var faltaba — un mal deploy convertía /webhooks/signal en un endpoint
  // abierto. Ahora sin secret configurado se RECHAZA. En prod el secret está seteado,
  // así que esto no cambia el comportamiento actual; blinda contra config faltante.
  if (!secret) {
    console.error("signal-webhook: SUPABASE_WEBHOOK_SECRET no configurado → rechazando (fail-closed)");
    return false;
  }

  const signature = req.headers["x-supabase-signature"] || "";
  if (!signature) return false;

  // Modo 1 — Bearer-style: el header trae el secret LITERAL.
  // Es como Supabase Database Webhooks envían headers custom (sin computar HMAC).
  if (signature.length === secret.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(secret))) {
        return true;
      }
    } catch { /* fall through to HMAC mode */ }
  }

  // Modo 2 — HMAC del body. Acepta tanto "<hex>" como "sha256=<hex>".
  const sigHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  // req.rawBody es inyectado por el middleware rawBodyMiddleware de webhooks.routes.js
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.warn("signal-webhook: rawBody no disponible — verifica que la ruta usa rawBodyMiddleware");
    return false;
  }

  let expectedBuf;
  try {
    expectedBuf = Buffer.from(
      crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
      "hex"
    );
  } catch { return false; }

  try {
    const sigBuf = Buffer.from(sigHex, "hex");
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch { return false; }
}

// ── Clasificar nivel de amenaza del signal ───────────────────────────────────
// Heurístico rápido sin LLM — el análisis real lo hace OpenClaw.

function classifyThreatLevel(signal) {
  // content_text es un JSON serializado: {"external_id":"...","content":"...texto real..."}
  // Hay que parsear primero y buscar en los campos de texto, no en la cadena JSON cruda.
  let searchText = "";
  try {
    const parsed = JSON.parse(signal.content_text || "{}");
    // Concatenar todos los campos de texto relevantes del post
    searchText = [
      parsed.caption   || "",
      parsed.content   || "",
      parsed.label     || "",
      parsed.excerpt   || "",
      parsed.url       || "",
    ].join(" ").toLowerCase();
  } catch {
    // Si no es JSON válido, usar el string crudo como fallback
    searchText = (signal.content_text || "").toLowerCase();
  }

  const promoKeywords = [
    "descuento", "oferta", "promo", "sale", "flash sale", "gratis", "free", "%", "black",
    "cyber", "liquidación", "últimas", "última", "agotando", "promoción", "precio especial",
  ];
  const urgencyKeywords = [
    "solo hoy", "24 horas", "últimas horas", "quedan", "cierra", "termina",
    "tiempo limitado", "solo por", "solo este", "ya disponible", "compra ahora",
  ];

  const promoScore   = promoKeywords.filter((k) => searchText.includes(k)).length;
  const urgencyScore = urgencyKeywords.filter((k) => searchText.includes(k)).length;
  const engagement   = signal.content_numeric || 0;

  if (promoScore >= 3 && urgencyScore >= 2) return "critical";
  if (promoScore >= 2 || urgencyScore >= 1)  return "high";
  if (promoScore >= 1 || engagement > 1000)  return "medium";
  return "low";
}

// ── Procesar señal: clasificar threat + crear vulnerability si HIGH/CRITICAL ─
//
// Post-migración Apify (2026-04-28): el scraper enriquece signals vía
// python-analyzer (pysentimiento + KeyBERT) + media_descriptions_cache (Claude).
// El análisis por-señal con Vera/Claude se eliminó del flujo per-post (era
// caro y redundante). Vera ahora opera en BATCH desde Layer 4.
//
// Esta función ya NO crea body_missions tipo `competitor_signal_analysis`
// — el handler fue removido en la migración Apify y las missions se quedaban
// colgadas en `pending` para siempre (BUG-001).

async function enqueueSignalAnalysis(signal, entity, organizationId) {
  const threatLevel = classifyThreatLevel(signal);

  if (threatLevel !== "high" && threatLevel !== "critical") {
    return;
  }

  const contentData = (() => {
    try { return JSON.parse(signal.content_text || "{}"); } catch { return {}; }
  })();

  const { error: vErr } = await supabase.from("brand_vulnerabilities").insert({
    brand_container_id:  entity.brand_container_id,
    entity_id:           entity.id,
    title:               `${entity.name} — ${signal.signal_type === "url_change" ? "Cambio en web" : "Post de alto impacto"} detectado`,
    description:         contentData.content?.slice(0, 500) || "Señal detectada por scraper automático",
    severity:            threatLevel,
    status:              "open",
    detected_signal_id:  signal.id,
    metadata: {
      auto_detected: true,
      network:       contentData.network,
      url:           contentData.url,
    },
  });

  if (vErr) {
    console.warn(`signal-webhook: brand_vulnerability insert error — ${vErr.message}`);
    return;
  }

  console.log(
    `signal-webhook: vulnerabilidad ${threatLevel.toUpperCase()} creada para ${entity.name}`
  );

  return { threat_level: threatLevel };
}

// ── Handler: Supabase Database Webhook ───────────────────────────────────────

export const signalWebhookController = async (req, res) => {
  if (!verifySupabaseSignature(req)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const { type, table, record } = req.body || {};

  if (type !== "INSERT" || table !== "intelligence_signals" || !record?.id) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const signal = record;

  if (!["post", "url_change", "price_change"].includes(signal.signal_type)) {
    return res.status(200).json({ ok: true, skipped: true, reason: "signal_type no procesable" });
  }

  // Resolver entidad y organización
  let entity         = null;
  let organizationId = null;

  try {
    const { data } = await supabase
      .from("intelligence_entities")
      .select("id, name, brand_container_id, domain, target_identifier, metadata")
      .eq("id", signal.entity_id)
      .maybeSingle();

    if (data) {
      entity = data;
      const org = await getOrgByBrandContainer(data.brand_container_id);
      organizationId = org?.id || null;
    }
  } catch (e) {
    console.warn(`signal-webhook: resolución de org falló — ${e.message}`);
  }

  if (!organizationId) {
    return res.status(200).json({
      ok:      true,
      skipped: true,
      reason:  "No se pudo resolver organización",
    });
  }

  // Responder inmediatamente a Supabase (< 500ms requerido)
  res.status(200).json({ ok: true, signal_id: signal.id, processing: true });

  // Encolar análisis de forma async — no bloquea la respuesta HTTP
  setImmediate(async () => {
    try {
      await enqueueSignalAnalysis(signal, entity, organizationId);
    } catch (e) {
      console.error(`signal-webhook: enqueue falló — ${e.message}`);
    }
  });
};

// ── Handler: URL-to-trigger manual ───────────────────────────────────────────
// Auth: Bearer token en Authorization header (el mismo INTERNAL_ADMIN_TOKEN que /run-scraper)
// o bien X-Internal-Token. Sin auth, cualquiera podría encolar análisis arbitrarios
// y consumir créditos de OpenAI.

export const urlTriggerController = async (req, res) => {
  // Validación de auth: Bearer token o X-Internal-Token
  const authHeader = req.headers["authorization"] || "";
  const internalToken = req.headers["x-internal-token"] || "";
  const adminToken    = process.env.INTERNAL_ADMIN_TOKEN;

  // FAIL-CLOSED (2026-07-02): antes toda la auth vivía dentro de `if (adminToken)`,
  // así que si INTERNAL_ADMIN_TOKEN faltaba, CUALQUIERA encolaba análisis (créditos
  // OpenAI) para una org arbitraria. Ahora sin token configurado se rechaza.
  if (!adminToken) {
    return res.status(500).json({ error: "INTERNAL_ADMIN_TOKEN no configurado en el servidor" });
  }
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (bearerToken !== adminToken && internalToken !== adminToken) {
    return res.status(401).json({ error: "Token de autorización requerido" });
  }

  const { url, label, organization_id, entity_id, brand_container_id } = req.body || {};

  if (!url || !organization_id) {
    return res.status(400).json({ error: "url y organization_id son requeridos" });
  }
  try { new URL(url); }
  catch { return res.status(400).json({ error: "URL inválida" }); }

  // Insertar en url_watchers para monitoreo continuo
  // brand_container_id es requerido por RLS — sin él el watcher es invisible al MCP
  if (entity_id && brand_container_id) {
    const { error: watcherErr } = await supabase.from("url_watchers").insert({
      url,
      label:              label || url,
      entity_id,
      brand_container_id,
      is_active:          true,
      last_hash:          "",
      last_checked_at:    new Date().toISOString(),
    });
    if (watcherErr) {
      console.warn(`url-trigger: no se pudo crear watcher — ${watcherErr.message}`);
    }
  } else if (entity_id && !brand_container_id) {
    console.warn("url-trigger: entity_id enviado sin brand_container_id — watcher no creado (RLS lo requiere)");
  }

  // Encolar job de análisis
  const { data: job, error: jobErr } = await supabase
    .from("agent_queue_jobs")
    .insert({
      organization_id,
      job_type:  "analysis",
      priority:  6,
      payload: {
        signal_type: "url_change",
        type:        "url_trigger_manual",
        url,
        label:        label || url,
        entity_id:    entity_id   || null,
        entity_name:  label       || url,
        content_preview: JSON.stringify({ url, label, excerpt: "(análisis manual)" }),
        threat_level: "medium",
      },
      status: "queued",
    })
    .select("id")
    .single();

  if (jobErr) {
    console.error(`url-trigger: no se pudo encolar job — ${jobErr.message}`);
    return res.status(500).json({ error: "No se pudo encolar el análisis" });
  }

  res.status(202).json({
    ok:      true,
    url,
    label,
    job_id:  job?.id,
    status:  "queued",
    message: "URL recibida. Vera analizará y escribirá en memory/.",
  });
};

// ── Handler: run-scraper manual (admin) ──────────────────────────────────────

export const runScraperController = async (req, res) => {
  const token = req.headers["x-internal-token"];
  if (!token || token !== process.env.INTERNAL_ADMIN_TOKEN) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  const { brand_container_id } = req.body || {};

  res.status(202).json({ ok: true, status: "running", message: "Scraper iniciado en background" });

  setImmediate(async () => {
    try {
      const result = await runCompetitorScraper(brand_container_id || null);
      console.log("run-scraper: completado —", result);
    } catch (e) {
      console.error("run-scraper: error —", e.message);
    }
  });
};
