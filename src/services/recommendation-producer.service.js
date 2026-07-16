/**
 * Recommendation Producer — el puente "aprobar → producir" del Loop V1.
 *
 * Problema que resuelve: aprobar una strategic_recommendation en la cata (tab
 * Estrategia) era un callejón sin salida — la RPC solo marcaba status='approved'
 * y nada producía el contenido. Este servicio cierra ese eslabón: detecta
 * recomendaciones aprobadas y dispara la MISMA cadena de producción que usa el
 * Studio (deduct_credits_and_create_run → runs_inputs → webhook n8n), dejando el
 * output en runs_outputs SIN published_at para preservar el gate humano de
 * publicación (autonomía parcial: humano aprueba la jugada y la publicación;
 * la plataforma produce en el medio).
 *
 * Decisiones V1 (aprobadas por la fundadora 2026-07-02):
 *   - Cobrar créditos automáticamente al aprobar (aprobar ES la decisión de gasto).
 *   - single_image | carrusel_imgs → flujo de imágenes automático.
 *   - reel_meme | long_video → org_notification "producir en Studio" (el flujo
 *     UGC Secuencial tiene gates humanos por etapa; no se automatiza en V1).
 *   - El copy_seed NO entra a la generación: viaja en metadata y se convierte en
 *     el caption al publicar.
 *
 * Blueprint completo: repo AISC docs/LOOP-V1-PUENTE-PRODUCCION.md
 */
import { supabase } from "../lib/supabase.js";

const POLL_MS = parseInt(process.env.RECOMMENDATION_PRODUCER_INTERVAL_MS || "600000", 10); // 10 min
const WINDOW_DAYS = 30;
// Flujo de imágenes V1: "Minimalismo 3D / Product Render Futurista"
// (único required = image_selector; sin gate humano; webhook sano — verificado 2026-07-02)
const IMAGE_FLOW_ID = process.env.STRATEGY_BRIDGE_IMAGE_FLOW_ID || "24c1c871-09d4-44ec-9b72-7485233259f8";
const IMAGE_FORMATS = new Set(["single_image", "carrusel_imgs"]);
const VIDEO_FORMATS = new Set(["reel_meme", "long_video"]);

function _stripDiacritics(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Resuelve el producto ancla de una recomendación contra el catálogo de la marca.
 * Estrategia: (1) metadata.product_id si el generador lo dejó; (2) nombre de
 * producto que APAREZCA en el texto de la rec (match más largo gana — evita que
 * "ONE PACK" le gane a "CAJA CHOCO ONE PACK 72G X 12" cuando el texto dice el
 * nombre completo). Fail-open: si nada matchea, retorna null y el caller notifica.
 */
export async function resolveAnchorProduct(rec, brandContainerId) {
  if (rec.metadata?.product_id) {
    const { data: p } = await supabase
      .from("products")
      .select("id, nombre_producto")
      .eq("id", rec.metadata.product_id)
      .maybeSingle();
    if (p) return p;
  }

  const { data: products } = await supabase
    .from("products")
    .select("id, nombre_producto")
    .eq("brand_container_id", brandContainerId)
    .limit(200);
  if (!products?.length) return null;

  const recText = _stripDiacritics(
    [rec.anchor_product_name, rec.title, rec.description, rec.copy_seed, rec.rationale_commercial].join(" \n ")
  );

  let best = null;
  for (const p of products) {
    const name = _stripDiacritics(p.nombre_producto);
    if (name.length >= 6 && recText.includes(name)) {
      if (!best || name.length > _stripDiacritics(best.nombre_producto).length) best = p;
    }
  }
  if (best) return best;

  // Segundo intento: tokens significativos del nombre (≥2 tokens presentes)
  for (const p of products) {
    const tokens = _stripDiacritics(p.nombre_producto).split(/\s+/).filter((t) => t.length >= 4);
    if (tokens.length >= 2) {
      const hits = tokens.filter((t) => recText.includes(t)).length;
      if (hits >= Math.min(2, tokens.length)) {
        if (!best) best = p;
      }
    }
  }
  return best;
}

async function _productImages(productId) {
  const { data } = await supabase
    .from("product_images")
    .select("image_url")
    .eq("product_id", productId)
    .order("image_order", { ascending: true })
    .limit(6);
  return (data || []).map((r) => ({ image_url: r.image_url })).filter((r) => r.image_url);
}

async function _orgOwner(organizationId) {
  const { data } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  return data?.user_id || null;
}

async function _notify(rec, title, body) {
  try {
    await supabase.from("org_notifications").insert({
      organization_id: rec.organization_id,
      brand_container_id: rec.brand_container_id,
      severity: "warning",
      type: "strategy_bridge",
      title,
      body,
      metadata: { recommendation_id: rec.id, source: "recommendation_producer" },
    });
  } catch (e) {
    console.warn(`[rec-producer] notify falló: ${e.message}`);
  }
}

async function _patchRecMetadata(recId, currentMetadata, patch, extraCols = {}) {
  await supabase
    .from("strategic_recommendations")
    .update({ metadata: { ...(currentMetadata || {}), ...patch }, ...extraCols })
    .eq("id", recId);
}

/** Produce una recomendación de imagen vía el camino n8n del Studio. */
async function _produceImageRec(rec) {
  const product = await resolveAnchorProduct(rec, rec.brand_container_id);
  if (!product) {
    await _notify(rec, "No pude resolver el producto de una jugada aprobada",
      `La recomendación "${rec.title}" fue aprobada pero no identifiqué a qué producto del catálogo se refiere. Prodúcela manualmente desde Studio.`);
    await _patchRecMetadata(rec.id, rec.metadata, { production_error: "product_unresolved" });
    return { status: "product_unresolved" };
  }

  const images = await _productImages(product.id);
  if (!images.length) {
    await _notify(rec, "El producto de una jugada aprobada no tiene imágenes",
      `"${rec.title}" apunta a ${product.nombre_producto}, pero ese producto no tiene imágenes cargadas. Sube imágenes o prodúcela desde Studio.`);
    await _patchRecMetadata(rec.id, rec.metadata, { production_error: "product_no_images" });
    return { status: "product_no_images" };
  }

  // Flujo + webhook + costo
  const { data: flow } = await supabase
    .from("content_flows")
    .select("id, name, token_cost")
    .eq("id", IMAGE_FLOW_ID)
    .maybeSingle();
  const { data: module1 } = await supabase
    .from("flow_modules")
    .select("id, webhook_url_prod")
    .eq("content_flow_id", IMAGE_FLOW_ID)
    .eq("step_order", 1)
    .maybeSingle();
  if (!flow || !module1?.webhook_url_prod) {
    console.warn(`[rec-producer] flujo de imágenes ${IMAGE_FLOW_ID} sin webhook — skip`);
    return { status: "flow_unavailable" };
  }

  const ownerId = await _orgOwner(rec.organization_id);
  if (!ownerId) return { status: "no_owner" };

  // 1) Cobrar + crear run (misma RPC que el Studio)
  const { data: runRes, error: runErr } = await supabase.rpc("deduct_credits_and_create_run", {
    p_organization_id: rec.organization_id,
    p_user_id: ownerId,
    p_flow_id: flow.id,
    p_amount: flow.token_cost || 50,
  });
  if (runErr || !runRes?.success) {
    const reason = runErr?.message || runRes?.error_message || "unknown";
    if (String(reason).includes("insufficient")) {
      // Notificar una sola vez por rec (idempotencia vía metadata)
      if (!rec.metadata?.notified_no_credits) {
        await _notify(rec, "Sin créditos para producir una jugada aprobada",
          `"${rec.title}" está aprobada pero no hay créditos suficientes (costo ${flow.token_cost}). Recarga créditos y se producirá en el próximo ciclo.`);
        await _patchRecMetadata(rec.id, rec.metadata, { notified_no_credits: true });
      }
      return { status: "insufficient_credits" };
    }
    console.warn(`[rec-producer] deduct_credits_and_create_run falló rec=${rec.id}: ${reason}`);
    return { status: "run_creation_failed", error: reason };
  }
  const runId = runRes.run_id;

  // 2) Input de producción (mismo shape que el Studio: image_selector.id = products.id)
  const inputData = {
    image_selector: { id: product.id, images },
    aspect_ratio: "1:1",
  };
  await supabase.from("runs_inputs").insert({
    run_id: runId,
    input_data: inputData,
    flow_module_id: module1.id,
    organization_id: rec.organization_id,
    metadata: {
      captured_from: "strategy_bridge",
      flow_id: flow.id,
      recommendation_id: rec.id,
      copy_seed: rec.copy_seed || null,
    },
  });

  // 3) Contexto enriquecido (mismo RPC que el Studio). Fail-open: si falla,
  //    seguimos con el input base — el flujo n8n resuelve con lo esencial.
  let webhookBody = { ...inputData, run_id: runId, organization_id: rec.organization_id };
  try {
    const { data: ctx } = await supabase.rpc("rpc_build_manual_context", {
      p_run_id: runId,
      p_org_id: rec.organization_id,
      p_user_id: ownerId,
      p_flow_id: flow.id,
      p_entity_ids: [product.id],
      p_colores: null,
      p_aspect_ratio: "1:1",
      p_specs: rec.copy_seed ? `Enfoque estratégico: ${rec.title}. ${rec.description || ""}` : null,
    });
    if (ctx && typeof ctx === "object") webhookBody = { ...webhookBody, ...ctx };
  } catch (e) {
    console.warn(`[rec-producer] rpc_build_manual_context falló (continuo con base): ${e.message}`);
  }

  // 4) Disparo del webhook n8n (el mismo POST que hace el Studio)
  let responseCode = null;
  try {
    const res = await fetch(module1.webhook_url_prod, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
      signal: AbortSignal.timeout(60_000),
    });
    responseCode = res.status;
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  } catch (e) {
    console.warn(`[rec-producer] webhook falló rec=${rec.id} run=${runId}: ${e.message}`);
    // Refund (mismo RPC que usa el Studio al fallar)
    try { await supabase.rpc("refund_credits_for_run", { p_run_id: runId }); } catch (_) {}
    await _patchRecMetadata(rec.id, rec.metadata, { production_error: `webhook_failed_${responseCode || "timeout"}` });
    return { status: "webhook_failed" };
  }

  // 5) Marcar el run como el Studio (outputs llegan async vía rpc_ingest_flow_output)
  await supabase.from("flow_runs").update({ status: "completed", webhook_response_code: responseCode }).eq("id", runId);

  // 6) La recomendación entra oficialmente a producción
  await _patchRecMetadata(rec.id, rec.metadata,
    { run_id: runId, production: "auto_bridge", product_id: product.id, production_error: null },
    { in_production_at: new Date().toISOString() });

  console.log(`[rec-producer] rec="${rec.title.slice(0, 50)}" → run=${runId} (producto: ${product.nombre_producto}, flujo: ${flow.name})`);
  return { status: "produced", run_id: runId };
}

/** Ciclo 1: recomendaciones aprobadas → producción. */
async function runProduceCycle() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data: recs, error } = await supabase
    .from("strategic_recommendations")
    .select("id, organization_id, brand_container_id, title, description, copy_seed, rationale_commercial, anchor_product_name, format, metadata, reviewed_at")
    .in("status", ["approved", "iterated"])
    .is("in_production_at", null)
    .gte("reviewed_at", since)
    .limit(10);
  if (error) { console.warn(`[rec-producer] read falló: ${error.message}`); return { produced: 0 }; }
  if (!recs?.length) return { produced: 0 };

  let produced = 0;
  for (const rec of recs) {
    // Errores previos que requieren intervención humana: no reintentar en caliente
    if (rec.metadata?.production_error && rec.metadata.production_error !== null) continue;
    if (rec.metadata?.requires_studio) continue;

    if (VIDEO_FORMATS.has(rec.format)) {
      if (!rec.metadata?.requires_studio) {
        await _notify(rec, "Jugada aprobada lista para producir en Studio (video)",
          `"${rec.title}" es formato video (${rec.format}). Prodúcela en Studio — el flujo UGC te guía por etapas con tu aprobación en cada una.`);
        await _patchRecMetadata(rec.id, rec.metadata, { requires_studio: true });
      }
      continue;
    }

    // V1: todo lo no-video va por el flujo de imágenes (incl. format null)
    const r = await _produceImageRec(rec);
    if (r.status === "produced") produced++;
  }
  return { produced };
}

/** Ciclo 2: producciones publicadas → cerrar el link receta↔publicación (determinista). */
async function runPublishLinkCycle() {
  const { data: recs } = await supabase
    .from("strategic_recommendations")
    .select("id, metadata, status, published_at")
    .in("status", ["approved", "iterated"])
    .not("in_production_at", "is", null)
    .is("published_at", null)
    .limit(20);
  if (!recs?.length) return { linked: 0 };

  let linked = 0;
  for (const rec of recs) {
    const runId = rec.metadata?.run_id;
    if (!runId) continue;
    const { data: pub } = await supabase
      .from("social_publications")
      .select("id, remote_post_id, platform, created_at, output_id, runs_outputs!inner(run_id)")
      .eq("runs_outputs.run_id", runId)
      .eq("status", "published")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!pub) continue;

    await supabase
      .from("strategic_recommendations")
      .update({
        status: "published",
        published_at: pub.created_at,
        metadata: { ...(rec.metadata || {}), remote_post_id: pub.remote_post_id, published_platform: pub.platform },
      })
      .eq("id", rec.id);
    linked++;
    console.log(`[rec-producer] rec=${rec.id} publicada → remote_post_id=${pub.remote_post_id} (el auto-link cierra contra brand_posts cuando el scraper la ingiera)`);
  }
  return { linked };
}

let _timer = null;

export function startRecommendationProducer(intervalMs = POLL_MS) {
  if (_timer) return;
  console.log(`recommendation-producer: puente aprobar→producir iniciado (cada ${intervalMs / 60000} min, primera corrida en 90s)`);
  setTimeout(async () => {
    const p = await runProduceCycle();
    const l = await runPublishLinkCycle();
    if (p.produced || l.linked) console.log(`rec-producer: ciclo inicial — produced=${p.produced}, linked=${l.linked}`);
  }, 90_000);
  _timer = setInterval(async () => {
    try {
      const p = await runProduceCycle();
      const l = await runPublishLinkCycle();
      if (p.produced || l.linked) console.log(`rec-producer: produced=${p.produced}, linked=${l.linked}`);
    } catch (e) {
      console.warn(`rec-producer: ciclo falló — ${e.message}`);
    }
  }, intervalMs);
}

export function stopRecommendationProducer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export { runProduceCycle, runPublishLinkCycle };
