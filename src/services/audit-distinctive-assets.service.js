/**
 * audit-distinctive-assets.service.js — ¿la marca se reconoce en 0,5s? (fila 11).
 *
 * Blink test con VISION: toma una muestra de los outputs generados de la marca y,
 * contra sus activos distintivos definidos (brand_colors / brand_fonts / brand_rules
 * + wordmark), mide con gpt-4o vision:
 *   - applied_count  : en cuantas piezas de la muestra se aplica cada activo
 *   - recognized     : fuerza de reconocimiento del activo (blink test 0..1)
 * y persiste un snapshot en asset_equity (uno por activo). Alimenta
 * track_asset_consistency (serie multi-periodo) y el contention_guard (no refrescar
 * activos que rinden).
 *
 * Cadencia larga / on-demand: cada corrida gasta tokens de vision. Sampleo N (gate
 * AUDIT_ASSETS_MAX_IMAGES, default 6) + detail:"low" para acotar costo.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { analyzeImagesJSON } from "../lib/vision.js";

const MAX_IMAGES = parseInt(process.env.AUDIT_ASSETS_MAX_IMAGES || "6", 10);

function _num01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

/**
 * auditDistinctiveAssets(brandContainerId, organizationId, opts?)
 * @returns {{ brand, images_analyzed, assets:Array, overall_consistency, blink_test, inconsistencies, persisted, skipped? }}
 */
export async function auditDistinctiveAssets(brandContainerId, organizationId, opts = {}) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const maxImages = Math.max(1, Math.min(Number(opts.maxImages) || MAX_IMAGES, 12));

  // 1. Activos distintivos definidos
  const [{ data: colors }, { data: fonts }, { data: rules }] = await Promise.all([
    supabase.from("brand_colors").select("color_role, hex_value").eq("organization_id", organizationId),
    supabase.from("brand_fonts").select("font_family, font_usage").eq("organization_id", organizationId),
    supabase.from("brand_rules").select("rule_type, rule_value").eq("brand_container_id", bc.id),
  ]);
  const colorList = colors || [], fontList = fonts || [], ruleList = rules || [];

  // 2. Muestra de outputs con imagen fetchable (no video)
  const { data: outs, error: outErr } = await supabase
    .from("runs_outputs")
    .select("id, storage_path, reference_image_url, created_at")
    .eq("brand_container_id", bc.id)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (outErr) throw new Error(`auditDistinctiveAssets outputs: ${outErr.message}`);

  const imgs = (outs || [])
    .map((o) => o.storage_path || o.reference_image_url)
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u) && !/\.(mp4|mov|webm)(\?|$)/i.test(u))
    .slice(0, maxImages);

  if (!imgs.length) {
    return { brand: bc.nombre_marca, images_analyzed: 0, assets: [], persisted: 0,
      skipped: "sin imagenes de output analizables (marca sin producciones aun)" };
  }
  if (!colorList.length && !fontList.length && !ruleList.length) {
    return { brand: bc.nombre_marca, images_analyzed: 0, assets: [], persisted: 0,
      skipped: "la marca no tiene activos distintivos definidos (brand_colors/fonts/rules vacios) — definilos primero" };
  }

  // 3. Vision
  const assetSpec = [
    ...colorList.map((c) => `color ${c.color_role || ""} ${c.hex_value}`.trim()),
    ...fontList.map((f) => `tipografia ${f.font_family} (${f.font_usage || "uso"})`),
    ...ruleList.map((r) => `regla ${r.rule_type}: ${r.rule_value}`),
    `wordmark/logo: "${bc.nombre_marca}"`,
  ].join("\n");

  const instruction =
`Eres un director de arte auditando la CONSISTENCIA de los activos distintivos de una marca (blink test: ¿se reconoce la marca en 0,5s sin logo y sin sonido?).

ACTIVOS DISTINTIVOS DEFINIDOS de la marca "${bc.nombre_marca}":
${assetSpec}

Te paso ${imgs.length} imagenes REALES producidas por la marca. Evalua, a traves de todas, cada activo.
Responde SOLO JSON con esta forma exacta:
{
  "assets": [
    {"type":"color|font|logo|rule","ref":"<el activo, ej '#f79e1b primary'>","applied_in":<entero 0..${imgs.length}>,"recognized":<0..1>,"note":"<breve>"}
  ],
  "overall_consistency": <0..1>,
  "blink_test": "<se reconoce la marca en 0,5s? por que>",
  "inconsistencies": ["<derivas o aplicaciones inconsistentes detectadas>"]
}
- applied_in = en cuantas de las ${imgs.length} imagenes se aplica claramente ese activo.
- recognized = que tan fuerte/memorable es ese activo como codigo de marca (0=generico, 1=inconfundible).
- Incluye un item por cada activo listado arriba.`;

  const { data: vis, usage, images_analyzed, model } = await analyzeImagesJSON(imgs, instruction, { maxImages: imgs.length, detail: "low", max_tokens: 1600 });
  if (!vis || vis._parse_error) {
    return { brand: bc.nombre_marca, images_analyzed, assets: [], persisted: 0, skipped: "vision no devolvio JSON valido", raw: vis?.raw };
  }

  // 4. Persistir snapshot en asset_equity (idempotente por dia)
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const rows = (Array.isArray(vis.assets) ? vis.assets : []).map((a) => ({
    organization_id:   organizationId,
    brand_container_id: bc.id,
    asset_type:        String(a.type || "asset").slice(0, 40),
    asset_ref:         String(a.ref || "").slice(0, 200),
    applied_count:     Math.max(0, Math.min(parseInt(a.applied_in, 10) || 0, images_analyzed)),
    total_outputs:     images_analyzed,
    consistency_score: images_analyzed ? _num01((parseInt(a.applied_in, 10) || 0) / images_analyzed) : 0,
    recognized_score:  _num01(a.recognized),
    snapshot_date:     today,
    measured_at:       nowIso,
  }));

  let persisted = 0;
  if (rows.length) {
    await supabase.from("asset_equity").delete().eq("brand_container_id", bc.id).eq("snapshot_date", today);
    const { error: insErr } = await supabase.from("asset_equity").insert(rows);
    if (insErr) console.warn(`[audit-assets] insert asset_equity: ${insErr.message}`);
    else persisted = rows.length;
  }

  return {
    brand: bc.nombre_marca,
    images_analyzed,
    model,
    assets: rows.map((r) => ({ type: r.asset_type, ref: r.asset_ref, consistency: r.consistency_score, recognized: r.recognized_score })),
    overall_consistency: _num01(vis.overall_consistency),
    blink_test: vis.blink_test || null,
    inconsistencies: Array.isArray(vis.inconsistencies) ? vis.inconsistencies : [],
    persisted,
    tokens: usage?.total_tokens ?? null,
  };
}
