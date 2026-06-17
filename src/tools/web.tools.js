/**
 * web.tools.js — Búsqueda y lectura de internet abierto para Vera, vía Tavily.
 *
 * Tavily es un motor de búsqueda hecho para agentes LLM (NO un scraper de
 * perfiles como Apify): `/search` devuelve una respuesta sintetizada + fuentes
 * rankeadas con su contenido extraído, y `/extract` lee el contenido limpio de
 * URLs concretas. Esto le da a Vera research web con CITAS — alineado con la
 * política "CERO datos falsos": toda afirmación queda atada a una fuente.
 *
 * Read-only: no escribe en la DB ni tiene efectos externos → requiresConsent:false.
 * El dispatcher inyecta org-scope y audita; estas tools no necesitan IDs de marca.
 */
const TAVILY_API_KEY  = process.env.TAVILY_API_KEY;
const SEARCH_URL      = "https://api.tavily.com/search";
const EXTRACT_URL     = "https://api.tavily.com/extract";
const HTTP_TIMEOUT_MS = Number(process.env.TAVILY_TIMEOUT_MS) || 20_000;
const MAX_RESULTS_CAP = 8;   // tope duro de fuentes por búsqueda (control de costo)
const MAX_URLS_CAP    = 5;   // tope duro de URLs por extracción
const MAX_CONTENT     = 12_000; // chars por documento extraído (evita reventar el contexto)

async function _tavily(url, body) {
  if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY no configurada en el entorno de ai-engine");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.detail?.error || data?.error || `HTTP ${res.status}`;
      throw new Error(`Tavily: ${msg}`);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Tavily: timeout tras ${HTTP_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Acepta params planos o anidados bajo `params` (igual que searchIntelligence).
function _unwrap(input) {
  if (input && typeof input === "object" && input.params && typeof input.params === "object") {
    return input.params;
  }
  return input || {};
}

/**
 * webSearch — busca en internet abierto y devuelve respuesta + fuentes citables.
 *
 * params: {
 *   query: string (REQUERIDO),
 *   max_results?: 1..8 (def 5),
 *   topic?: "general" | "news" (def general),
 *   search_depth?: "basic" | "advanced" (def basic),
 *   days?: number (solo topic=news, def 7, máx 30),
 *   include_domains?: string[], exclude_domains?: string[]
 * }
 */
export async function webSearch(input = {}) {
  const p = _unwrap(input);
  const query = (p.query || "").toString().trim();
  if (!query) throw new Error("webSearch: 'query' requerido");

  const body = {
    query,
    max_results: Math.min(Math.max(parseInt(p.max_results, 10) || 5, 1), MAX_RESULTS_CAP),
    include_answer: p.include_answer === false ? false : "advanced",
    search_depth: p.search_depth === "advanced" ? "advanced" : "basic",
    topic: p.topic === "news" ? "news" : "general",
  };
  if (body.topic === "news") body.days = Math.min(Math.max(parseInt(p.days, 10) || 7, 1), 30);
  if (Array.isArray(p.include_domains) && p.include_domains.length) body.include_domains = p.include_domains.slice(0, 20);
  if (Array.isArray(p.exclude_domains) && p.exclude_domains.length) body.exclude_domains = p.exclude_domains.slice(0, 20);

  const data = await _tavily(SEARCH_URL, body);
  return {
    success: true,
    query,
    answer: data.answer ?? null,
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    })),
    response_time: data.response_time ?? null,
  };
}

/**
 * webFetch — lee el contenido limpio de 1..5 URLs concretas (no scraping social).
 *
 * params: { urls: string | string[] (REQUERIDO) }
 */
export async function webFetch(input = {}) {
  const p = _unwrap(input);
  let urls = p.urls;
  if (typeof urls === "string") urls = [urls];
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("webFetch: 'urls' requerido (string o array de URLs http(s))");
  }
  urls = urls.filter((u) => /^https?:\/\//i.test(String(u))).slice(0, MAX_URLS_CAP);
  if (!urls.length) throw new Error("webFetch: ninguna URL http(s) válida");

  const data = await _tavily(EXTRACT_URL, { urls });
  return {
    success: true,
    results: (data.results || []).map((r) => ({
      url: r.url,
      title: r.title ?? null,
      content: (r.raw_content || "").slice(0, MAX_CONTENT),
    })),
    failed: data.failed_results || [],
  };
}
