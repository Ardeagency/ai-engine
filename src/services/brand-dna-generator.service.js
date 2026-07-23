/**
 * Brand DNA Generator — genera el manifiesto narrativo de identidad de una marca
 * usando OpenAI gpt-4o y lo persiste en brand_dna_generations.
 *
 * El DNA es texto en primera persona plural escrito como voz en off — denso,
 * filosofico, en el tono de la marca. Se inyecta despues a Vera via
 * context.builder.js en cada request (Fase 5).
 *
 * Triggers soportados: 'manual' (POST /internal/generate-brand-dna),
 * 'auto' y 'recurring' (futuro).
 */
import { supabase } from "../lib/supabase.js";
import { syncOrgUserMd } from "../lib/org-workspace-sync.js";
import { chatCompletion } from "../lib/openai.js";

const MODEL                = "gpt-4o";
const MAX_OUTPUT_TOKENS    = 4096;
const TEMPERATURE          = 0.75;
const TOP_PRODUCTS         = 5;
const TOP_SERVICES         = 5;

const SYSTEM_PROMPT = `Eres un estratega de marca y escritor de manifiestos. Tu trabajo es escribir el archivo de identidad profunda de una marca para que una IA de contenido (VERA) lo use como su contexto permanente sobre esta marca.

El archivo debe:
- Estar en primera persona plural ("somos", "creemos", "hablamos") como si la marca misma hablara
- Capturar quien es la marca en su esencia, no en sus features
- Describir como piensa, como habla, que la mueve, que jamas haria
- Describir a quien le habla y como esa persona piensa y siente
- Ser denso y filosofico — cada linea debe tener peso real
- Maximo 120 lineas. Sin secciones decorativas. Sin bullets genericos.
- Formato: markdown limpio con ## para 4-5 secciones maximo

No describas features. No hagas listas de atributos.
Escribe como Terrence Malick haria una voz en off sobre una marca.

El archivo termina con una seccion ## Lo que nunca hariamos con 5-8 lineas de restricciones absolutas de la marca — cosas que jamas diria, jamas haria, jamas toleraria. Esta seccion es tan importante como las demas.`;

async function fetchBrandSnapshot(brandContainerId, organizationId) {
  const { data: brand, error: brandErr } = await supabase
    .from("brand_containers")
    .select("id, nombre_marca, nicho_core, arquetipo, propuesta_valor, mision_vision, verbal_dna, visual_dna, creative_brief, palabras_clave, palabras_prohibidas, objetivos_estrategicos")
    .eq("id", brandContainerId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (brandErr) throw new Error(`Supabase brand_containers: ${brandErr.message}`);
  if (!brand)   throw new Error(`brand_container ${brandContainerId} no existe o no pertenece a la org`);

  const { data: personas, error: personasErr } = await supabase
    .from("audience_personas")
    .select("name, description, awareness_level, dolores, deseos, objeciones, gatillos_compra, estilo_lenguaje")
    .eq("brand_container_id", brandContainerId)
    .order("created_at", { ascending: true });

  if (personasErr) throw new Error(`Supabase audience_personas: ${personasErr.message}`);

  const { data: products, error: productsErr } = await supabase
    .from("products")
    .select("nombre_producto, descripcion_producto, beneficios_principales, diferenciadores")
    .eq("brand_container_id", brandContainerId)
    .order("created_at", { ascending: false })
    .limit(TOP_PRODUCTS);

  if (productsErr) throw new Error(`Supabase products: ${productsErr.message}`);

  const { data: services, error: servicesErr } = await supabase
    .from("services")
    .select("nombre_servicio, descripcion_servicio, beneficios_principales, diferenciadores")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(TOP_SERVICES);

  if (servicesErr) throw new Error(`Supabase services: ${servicesErr.message}`);

  return {
    brand,
    personas: personas ?? [],
    products: products ?? [],
    services: services ?? [],
  };
}

function buildUserPrompt(snapshot) {
  return [
    "Datos de la marca para que escribas su manifiesto de identidad:",
    "",
    "\`\`\`json",
    JSON.stringify(snapshot, null, 2),
    "\`\`\`",
    "",
    "Escribe el archivo siguiendo las reglas del system prompt. Empieza directamente con el primer ## — sin titulo H1, sin preambulo, sin meta-comentario.",
  ].join("\n");
}

/**
 * Genera el DNA narrativo de una marca y lo persiste.
 *
 * @param {object} args
 * @param {string} args.organizationId
 * @param {string} args.brandContainerId
 * @param {'manual'|'auto'|'recurring'} [args.trigger='manual']
 * @param {string|null} [args.userId=null]
 * @returns {Promise<{id, dna_text, lines_count, chars_count, model_used, generated_at, usage}>}
 */
export async function generateBrandDna({ organizationId, brandContainerId, trigger = "manual", userId = null }) {
  if (!organizationId)   throw new Error("organizationId es requerido");
  if (!brandContainerId) throw new Error("brandContainerId es requerido");

  const snapshot = await fetchBrandSnapshot(brandContainerId, organizationId);

  const userPrompt = buildUserPrompt(snapshot);
  const { content, usage, model } = await chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
  });

  const dnaText = (content || "").trim();
  if (!dnaText) throw new Error("OpenAI devolvio un DNA vacio");

  const linesCount = dnaText.split("\n").length;
  const charsCount = dnaText.length;

  const { data: row, error: insertErr } = await supabase
    .from("brand_dna_generations")
    .insert({
      brand_container_id: brandContainerId,
      organization_id:    organizationId,
      model_used:         model,
      lines_count:        linesCount,
      chars_count:        charsCount,
      trigger,
      dna_text:           dnaText,
      input_snapshot:     snapshot,
      usage,
      created_by:         userId,
    })
    .select("id, generated_at")
    .single();

  if (insertErr) throw new Error(`Supabase insert brand_dna_generations: ${insertErr.message}`);

  // El manifiesto ES el USER.md de la org: se incrusta en el workspace del
  // org-server para que OpenClaw lo inyecte en cada sesion. Fail-open: si el
  // servidor esta apagado, se horneara en el proximo provision/wake.
  try {
    const synced = await syncOrgUserMd(organizationId, dnaText);
    if (!synced.ok) console.log(`brand-dna: USER.md no sincronizado (${synced.skipped || synced.error}) — se horneara en provision`);
  } catch (e) {
    console.warn(`brand-dna: syncOrgUserMd fallo: ${e.message}`);
  }

  return {
    id:           row.id,
    generated_at: row.generated_at,
    dna_text:     dnaText,
    lines_count:  linesCount,
    chars_count:  charsCount,
    model_used:   model,
    usage,
  };
}
