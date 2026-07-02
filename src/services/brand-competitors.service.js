/**
 * Brand Competitors Service — Etapa 3 del auto-builder de org.
 *
 * Dado el brand_payload + contexto de la marca, descubre competidores REALES con
 * gpt-4o y los siembra en la base:
 *   - intelligence_entities  (cada competidor; domain='social' si hay handle, si no 'web')
 *   - url_watchers           (sitio de cada competidor + el sitio propio)
 *   - palabras a monitorear  (fusionadas en brand_containers.palabras_clave)
 *
 * Lo llama el orchestrator tras applyBrandPayloadToOrg(). Best-effort.
 */
import { supabase } from "../lib/supabase.js";
import { chatCompletion } from "../lib/openai.js";

const MODEL = "gpt-4o";

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}
function normalizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  let s = u.trim();
  if (!s || /^(null|undefined|n\/a|na|none|-)$/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const url = new URL(s);
    if (!url.hostname || url.hostname.toLowerCase() === "null" || !url.hostname.includes(".")) return null;
    return url.href;
  } catch { return null; }
}

async function discoverCompetitors({ name, payload, seedUrl }) {
  const sys = `Eres un analista de inteligencia competitiva. Dada una marca, identifica entre 4 y 8 COMPETIDORES REALES, directos y de la MISMA categoria de producto y mercado.
Reglas CRITICAS:
- Solo competidores REALES, conocidos y verificables que compiten en la MISMA categoria. Si la marca vende cremas de mani / snacks saludables, NO incluyas marcas de mochilas (Totto), ropa, tecnologia ni genericas; deben ser del mismo rubro.
- website: OBLIGATORIO y real (formato https://dominio-real.com). Si NO conoces el sitio web real del competidor con certeza, NO lo incluyas en la lista. Esta TERMINANTEMENTE PROHIBIDO inventar dominios o devolver "null".
- instagram: el handle real sin @ si lo conoces con certeza; si no, null.
- reason: 1 frase de por que es competidor directo.
Prioriza los del mismo pais/mercado objetivo. Mejor POCOS competidores REALES y verificados que muchos inventados o irrelevantes.
Ademas devuelve monitor_keywords: 5-10 palabras/temas del sector a monitorear.`;

  const user = JSON.stringify({
    marca: name || null,
    nicho: payload.nicho_core || null,
    propuesta_valor: payload.propuesta_valor || null,
    palabras_clave: (payload.palabras_clave || []).slice(0, 15),
    mercado_objetivo: payload.mercado_objetivo || [],
    idiomas: payload.idiomas_contenido || [],
    web: seedUrl || null,
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      competitors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            website: { type: ["string", "null"] },
            instagram: { type: ["string", "null"], description: "handle sin @" },
            reason: { type: ["string", "null"] },
          },
          required: ["name", "website", "instagram", "reason"],
        },
      },
      monitor_keywords: { type: "array", items: { type: "string" } },
    },
    required: ["competitors", "monitor_keywords"],
  };

  const { content } = await chatCompletion({
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "competitive_intel", strict: true, schema } },
    max_tokens: 1200,
  });
  return JSON.parse(content);
}

export async function discoverAndSeedCompetitors(organizationId, brandContainerId, payload, seedUrl = null) {
  if (!organizationId || !brandContainerId || !payload) return { seeded: false, reason: "missing args" };

  // Nombre de la marca
  const { data: org } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();

  let intel;
  try { intel = await discoverCompetitors({ name: org?.name, payload, seedUrl }); }
  catch (e) { return { seeded: false, reason: `llm: ${e.message}` }; }

  const competitors = Array.isArray(intel?.competitors) ? intel.competitors : [];
  let entities = 0, watchers = 0;

  for (const c of competitors) {
    if (!c?.name) continue;
    const site = normalizeUrl(c.website);
    if (!site) continue; // sin URL real verificable → no se siembra (evita errores y basura)
    const ig = (c.instagram || "").replace(/^@/, "").trim() || null;
    const targetIdentifier = ig || hostnameOf(site) || c.name;
    const domain = ig ? "social" : "web";

    const { data: ent, error: entErr } = await supabase
      .from("intelligence_entities")
      .insert({
        brand_container_id: brandContainerId,
        organization_id: organizationId,
        name: c.name,
        domain,
        target_identifier: targetIdentifier,
        is_active: true,
        scope: "brand",
        metadata: { website: site, instagram: ig, reason: c.reason || null, discovered_by: "auto-builder", kind: "competitor" },
      })
      .select("id").single();
    if (entErr) { console.warn(`[competitors] entity ${c.name}:`, entErr.message); continue; }
    entities++;

    if (site) {
      const { error: wErr } = await supabase.from("url_watchers").insert({
        url: site, label: c.name, entity_id: ent.id,
        brand_container_id: brandContainerId, organization_id: organizationId,
        is_active: true, last_hash: "",
      });
      if (!wErr) watchers++;
    }
  }

  // Vigilar tambien el sitio propio
  const ownUrl = normalizeUrl(seedUrl);
  if (ownUrl) {
    const { error: ownErr } = await supabase.from("url_watchers").insert({
      url: ownUrl, label: `${org?.name || "Marca"} (propio)`,
      brand_container_id: brandContainerId, organization_id: organizationId,
      is_active: true, last_hash: "",
    });
    if (!ownErr) watchers++;
  }

  // Fusionar palabras a monitorear en el container (dedup)
  const monitorKw = Array.isArray(intel?.monitor_keywords) ? intel.monitor_keywords.filter(Boolean) : [];
  if (monitorKw.length) {
    const { data: bc } = await supabase.from("brand_containers").select("palabras_clave").eq("id", brandContainerId).maybeSingle();
    const merged = [...new Set([...(bc?.palabras_clave || []), ...monitorKw])].slice(0, 25);
    await supabase.from("brand_containers").update({ palabras_clave: merged }).eq("id", brandContainerId);
  }

  return { seeded: true, competitors: entities, watchers, keywords: monitorKw.length };
}
