/**
 * comment-harvest.service.js — cosecha de comentarios BAJO DEMANDA para Vera.
 *
 * EL PROBLEMA (medido, no supuesto): los scrapers de perfil traen los primeros
 * comentarios de cada post y nada mas. En la DB de produccion, Instagram tiene
 * 39.6 comentarios capturados de media sobre 643 reales — un 6%. TikTok,
 * YouTube, Facebook y X estan a CERO. Vera leia "la voz de la audiencia" sobre
 * esa esquirla.
 *
 * POR QUE NO HAY CRON: estos actores cobran POR COMENTARIO ($0.001-$0.0023).
 * Cosechar a diario todo el monitoreo se comeria el presupuesto Apify en dias.
 * Se disparan SOLO cuando Vera decide que necesita el hilo completo de un post
 * concreto — y con un tope duro de comentarios por peticion.
 *
 * POR QUE ASINCRONO: el actor tarda mas que la ventana de una tool. El flujo:
 *   1. Vera pide  → se crea el job y se arranca el actor con un webhook nuestro
 *   2. Apify termina → llama a POST /webhooks/apify-comments con el runId
 *   3. ai-engine descarga el dataset, normaliza e inserta en brand_post_comments
 *   4. el job pasa a done → Vera recoge y sigue con lo que estaba haciendo
 *
 * Si el actor tarda mas de lo que Vera puede esperar, el job NO se pierde:
 * queda listo y ella lo recoge por id en su siguiente paso.
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || "";
const PUBLIC_URL = (process.env.AI_ENGINE_PUBLIC_URL || "https://api.aismartcontent.io").replace(/\/+$/, "");
const WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || "";

// Tope duro. A $0.0023 por comentario en Instagram, 200 comentarios son ~$0.46:
// caro para dispararlo a la ligera, barato para una lectura que lo justifique.
export const CAP_DEFAULT = 200;
export const CAP_MAX = 500;

/**
 * Actor por red + como se le pide un POST concreto. Los ids y el modelo de
 * cobro estan verificados contra la API de Apify (2026-07-22).
 * `costPerComment` es el precio del tier BRONZE, que es el del plan actual;
 * sirve para estimar y avisar, nunca para cobrar (el costo real lo devuelve
 * Apify al terminar la corrida).
 */
const ACTORS = {
  instagram: {
    id: "apify~instagram-comment-scraper",
    costPerComment: 0.0023,
    input: (url, cap) => ({ directUrls: [url], resultsLimit: cap }),
  },
  tiktok: {
    id: "clockworks~tiktok-comments-scraper",
    costPerComment: 0.001,
    input: (url, cap) => ({ postURLs: [url], commentsPerPost: cap, maxRepliesPerComment: 0 }),
  },
  youtube: {
    id: "streamers~youtube-comments-scraper",
    costPerComment: 0.0015,
    input: (url, cap) => ({ startUrls: [{ url }], maxComments: cap }),
  },
  facebook: {
    id: "apify~facebook-comments-scraper",
    costPerComment: 0.002,
    input: (url, cap) => ({ startUrls: [{ url }], resultsLimit: cap }),
  },
  x: {
    id: "kaitoeasyapi~twitter-reply",
    costPerComment: 0.00025,
    input: (url, cap) => ({ startUrls: [url], maxItems: cap }),
  },
};

export function actorFor(network) {
  return ACTORS[String(network || "").toLowerCase()] || null;
}

/* ── URL publica del post ────────────────────────────────────────────────────
   Los posts de competencia no guardan permalink (0% de cobertura): se
   reconstruye desde network + post_id + handle, con el mismo algoritmo que usa
   el frontend. Sin URL no hay nada que pedirle al actor. */
function postUrl(net, postId, handle, permalink) {
  if (permalink && /^https?:\/\//i.test(permalink)) return permalink;
  const id = String(postId || "").trim();
  if (!id) return null;
  const h = String(handle || "").trim().replace(/^@+/, "");
  switch (String(net || "").toLowerCase()) {
    case "instagram": {
      if (!/^\d+$/.test(id)) return null;
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      let n = BigInt(id), sc = "";
      while (n > 0n) { sc = A[Number(n % 64n)] + sc; n /= 64n; }
      return sc ? `https://www.instagram.com/p/${sc}/` : null;
    }
    case "tiktok":   return h ? `https://www.tiktok.com/@${h}/video/${id}` : null;
    case "youtube":  return `https://www.youtube.com/watch?v=${id}`;
    case "facebook": return h ? `https://www.facebook.com/${h}/posts/${id}` : `https://www.facebook.com/${id}`;
    case "x":
    case "twitter":  return h ? `https://x.com/${h}/status/${id}` : `https://x.com/i/status/${id}`;
    default:         return null;
  }
}

/**
 * Encola la cosecha de un post y arranca el actor.
 * @returns {Promise<{job_id, status, network, post_url, cap, estimated_cost_usd}>}
 */
export async function requestHarvest({ brandPostId, cap = CAP_DEFAULT, reason = null }) {
  if (!APIFY_TOKEN) throw new Error("APIFY_API_TOKEN no configurado");
  const limite = Math.max(10, Math.min(CAP_MAX, Number(cap) || CAP_DEFAULT));

  const { data: post, error } = await supabase
    .from("brand_posts")
    .select("id, network, post_id, profile_handle, permalink, brand_container_id, metrics")
    .eq("id", brandPostId)
    .maybeSingle();
  if (error || !post) throw new Error(`brand_post no encontrado: ${brandPostId}`);

  const { data: bc } = await supabase
    .from("brand_containers").select("organization_id").eq("id", post.brand_container_id).maybeSingle();
  const organizationId = bc?.organization_id;
  if (!organizationId) throw new Error("no se pudo resolver la organizacion del post");

  const actor = actorFor(post.network);
  if (!actor) throw new Error(`sin actor de comentarios para la red "${post.network}"`);

  const url = postUrl(post.network, post.post_id, post.profile_handle, post.permalink);
  if (!url) throw new Error(`no se pudo construir la URL del post (${post.network})`);

  // Reuso: si ya se cosecho este post hace poco y salio bien, no se vuelve a
  // pagar. La voz de una publicacion no cambia de un dia para otro.
  const { data: previo } = await supabase
    .from("comment_harvest_jobs")
    .select("id, status, comments_inserted, finished_at")
    .eq("brand_post_id", brandPostId)
    .in("status", ["done", "partial", "running", "queued"])
    .gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previo) {
    return {
      job_id: previo.id, status: previo.status, network: post.network, post_url: url,
      cap: limite, reused: true,
      note: previo.status === "done" || previo.status === "partial"
        ? `ya cosechado (${previo.comments_inserted} comentarios): se reutiliza, no se vuelve a pagar`
        : "ya hay una cosecha en curso para este post",
    };
  }

  const { data: job, error: jobErr } = await supabase
    .from("comment_harvest_jobs")
    .insert({
      organization_id: organizationId,
      brand_container_id: post.brand_container_id,
      brand_post_id: post.id,
      network: post.network,
      post_url: url,
      cap: limite,
      reason,
      apify_actor_id: actor.id,
      status: "queued",
    })
    .select("id")
    .single();
  if (jobErr) throw new Error(`no se pudo crear el job: ${jobErr.message}`);

  // El webhook lleva el job en payloadTemplate: cuando Apify avise, sabemos a
  // que peticion corresponde sin tener que adivinarlo por el runId.
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.ABORTED", "ACTOR.RUN.TIMED_OUT"],
    requestUrl: `${PUBLIC_URL}/webhooks/apify-comments`,
    headersTemplate: JSON.stringify({ "x-webhook-secret": WEBHOOK_SECRET }),
    // OJO: Apify NO interpola rutas anidadas entre comillas ("{{resource.status}}"
    // llega literal y rompe la ingesta). Solo sustituye las variables de primer
    // nivel, y sin comillas porque son objetos. Se manda `resource` entero y se
    // extrae aqui lo que haga falta.
    payloadTemplate: `{"jobId":"${job.id}","resource":{{resource}},"eventType":{{eventType}}}`,
  }];

  const started = await fetch(
    `https://api.apify.com/v2/acts/${actor.id}/runs?token=${APIFY_TOKEN}` +
    `&webhooks=${encodeURIComponent(Buffer.from(JSON.stringify(webhooks)).toString("base64"))}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actor.input(url, limite)),
    },
  );
  const runJson = await started.json().catch(() => ({}));
  const run = runJson?.data;
  if (!started.ok || !run?.id) {
    const msg = runJson?.error?.message || `apify ${started.status}`;
    await supabase.from("comment_harvest_jobs")
      .update({ status: "failed", error: msg, finished_at: new Date().toISOString() })
      .eq("id", job.id);
    throw new Error(`no se pudo arrancar el actor: ${msg}`);
  }

  await supabase.from("comment_harvest_jobs").update({
    status: "running",
    apify_run_id: run.id,
    apify_dataset_id: run.defaultDatasetId || null,
    started_at: new Date().toISOString(),
  }).eq("id", job.id);

  return {
    job_id: job.id, status: "running", network: post.network, post_url: url, cap: limite,
    estimated_cost_usd: Number((limite * actor.costPerComment).toFixed(3)),
    comentarios_reportados: Number(post.metrics?.comments) || null,
  };
}

/* ── Normalizacion: cada actor devuelve su propio dialecto ──────────────────
   Se queda con lo que sirve para leer audiencia (quien, que dijo, cuanto gusto)
   y se descarta el resto. */
function normalizeComment(net, it) {
  const n = String(net || "").toLowerCase();
  const pick = (...ks) => { for (const k of ks) { const v = k.split(".").reduce((o, p) => o?.[p], it); if (v != null && v !== "") return v; } return null; };
  const texto = pick("text", "comment", "content", "message", "full_text");
  if (!texto) return null;
  const likes = Number(pick("likesCount", "likes", "diggCount", "voteCount", "likeCount", "favorite_count")) || 0;
  const autor = pick("ownerUsername", "username", "author", "uniqueId", "authorName", "user.userName", "owner.username");
  return {
    external_comment_id: String(pick("id", "cid", "commentId", "comment_id") || "") || null,
    author_handle: autor ? String(autor).replace(/^@+/, "").slice(0, 120) : null,
    author_display_name: (pick("ownerName", "displayName", "author_name", "user.nickname") || null)?.toString().slice(0, 160) || null,
    author_pic_url: pick("ownerProfilePicUrl", "profilePicUrl", "avatarThumbnail", "user.avatarThumbnail") || null,
    content: String(texto).slice(0, 4000),
    posted_at: pick("timestamp", "createTimeISO", "publishedAt", "createdAt", "date") || null,
    metrics: { likes, replies_count: Number(pick("repliesCount", "replyCount", "reply_count")) || 0 },
    network: n,
    source: "apify_harvest",
  };
}

/**
 * Ingiere el dataset de una corrida terminada y cierra el job.
 * Idempotente: se puede reintentar sin duplicar (upsert por comentario).
 */
export async function ingestHarvest({ jobId, runId, datasetId, status }) {
  const { data: job } = await supabase
    .from("comment_harvest_jobs").select("*")
    .eq(jobId ? "id" : "apify_run_id", jobId || runId)
    .maybeSingle();
  if (!job) throw new Error(`job no encontrado (${jobId || runId})`);
  if (job.status === "done") return { already: true, inserted: job.comments_inserted };

  if (status && status !== "SUCCEEDED") {
    await supabase.from("comment_harvest_jobs").update({
      status: "failed", error: `apify: ${status}`, finished_at: new Date().toISOString(),
    }).eq("id", job.id);
    return { ok: false, status };
  }

  const ds = datasetId || job.apify_dataset_id;
  if (!ds) throw new Error("sin dataset que leer");
  const res = await fetch(`https://api.apify.com/v2/datasets/${ds}/items?token=${APIFY_TOKEN}&clean=true&limit=${job.cap}`);
  const items = await res.json().catch(() => []);
  const lista = Array.isArray(items) ? items : [];

  const filas = lista.map((it) => normalizeComment(job.network, it)).filter(Boolean).map((c) => ({
    ...c,
    // El unico UNIQUE de la tabla es (network, external_comment_id) y los NULL
    // NO chocan entre si: sin id propio, cada reingesta duplicaria el hilo. Se
    // deriva uno estable del contenido para que el upsert siga siendo idempotente.
    external_comment_id: c.external_comment_id
      || "h_" + crypto.createHash("sha1")
        .update(`${job.brand_post_id}|${c.author_handle || ""}|${c.content}`)
        .digest("hex").slice(0, 24),
    brand_post_id: job.brand_post_id,
    brand_container_id: job.brand_container_id,
    organization_id: job.organization_id,
  }));

  let insertados = 0;
  // En tandas: un post viral puede traer cientos y un INSERT gigante es fragil.
  for (let i = 0; i < filas.length; i += 100) {
    const tanda = filas.slice(i, i + 100);
    const { error } = await supabase.from("brand_post_comments")
      .upsert(tanda, { onConflict: "network,external_comment_id", ignoreDuplicates: true });
    if (!error) insertados += tanda.length;
    else console.warn(`[comment-harvest] tanda ${i}: ${error.message}`);
  }

  // Menos de lo pedido no es un fallo: puede que el post no tenga mas.
  const estado = filas.length === 0 ? "partial" : (filas.length < job.cap ? "partial" : "done");
  await supabase.from("comment_harvest_jobs").update({
    status: estado,
    comments_found: lista.length,
    comments_inserted: insertados,
    finished_at: new Date().toISOString(),
  }).eq("id", job.id);

  return { ok: true, found: lista.length, inserted: insertados, status: estado };
}

/** Estado + comentarios de un job, para que Vera recoja lo que pidio. */
export async function getHarvest({ jobId, limit = 200 }) {
  const { data: job } = await supabase
    .from("comment_harvest_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) throw new Error(`job no encontrado: ${jobId}`);
  if (!["done", "partial"].includes(job.status)) {
    return { status: job.status, listo: false, note: job.error || "la cosecha sigue en curso" };
  }
  const { data: comments } = await supabase.from("brand_post_comments")
    .select("author_handle, content, metrics, sentiment, posted_at")
    .eq("brand_post_id", job.brand_post_id)
    .order("posted_at", { ascending: false })
    .limit(Math.min(500, limit));
  return {
    status: job.status, listo: true,
    total_en_post: (comments || []).length,
    comentarios_cosechados: job.comments_inserted,
    comments: comments || [],
  };
}
