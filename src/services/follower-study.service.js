/**
 * follower-study.service.js — Estudio de seguidores bajo demanda.
 *
 * POR QUE EXISTE: un community manager no tiene tiempo de abrir 300 perfiles y
 * leerlos. Vera si. El hallazgo no es el censo ("tienes 12.000 seguidores"), es
 * la frase incomoda: "la persona que dice que tu audiencia son atletas no
 * aparece por ningun lado en tus ultimos 300 seguidores".
 *
 * DOS CORRIDAS, DOS PAGOS. La lista es barata y delgada — en Instagram devuelve
 * username, nombre y si es privado, NADA mas. La bio, los contadores, el rubro y
 * el enlace solo llegan con una segunda corrida por perfil, que cuesta 3x. Por
 * eso se listan muchos y se enriquecen pocos.
 *
 * LA MUESTRA NO ES ALEATORIA Y HAY QUE DECIRLO. Los actores devuelven a los
 * seguidores en el orden de la plataforma: los mas RECIENTES primero. Esto no
 * describe "tu audiencia", describe "quien esta llegando ahora" — que para
 * decidir contenido suele ser mas util, pero no es lo mismo. Se muestrea salteado
 * sobre lo listado para no leer solo el ultimo dia de altas.
 *
 * LO QUE SE GUARDA Y LO QUE NO. El retrato agregado es permanente (es la serie
 * que deja ver una audiencia derivar). Las filas por persona caducan a los 30
 * dias: sirven para volver a preguntar sin pagar de nuevo, no para acumular una
 * base de datos de gente que no es cliente nuestro.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || "";
const PUBLIC_URL = (process.env.AI_ENGINE_PUBLIC_URL || "https://api.aismartcontent.io").replace(/\/+$/, "");
const WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || "";

// Topes. El de listar tiene piso 50 porque el actor de Instagram rechaza menos.
export const LISTAR_DEFAULT = 1000;
export const LISTAR_MAX = 5000;
export const LISTAR_MIN = 50;
export const ENRIQUECER_DEFAULT = 300;
export const ENRIQUECER_MAX = 600;
// Un estudio reciente no se vuelve a pagar: una base de seguidores no cambia de
// cara en una semana.
export const REUSO_DIAS = 7;

/* ── Fase 1: quienes son ─────────────────────────────────────────────────── */
const LISTAR = {
  instagram: {
    id: "scraping_solutions~instagram-scraper-followers-following-no-cookies",
    costPerItem: 0.0007,
    input: (handle, cap) => ({ Account: [handle], resultsLimit: cap, dataToScrape: "Followers" }),
  },
  tiktok: {
    id: "scraping_solutions~tiktok-followers-following-scraper",
    costPerItem: 0.0004,
    input: (handle, cap) => ({ Account: [handle], dataToScrape: "followers", resultsLimit: cap }),
  },
  x: {
    id: "kaitoeasyapi~premium-x-follower-scraper-following-data",
    costPerItem: 0.00015,
    input: (handle, cap) => ({
      user_names: [handle], maxFollowers: cap, getFollowers: true,
      getFollowing: false, maxFollowings: 0,
    }),
  },
};

/* ── Fase 2: como son (bio, tamano, rubro, enlace) ───────────────────────── */
const ENRIQUECER = {
  instagram: {
    id: "apify~instagram-profile-scraper",
    costPerItem: 0.0023,
    input: (handles) => ({ usernames: handles }),
  },
  tiktok: {
    id: "clockworks~tiktok-profile-scraper",
    costPerItem: 0.0020,
    input: (handles) => ({ profiles: handles, profileScrapeSections: [], resultsPerPage: 1 }),
  },
  // X ya devuelve el perfil completo en la lista: no hay segunda corrida.
};

export function puedeEstudiar(network) {
  return !!LISTAR[String(network || "").toLowerCase()];
}

/* ── Normalizacion: cada actor nombra los campos a su manera ─────────────── */
const txt = (v) => (v == null ? null : String(v).trim() || null);
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function normalizarListado(net, r) {
  if (net === "x") {
    return {
      handle: txt(r.userName || r.username || r.screen_name),
      external_id: txt(r.id || r.id_str),
      nombre: txt(r.name || r.full_name),
      bio: txt(r.description),
      es_privado: r.protected ?? r.isPrivate ?? null,
      es_verificado: r.isBlueVerified ?? r.verified ?? null,
      seguidores: num(r.followers ?? r.followersCount),
      siguiendo: num(r.following ?? r.followingCount),
      publicaciones: num(r.statusesCount),
    };
  }
  if (net === "tiktok") {
    return {
      handle: txt(r.uniqueId || r.username || r.userName),
      external_id: txt(r.id || r.secUid),
      nombre: txt(r.nickname || r.full_name),
      bio: txt(r.signature),
      es_privado: r.privateAccount ?? r.is_private ?? null,
      es_verificado: r.verified ?? r.is_verified ?? null,
      seguidores: null, siguiendo: null, publicaciones: null,
    };
  }
  return {                                   // instagram
    handle: txt(r.username),
    external_id: txt(r.id),
    nombre: txt(r.full_name),
    bio: null,                               // la lista de IG NO trae bio
    es_privado: r.is_private ?? null,
    es_verificado: r.is_verified ?? null,
    seguidores: null, siguiendo: null, publicaciones: null,
  };
}

function normalizarEnriquecido(net, r) {
  if (net === "tiktok") {
    const a = r.authorMeta || r;
    return {
      handle: txt(a.name || a.uniqueId || a.nickName),
      bio: txt(a.signature),
      seguidores: num(a.fans), siguiendo: num(a.following), publicaciones: num(a.video),
      es_privado: a.privateAccount ?? null, es_verificado: a.verified ?? null,
      enlace_externo: txt(a.bioLink), categoria: txt(a.commerceUserInfo?.category),
    };
  }
  return {                                   // instagram
    handle: txt(r.username),
    bio: txt(r.biography),
    seguidores: num(r.followersCount), siguiendo: num(r.followsCount), publicaciones: num(r.postsCount),
    es_privado: r.private ?? null, es_verificado: r.verified ?? null,
    enlace_externo: txt(r.externalUrl), categoria: txt(r.businessCategoryName),
  };
}

/* ── Apify ───────────────────────────────────────────────────────────────── */
async function arrancarActor(actorId, input, jobId, fase) {
  // El webhook lleva jobId Y fase: un mismo estudio recibe DOS avisos y sin la
  // fase no habria como saber cual de las dos corridas termino.
  // OJO: Apify solo interpola variables de PRIMER nivel — `resource` va entero
  // y sin comillas (es objeto), y se desarma en el handler.
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.ABORTED", "ACTOR.RUN.TIMED_OUT"],
    requestUrl: `${PUBLIC_URL}/webhooks/apify-followers`,
    headersTemplate: JSON.stringify({ "x-webhook-secret": WEBHOOK_SECRET }),
    payloadTemplate: `{"jobId":"${jobId}","fase":"${fase}","resource":{{resource}}}`,
  }];
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`
    + `&webhooks=${encodeURIComponent(Buffer.from(JSON.stringify(webhooks)).toString("base64"))}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  const run = json?.data;
  if (!res.ok || !run?.id) {
    throw new Error(`no se pudo arrancar ${actorId}: ${json?.error?.message || `apify ${res.status}`}`);
  }
  return run;
}

async function bajarDataset(datasetId) {
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
  if (!res.ok) throw new Error(`no se pudo bajar el dataset ${datasetId}: ${res.status}`);
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

/* ── El retrato: solo lo que se puede CONTAR ─────────────────────────────────
   La lectura cualitativa (que dicen esas bios, que grupos forman) la escribe
   Vera leyendo los perfiles. Aqui no se interpreta nada: si este objeto
   opinara, el tablero tendria una opinion con cara de medicion. */
function calcularRetrato(filas, listados) {
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const mediana = (xs) => {
    const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const enr = filas.filter((f) => f.enriquecido);
  const conBio = enr.filter((f) => f.bio && f.bio.length > 1);
  const top = (xs, n = 8) => {
    const c = {};
    xs.filter(Boolean).forEach((x) => { c[x] = (c[x] || 0) + 1; });
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ valor: k, n: v }));
  };
  const dominio = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
  // Heuristica de cuenta vacia/inflada: sigue a muchos, no lo sigue casi nadie y
  // casi no publica. No es "bot" probado — es "no parece una persona activa".
  const inertes = enr.filter((f) =>
    (f.siguiendo ?? 0) > 500 && (f.seguidores ?? 0) < 80 && (f.publicaciones ?? 0) < 5);

  return {
    muestra: {
      listados,
      enriquecidos: enr.length,
      orden: "los mas recientes primero — NO es una muestra aleatoria de toda la base",
      salteo: "muestreo salteado sobre lo listado, no los primeros N",
    },
    cuentas: {
      privadas_pct: pct(filas.filter((f) => f.es_privado === true).length, filas.length),
      verificadas_pct: pct(filas.filter((f) => f.es_verificado === true).length, filas.length),
      sin_bio_pct: pct(enr.length - conBio.length, enr.length),
      con_enlace_pct: pct(enr.filter((f) => f.enlace_externo).length, enr.length),
      de_negocio_pct: pct(enr.filter((f) => f.categoria).length, enr.length),
    },
    tamano: {
      seguidores_mediana: mediana(enr.map((f) => f.seguidores)),
      siguiendo_mediana: mediana(enr.map((f) => f.siguiendo)),
      publicaciones_mediana: mediana(enr.map((f) => f.publicaciones)),
    },
    actividad: {
      sin_publicaciones_pct: pct(enr.filter((f) => (f.publicaciones ?? 0) === 0).length, enr.length),
      parecen_inertes_pct: pct(inertes.length, enr.length),
    },
    rubros: top(enr.map((f) => f.categoria)),
    dominios: top(enr.map((f) => dominio(f.enlace_externo))),
    calculado_el: new Date().toISOString(),
  };
}

/* ── API del servicio ────────────────────────────────────────────────────── */

/**
 * Arranca el estudio: lista seguidores y, al terminar, enriquece una muestra.
 * @returns {Promise<{job_id, status, fase, network, handle, reused, estimated_cost_usd}>}
 */
export async function requestStudy({
  organizationId, brandContainerId = null, entityId = null, subjectKind = "monitoreado",
  network, handle, listarCap = LISTAR_DEFAULT, enriquecerCap = ENRIQUECER_DEFAULT, reason = null,
}) {
  if (!APIFY_TOKEN) throw new Error("APIFY_API_TOKEN no configurado");
  const net = String(network || "").toLowerCase();
  const h = String(handle || "").trim().replace(/^@+/, "");
  if (!h) throw new Error("falta el handle");
  const actor = LISTAR[net];
  if (!actor) {
    throw new Error(
      `no hay actor de seguidores para "${net}". Instagram, TikTok y X si; YouTube no expone `
      + `suscriptores y Facebook no expone seguidores de pagina — no es una limitacion nuestra.`);
  }
  if (!organizationId) throw new Error("falta organizationId");

  const lCap = Math.max(LISTAR_MIN, Math.min(LISTAR_MAX, Number(listarCap) || LISTAR_DEFAULT));
  const eCap = Math.max(0, Math.min(ENRIQUECER_MAX, Number(enriquecerCap) ?? ENRIQUECER_DEFAULT));

  // Reuso: un estudio de esta semana ya esta pagado.
  const desde = new Date(Date.now() - REUSO_DIAS * 864e5).toISOString();
  const { data: previo } = await supabase
    .from("follower_study_jobs")
    .select("id, status, fase, seguidores_listados, seguidores_enriquecidos, retrato")
    .eq("organization_id", organizationId).eq("network", net).eq("handle", h)
    .gte("created_at", desde)
    .in("status", ["queued", "running", "done"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (previo) {
    return {
      job_id: previo.id, status: previo.status, fase: previo.fase, network: net, handle: h,
      reused: true, estimated_cost_usd: 0,
      note: previo.fase === "listo"
        ? `ya estudiado hace menos de ${REUSO_DIAS} dias (${previo.seguidores_enriquecidos} perfiles): se reutiliza, no se vuelve a pagar`
        : "ya hay un estudio en curso para esta cuenta",
    };
  }

  const enr = ENRIQUECER[net];
  const costo = lCap * actor.costPerItem + (enr ? Math.min(eCap, lCap) * enr.costPerItem : 0);

  const { data: job, error: jobErr } = await supabase
    .from("follower_study_jobs")
    .insert({
      organization_id: organizationId, brand_container_id: brandContainerId, entity_id: entityId,
      subject_kind: subjectKind, network: net, handle: h, reason,
      listar_cap: lCap, enriquecer_cap: eCap,
      apify_actor_id: actor.id, apify_actor_id_enrich: enr?.id || null,
      status: "queued", fase: "listando",
      purga_individuales_el: new Date(Date.now() + 30 * 864e5).toISOString(),
    })
    .select("id").single();
  if (jobErr) throw new Error(`no se pudo crear el estudio: ${jobErr.message}`);

  try {
    const run = await arrancarActor(actor.id, actor.input(h, lCap), job.id, "listando");
    await supabase.from("follower_study_jobs")
      .update({ status: "running", apify_run_id: run.id, apify_dataset_id: run.defaultDatasetId, started_at: new Date().toISOString() })
      .eq("id", job.id);
    return {
      job_id: job.id, status: "running", fase: "listando", network: net, handle: h,
      reused: false, estimated_cost_usd: Number(costo.toFixed(3)),
      note: `listando hasta ${lCap} seguidores; al terminar se enriquecen ${eCap} salteados. `
          + `Recoge con getFollowerStudy(job_id) — suele tardar 1-3 minutos.`,
    };
  } catch (e) {
    await supabase.from("follower_study_jobs")
      .update({ status: "failed", fase: "fallido", error: String(e.message).slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", job.id);
    throw e;
  }
}

/** Ingesta de cualquiera de las dos fases. La llama el webhook. */
export async function ingestStudy({ jobId, fase, runId, datasetId, status }) {
  const { data: job } = await supabase
    .from("follower_study_jobs").select("*")
    .eq("id", jobId || "00000000-0000-0000-0000-000000000000").maybeSingle();
  if (!job) throw new Error(`estudio ${jobId} no encontrado`);

  if (status && status !== "SUCCEEDED") {
    await supabase.from("follower_study_jobs")
      .update({ status: "failed", fase: "fallido", error: `Apify ${status} en fase ${fase}`, finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return { ok: false, status };
  }

  const ds = datasetId || (fase === "enriqueciendo" ? job.apify_dataset_id_enrich : job.apify_dataset_id);
  const filas = await bajarDataset(ds);

  if (fase === "listando") {
    const vistos = new Set();
    const rows = [];
    for (const r of filas) {
      const n = normalizarListado(job.network, r);
      if (!n.handle || vistos.has(n.handle)) continue;
      vistos.add(n.handle);
      rows.push({
        job_id: job.id, organization_id: job.organization_id, network: job.network,
        ...n, enriquecido: !!(n.bio || n.seguidores != null), raw: null,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("studied_followers")
        .upsert(rows.slice(i, i + 500), { onConflict: "job_id,network,handle" });
      if (error) throw new Error(`no se pudieron guardar los listados: ${error.message}`);
    }

    const enr = ENRIQUECER[job.network];
    // Sin actor de enriquecimiento (X ya vino completo) el estudio cierra aqui.
    if (!enr || !job.enriquecer_cap) return cerrar(job, rows.length);

    // Muestreo SALTEADO: leer los primeros 300 seria leer solo el ultimo dia de
    // altas. Se recorre toda la lista a pasos para que la muestra la cruce entera.
    const paso = Math.max(1, Math.floor(rows.length / job.enriquecer_cap));
    const muestra = [];
    for (let i = 0; i < rows.length && muestra.length < job.enriquecer_cap; i += paso) muestra.push(rows[i].handle);
    if (!muestra.length) return cerrar(job, rows.length);

    const run = await arrancarActor(enr.id, enr.input(muestra), job.id, "enriqueciendo");
    await supabase.from("follower_study_jobs").update({
      fase: "enriqueciendo", seguidores_listados: rows.length,
      apify_run_id_enrich: run.id, apify_dataset_id_enrich: run.defaultDatasetId,
    }).eq("id", job.id);
    return { ok: true, fase: "enriqueciendo", listados: rows.length, a_enriquecer: muestra.length };
  }

  // fase enriqueciendo
  let tocadas = 0;
  for (const r of filas) {
    const n = normalizarEnriquecido(job.network, r);
    if (!n.handle) continue;
    const { error } = await supabase.from("studied_followers")
      .update({ ...n, enriquecido: true, raw: null })
      .eq("job_id", job.id).eq("handle", n.handle);
    if (!error) tocadas++;
  }
  return cerrar(job, job.seguidores_listados || 0, tocadas);
}

async function cerrar(job, listados, enriquecidos = 0) {
  const { data: filas } = await supabase
    .from("studied_followers")
    .select("handle, nombre, bio, es_privado, es_verificado, seguidores, siguiendo, publicaciones, enlace_externo, categoria, enriquecido")
    .eq("job_id", job.id).limit(5000);
  const retrato = calcularRetrato(filas || [], listados);
  const actor = LISTAR[job.network], enr = ENRIQUECER[job.network];
  const costo = listados * (actor?.costPerItem || 0) + enriquecidos * (enr?.costPerItem || 0);
  await supabase.from("follower_study_jobs").update({
    status: "done", fase: "listo",
    seguidores_listados: listados,
    seguidores_enriquecidos: (filas || []).filter((f) => f.enriquecido).length,
    retrato, cost_usd: Number(costo.toFixed(4)),
    finished_at: new Date().toISOString(),
  }).eq("id", job.id);
  return { ok: true, fase: "listo", listados, enriquecidos: (filas || []).filter((f) => f.enriquecido).length };
}

/**
 * Recoge el estudio. Devuelve el retrato SIEMPRE y los perfiles solo si se piden:
 * el juicio se hace sobre el agregado, y las bios son para leerlas, no para
 * llenar el contexto de Vera con 300 filas que no va a usar.
 */
export async function getStudy({ jobId, incluirPerfiles = true, limit = 300 }) {
  const { data: job, error } = await supabase
    .from("follower_study_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !job) throw new Error(`estudio ${jobId} no encontrado`);

  const base = {
    job_id: job.id, network: job.network, handle: job.handle, subject_kind: job.subject_kind,
    status: job.status, fase: job.fase, listo: job.fase === "listo",
    seguidores_listados: job.seguidores_listados, seguidores_enriquecidos: job.seguidores_enriquecidos,
    cost_usd: job.cost_usd, retrato: job.retrato, error: job.error,
    individuales_caducan_el: job.purga_individuales_el,
  };
  if (job.fase !== "listo") {
    return { ...base, note: "el estudio sigue en curso; vuelve a llamar en un minuto" };
  }
  if (!incluirPerfiles) return base;

  const { data: perfiles } = await supabase
    .from("studied_followers")
    .select("handle, nombre, bio, seguidores, siguiendo, publicaciones, categoria, enlace_externo, es_privado, es_verificado")
    .eq("job_id", job.id).eq("enriquecido", true)
    .gt("expira_el", new Date().toISOString())
    .limit(Math.max(1, Math.min(600, Number(limit) || 300)));
  return {
    ...base,
    perfiles: perfiles || [],
    como_leerlo: "El retrato son los numeros; el hallazgo esta en las bios. Agrupa por lo que "
      + "esas personas DICEN ser, no por lo que suponemos. Y contrasta contra la persona que la "
      + "marca cree tener: si no coinciden, ESO es la card.",
  };
}

/**
 * Gasto estimado de estudios en el mes en curso, en USD. Cota SUPERIOR sobre los
 * topes pedidos cuando el estudio no cerro; el costo real cuando si.
 */
export async function gastoDelMes({ organizationId } = {}) {
  const desde = new Date();
  desde.setUTCDate(1);
  desde.setUTCHours(0, 0, 0, 0);
  let q = supabase
    .from("follower_study_jobs")
    .select("network, listar_cap, enriquecer_cap, cost_usd")
    .gte("created_at", desde.toISOString());
  if (organizationId) q = q.eq("organization_id", organizationId);
  const { data, error } = await q;
  if (error) throw new Error(`no se pudo leer el gasto de estudios: ${error.message}`);
  const usd = (data || []).reduce((s, j) => {
    if (j.cost_usd != null) return s + Number(j.cost_usd);
    const l = LISTAR[j.network], e = ENRIQUECER[j.network];
    return s + (Number(j.listar_cap) || 0) * (l?.costPerItem || 0)
             + (Number(j.enriquecer_cap) || 0) * (e?.costPerItem || 0);
  }, 0);
  return { usd: Number(usd.toFixed(3)), estudios: (data || []).length, desde: desde.toISOString() };
}
