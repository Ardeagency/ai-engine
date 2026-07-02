/**
 * Brand Scrape Orchestrator — corre crawler + extractor + consolidator en background.
 *
 * Flow:
 *   1. createJob() inserta brand_scrape_jobs.status=queued y devuelve job_id
 *   2. runPipeline(jobId) corre en setImmediate:
 *        status='crawling' → crawlSite()
 *        status='extracting' → extractCorpus(pages)
 *        status='consolidating' → consolidate(corpus)
 *        status='done' con brand_payload + cost
 *
 * El frontend hace polling de /internal/brand-scrape/status/:id.
 */
import { supabase } from "../lib/supabase.js";
import { crawlSite } from "./site-crawler.service.js";
import { extractCorpus } from "./page-extractor.service.js";
import { consolidate } from "./brand-consolidator.service.js";
import { applyBrandPayloadToOrg } from "./brand-apply.service.js";
import { discoverAndSeedCompetitors } from "./brand-competitors.service.js";

/** Crea el job y retorna { job_id }. No corre nada. */
export async function createJob({ seedUrl, organizationId = null, createdBy = null }) {
  if (!seedUrl) throw new Error("seedUrl requerido");
  const { data, error } = await supabase
    .from("brand_scrape_jobs")
    .insert({
      seed_url: seedUrl,
      organization_id: organizationId,
      created_by: createdBy,
      status: "queued",
      progress: { phase: "queued" },
    })
    .select("id")
    .single();
  if (error) throw new Error(`createJob: ${error.message}`);
  return { jobId: data.id };
}

async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from("brand_scrape_jobs")
    .update({ ...patch })
    .eq("id", jobId);
  if (error) console.error(`updateJob(${jobId}) failed:`, error.message);
}

async function setProgress(jobId, progressPatch) {
  // Append patch al jsonb progress
  const { data } = await supabase
    .from("brand_scrape_jobs")
    .select("progress")
    .eq("id", jobId)
    .maybeSingle();
  const merged = { ...(data?.progress || {}), ...progressPatch, updated_at: new Date().toISOString() };
  await updateJob(jobId, { progress: merged });
}

/**
 * runPipeline — corre todo el pipeline en background.
 * El caller debe envolverlo en setImmediate para no bloquear la respuesta HTTP.
 */
export async function runPipeline(jobId, opts = {}) {
  const {
    maxPages = 80,
    maxDepth = 4,
    maxConcurrent = 5,
    delayMs = 200,
    timeoutMs = 12000,
  } = opts;

  try {
    // Recuperar seedUrl del job
    const { data: job, error: jobErr } = await supabase
      .from("brand_scrape_jobs")
      .select("seed_url, organization_id")
      .eq("id", jobId)
      .maybeSingle();
    if (jobErr || !job) throw new Error("job not found");

    // ── 1. CRAWLING ──
    await updateJob(jobId, { status: "crawling", stage: "Descubriendo rutas" });
    const crawlResult = await crawlSite({
      seedUrl: job.seed_url,
      maxPages, maxDepth, maxConcurrent, delayMs, timeoutMs,
      includeHtml: true,
      onProgress: async (p) => {
        if (p.phase === "batch_end") {
          await setProgress(jobId, {
            phase: "crawling",
            depth: p.depth,
            pages_crawled: p.pages,
            queue_remaining: p.queue,
            new_routes_in_batch: p.newRoutesInBatch,
          });
        }
      },
    });

    await setProgress(jobId, {
      phase: "crawling_done",
      pages_crawled: crawlResult.stats.total_pages,
      duration_ms: crawlResult.stats.duration_ms,
      terminated: crawlResult.terminated,
    });

    if (crawlResult.pages.length === 0) {
      throw new Error("Crawler no descubrio ninguna pagina. Revisa que la URL este accesible.");
    }

    // ── 2. EXTRACTING ──
    await updateJob(jobId, { status: "extracting", stage: "Analizando paginas" });
    const seedHostname = new URL(crawlResult.seed).hostname;
    const corpus = extractCorpus(crawlResult.pages, seedHostname);

    await setProgress(jobId, {
      phase: "extracting_done",
      colors_found: corpus.aggregated.colors_top.length,
      products_found: corpus.aggregated.products.length,
      services_found: corpus.aggregated.services.length,
      social_found: corpus.aggregated.social.length,
    });

    // Persistir raw_corpus (sin html crudo — solo metadata por page)
    await updateJob(jobId, { raw_corpus: corpus });

    // ── 3. CONSOLIDATING (LLM) ──
    await updateJob(jobId, { status: "consolidating", stage: "Consultando Vera (gpt-4o)" });
    const result = await consolidate(corpus);

    await setProgress(jobId, {
      phase: "consolidating_done",
      llm_cost_usd: result.cost_usd,
      llm_tokens_in: result.tokens_in,
      llm_tokens_out: result.tokens_out,
      batches: result.batches,
    });

    // ── 3.5 APPLY (auto-builder): volcar el ADN a las tablas del mercado ──
    let applyResult = null;
    if (job.organization_id) {
      try {
        await updateJob(jobId, { stage: "Guardando ADN en la marca" });
        applyResult = await applyBrandPayloadToOrg(job.organization_id, result.brand_payload, job.seed_url);
        await setProgress(jobId, { phase: "applied", apply: applyResult });
        console.log(`brand-scrape: job ${jobId} APPLIED to org ${job.organization_id}`, applyResult);
      } catch (applyErr) {
        console.error(`brand-scrape: apply failed for job ${jobId}:`, applyErr.message);
        await setProgress(jobId, { phase: "apply_failed", apply_error: applyErr.message });
      }
    }

    // ── 3.6 COMPETIDORES (auto-builder): descubrir y sembrar ──
    if (job.organization_id && applyResult && applyResult.container_id) {
      try {
        await updateJob(jobId, { stage: "Buscando competencia" });
        const compResult = await discoverAndSeedCompetitors(job.organization_id, applyResult.container_id, result.brand_payload, job.seed_url);
        await setProgress(jobId, { phase: "competitors_seeded", competitors: compResult });
        console.log("brand-scrape: COMPETITORS seeded", compResult);
      } catch (compErr) {
        console.error("brand-scrape: competitors failed:", compErr.message);
        await setProgress(jobId, { phase: "competitors_failed", competitors_error: compErr.message });
      }
    }

    // ── 4. DONE ──
    await updateJob(jobId, {
      status: "done",
      stage: "Listo",
      brand_payload: result.brand_payload,
      cost_usd: result.cost_usd,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      finished_at: new Date().toISOString(),
    });

    console.log(`brand-scrape: job ${jobId} DONE. pages=${crawlResult.stats.total_pages} cost=$${result.cost_usd.toFixed(4)}`);
    return { ok: true };
  } catch (e) {
    console.error(`brand-scrape: job ${jobId} FAILED:`, e.message);
    await updateJob(jobId, {
      status: "failed",
      error: e.message || String(e),
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: e.message };
  }
}

/**
 * cancelJob — marca un job como cancelado (best effort, no aborta el pipeline ya corriendo).
 */
export async function cancelJob(jobId) {
  await updateJob(jobId, { status: "cancelled", finished_at: new Date().toISOString() });
}

/**
 * getStatus — lee el estado actual del job.
 */
export async function getStatus(jobId) {
  const { data, error } = await supabase
    .from("brand_scrape_jobs")
    .select("id, seed_url, status, stage, progress, brand_payload, error, cost_usd, tokens_in, tokens_out, started_at, finished_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
