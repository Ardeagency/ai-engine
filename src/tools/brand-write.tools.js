/**
 * Brand Write Tools — herramientas de escritura para datos de marca.
 *
 * Disponibles en fase B (parcial) y C (total).
 * Todas las operaciones son org-scoped y nunca exponen tokens.
 *
 * Herramientas:
 *   updateBrandProfile     — actualiza tono, estilo, keywords, objetivos
 *   updateBrandContainer   — actualiza nombre de marca, mercado, idiomas
 *   upsertAudience         — crea o actualiza una audiencia
 *   deleteAudience         — elimina una audiencia (requiere confirmación)
 *   upsertProduct          — crea o actualiza un producto/servicio
 *   deleteProduct          — elimina un producto (requiere confirmación)
 *   upsertBrandColor       — crea o actualiza un color de marca
 *   deleteBrandColor       — elimina un color de marca
 *   upsertBrandFont        — crea o actualiza una tipografía de marca
 *   upsertBrandRule        — crea o actualiza una regla de comunicación
 *   deleteBrandRule        — elimina una regla de comunicación
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";
import { proposeAction } from "../services/pending-action.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pick(obj, keys) {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined && obj[k] !== null).map((k) => [k, obj[k]])
  );
}

function requireField(value, name) {
  if (!value || (typeof value === "string" && !value.trim())) {
    throw new Error(`El campo '${name}' es requerido.`);
  }
}

// ── Perfil de marca ────────────────────────────────────────────────────────────

/**
 * Actualiza el perfil de marca: tono, estilo, keywords, objetivos, arquetipo.
 * Si la marca no existe aún, la crea (upsert).
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.nicho_mercado]
 * @param {string} [params.arquetipo_personalidad]
 * @param {string} [params.tono_comunicacion]         — e.g. "profesional", "cercano", "inspirador"
 * @param {string} [params.estilo_escritura]           — e.g. "directo", "narrativo", "técnico"
 * @param {string[]} [params.palabras_clave]           — keywords de marca
 * @param {string[]} [params.palabras_prohibidas]      — palabras a evitar
 * @param {string} [params.objetivos_marca]
 * @param {string} [params.enfoque_marca]
 */
export async function updateBrandProfile({ organizationId, ...fields }) {
  const bc = await resolveBrandContainer(null, organizationId);

  // Mapping de fields legacy del prompt -> columnas reales de brand_containers
  // (tono_comunicacion/estilo_escritura se fusionan en verbal_dna jsonb)
  const updates = {};
  if (fields.nicho_mercado !== undefined)         updates.nicho_core = fields.nicho_mercado;
  if (fields.arquetipo_personalidad !== undefined) updates.arquetipo = fields.arquetipo_personalidad;
  if (fields.palabras_clave !== undefined)        updates.palabras_clave = fields.palabras_clave;
  if (fields.palabras_prohibidas !== undefined)   updates.palabras_prohibidas = fields.palabras_prohibidas;
  if (fields.objetivos_marca !== undefined)       updates.objetivos_estrategicos = fields.objetivos_marca;
  if (fields.enfoque_marca !== undefined)         updates.propuesta_valor = fields.enfoque_marca;

  // verbal_dna jsonb merge — solo si llegan tono_comunicacion o estilo_escritura
  const verbalPatch = {};
  if (fields.tono_comunicacion !== undefined) verbalPatch.tono = fields.tono_comunicacion;
  if (fields.estilo_escritura !== undefined)  verbalPatch.estilo = fields.estilo_escritura;
  if (Object.keys(verbalPatch).length) {
    const { data: cur } = await supabase
      .from("brand_containers")
      .select("verbal_dna")
      .eq("id", bc.id)
      .maybeSingle();
    updates.verbal_dna = { ...(cur?.verbal_dna || {}), ...verbalPatch };
  }

  if (!Object.keys(updates).length) {
    throw new Error("Debes especificar al menos un campo (tono_comunicacion, estilo_escritura, palabras_clave, arquetipo_personalidad, nicho_mercado, objetivos_marca, enfoque_marca, palabras_prohibidas).");
  }

  const { error } = await supabase
    .from("brand_containers")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", bc.id);
  if (error) throw error;

  return { success: true, action: "updated", brand_container_id: bc.id, fields_updated: Object.keys(updates) };
}

/**
 * Actualiza el brand container (nombre de marca, mercado objetivo, idiomas).
 */
export async function updateBrandContainer({ organizationId, nombre_marca, mercado_objetivo, idiomas_contenido }) {
  const bc = await resolveBrandContainer(null, organizationId);

  const updates = pick({ nombre_marca, mercado_objetivo, idiomas_contenido }, ["nombre_marca", "mercado_objetivo", "idiomas_contenido"]);

  if (!Object.keys(updates).length) {
    throw new Error("Debes especificar al menos un campo: nombre_marca, mercado_objetivo o idiomas_contenido.");
  }

  const { error } = await supabase
    .from("brand_containers")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", bc.id);
  if (error) throw error;

  return { success: true, brand_container_id: bc.id, fields_updated: Object.keys(updates) };
}

// ── Audiencias ─────────────────────────────────────────────────────────────────

/**
 * Crea o actualiza una audiencia.
 * Si se pasa audience_id se actualiza; si no, se crea nueva.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.audience_id]      — UUID de audiencia existente para actualizar
 * @param {string} params.name               — nombre de la audiencia
 * @param {string} [params.description]
 * @param {string} [params.awareness_level]  — "unaware"|"problem_aware"|"solution_aware"|"product_aware"|"most_aware"
 * @param {string[]} [params.dolores]        — pain points
 * @param {string[]} [params.deseos]         — desires
 * @param {string} [params.estilo_lenguaje]  — cómo le habla la marca a esta audiencia
 */
export async function upsertAudience({
  organizationId,
  audience_id,
  vera_reasoning,
  vera_confidence,
  source_signal_id,
  source_job_id,
  ...fields
}) {
  // Resolver brand_container y validar que pertenece a la org
  const bc = await resolveBrandContainer(null, organizationId);
  if (!bc?.id) throw new Error("No hay brand_container configurado para esta organización.");

  requireField(fields.name, "name");

  // Campos permitidos alineados con el schema actual de audiences
  const allowedFields = [
    "name", "description", "awareness_level",
    "datos_demograficos", "datos_psicograficos",
    "dolores", "deseos", "objeciones",
    "gatillos_compra", "estilo_lenguaje",
  ];
  const data = pick(fields, allowedFields);

  // Si update: cargar current_state para diff before/after
  let currentState = null;
  if (audience_id) {
    const { data: existing } = await supabase
      .from("audience_personas")
      .select("*")
      .eq("id", audience_id)
      .eq("brand_container_id", bc.id)
      .maybeSingle();
    if (!existing) {
      throw new Error(`Audiencia ${audience_id} no encontrada para esta marca.`);
    }
    currentState = existing;
  }

  // Proponer la acción (no escribe directo: usuario debe aprobar, o autonomy=total auto-ejecuta)
  return await proposeAction({
    organizationId,
    brandContainerId: bc.id,
    actionType:    audience_id ? "update_audience" : "create_audience",
    targetTable:   "audience_personas",
    targetId:      audience_id || null,
    proposedPayload: data,
    currentState,
    veraReasoning:  vera_reasoning,
    veraConfidence: vera_confidence,
    sourceSignalId: source_signal_id,
    sourceJobId:    source_job_id,
  });
}

/**
 * Elimina una audiencia por ID.
 */
export async function deleteAudience({ organizationId, audience_id }) {
  requireField(audience_id, "audience_id");
  const bc = await resolveBrandContainer(null, organizationId);

  const { data: existing } = await supabase
    .from("audience_personas")
    .select("id, name")
    .eq("id", audience_id)
    .eq("brand_container_id", bc.id)
    .maybeSingle();
  if (!existing) throw new Error(`Audiencia ${audience_id} no encontrada para esta marca.`);

  const { error } = await supabase.from("audience_personas").delete().eq("id", audience_id);
  if (error) throw error;
  return { success: true, action: "deleted", audience_id, name: existing.name };
}

// ── Productos ──────────────────────────────────────────────────────────────────

/**
 * Crea o actualiza un producto/servicio.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.product_id]              — UUID del producto existente para actualizar
 * @param {string} params.nombre_producto
 * @param {string} [params.descripcion_producto]
 * @param {number} [params.precio_producto]
 * @param {string} [params.moneda]                  — "USD", "COP", "EUR", etc.
 * @param {string[]} [params.beneficios_principales]
 * @param {string[]} [params.diferenciadores]
 * @param {string[]} [params.casos_de_uso]
 */
export async function upsertProduct({ organizationId, product_id, ...fields }) {
  const bc = await resolveBrandContainer(null, organizationId);

  const allowedFields = [
    "nombre_producto", "descripcion_producto", "precio_producto",
    "moneda", "beneficios_principales", "diferenciadores", "casos_de_uso",
  ];
  const data = pick(fields, allowedFields);

  if (product_id) {
    const { data: existing } = await supabase
      .from("products").select("id").eq("id", product_id).eq("brand_container_id", bc.id).maybeSingle();
    if (!existing) throw new Error(`Producto ${product_id} no encontrado para esta marca.`);

    const { error } = await supabase
      .from("products")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", product_id);
    if (error) throw error;
    return { success: true, action: "updated", product_id, fields_updated: Object.keys(data) };
  } else {
    requireField(fields.nombre_producto, "nombre_producto");
    const { data: created, error } = await supabase
      .from("products")
      .insert({ brand_container_id: bc.id, ...data })
      .select("id")
      .single();
    if (error) throw error;
    return { success: true, action: "created", product_id: created.id, nombre: fields.nombre_producto };
  }
}

/**
 * Elimina un producto por ID.
 */
export async function deleteProduct({ organizationId, product_id }) {
  requireField(product_id, "product_id");
  const bc = await resolveBrandContainer(null, organizationId);

  const { data: existing } = await supabase
    .from("products").select("id, nombre_producto").eq("id", product_id).eq("brand_container_id", bc.id).maybeSingle();
  if (!existing) throw new Error(`Producto ${product_id} no encontrado para esta marca.`);

  const { error } = await supabase.from("products").delete().eq("id", product_id);
  if (error) throw error;
  return { success: true, action: "deleted", product_id, nombre: existing.nombre_producto };
}

// ── Colores de marca ───────────────────────────────────────────────────────────

/**
 * Crea o actualiza un color de marca.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.color_id]     — UUID del color existente para actualizar
 * @param {string} params.nombre         — e.g. "Primario", "Secundario", "Acento"
 * @param {string} params.hex            — e.g. "#FF5733"
 * @param {string} [params.uso]          — descripción de uso del color
 */
export async function upsertBrandColor({ organizationId, color_id, nombre, hex, uso }) {
  const bc = await resolveBrandContainer(null, organizationId);
  requireField(nombre, "nombre");
  requireField(hex, "hex");

  // Validar formato hex básico
  if (!/^#[0-9A-Fa-f]{3,8}$/.test(hex)) {
    throw new Error(`El color '${hex}' no tiene formato hexadecimal válido (ej: #FF5733).`);
  }

  const data = pick({ nombre, hex, uso }, ["nombre", "hex", "uso"]);

  if (color_id) {
    const { data: existing } = await supabase
      .from("brand_colors").select("id").eq("id", color_id).eq("brand_container_id", bc.id).maybeSingle();
    if (!existing) throw new Error(`Color ${color_id} no encontrado.`);

    const { error } = await supabase.from("brand_colors").update(data).eq("id", color_id);
    if (error) throw error;
    return { success: true, action: "updated", color_id, nombre, hex };
  } else {
    const { data: created, error } = await supabase
      .from("brand_colors")
      .insert({ brand_container_id: bc.id, ...data })
      .select("id").single();
    if (error) throw error;
    return { success: true, action: "created", color_id: created.id, nombre, hex };
  }
}

/**
 * Elimina un color de marca.
 */
export async function deleteBrandColor({ organizationId, color_id }) {
  requireField(color_id, "color_id");
  const bc = await resolveBrandContainer(null, organizationId);

  const { data: existing } = await supabase
    .from("brand_colors").select("id, nombre, hex").eq("id", color_id).eq("brand_container_id", bc.id).maybeSingle();
  if (!existing) throw new Error(`Color ${color_id} no encontrado.`);

  const { error } = await supabase.from("brand_colors").delete().eq("id", color_id);
  if (error) throw error;
  return { success: true, action: "deleted", color_id, nombre: existing.nombre, hex: existing.hex };
}

// ── Tipografías ────────────────────────────────────────────────────────────────

/**
 * Crea o actualiza una tipografía de marca.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.font_id]      — UUID de tipografía existente para actualizar
 * @param {string} params.nombre         — nombre de la fuente (e.g. "Montserrat")
 * @param {string} [params.tipo]         — "principal"|"secundaria"|"acento"
 * @param {string} [params.uso]          — descripción de uso
 */
export async function upsertBrandFont({ organizationId, font_id, nombre, tipo, uso }) {
  const bc = await resolveBrandContainer(null, organizationId);
  requireField(nombre, "nombre");

  const data = pick({ nombre, tipo, uso }, ["nombre", "tipo", "uso"]);

  if (font_id) {
    const { data: existing } = await supabase
      .from("brand_fonts").select("id").eq("id", font_id).eq("brand_container_id", bc.id).maybeSingle();
    if (!existing) throw new Error(`Tipografía ${font_id} no encontrada.`);

    const { error } = await supabase.from("brand_fonts").update(data).eq("id", font_id);
    if (error) throw error;
    return { success: true, action: "updated", font_id, nombre };
  } else {
    const { data: created, error } = await supabase
      .from("brand_fonts")
      .insert({ brand_container_id: bc.id, ...data })
      .select("id").single();
    if (error) throw error;
    return { success: true, action: "created", font_id: created.id, nombre };
  }
}

// ── Reglas de comunicación ─────────────────────────────────────────────────────

/**
 * Crea o actualiza una regla de comunicación de marca.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} [params.rule_id]      — UUID de la regla existente para actualizar
 * @param {string} params.titulo         — e.g. "Nunca usar jerga"
 * @param {string} [params.descripcion]  — explicación de la regla
 * @param {string} [params.categoria]    — "tono"|"estilo"|"formato"|"contenido"|"general"
 */
export async function upsertBrandRule({ organizationId, rule_id, titulo, descripcion, categoria }) {
  const bc = await resolveBrandContainer(null, organizationId);
  requireField(titulo, "titulo");

  const data = pick({ titulo, descripcion, categoria }, ["titulo", "descripcion", "categoria"]);

  if (rule_id) {
    const { data: existing } = await supabase
      .from("brand_rules").select("id").eq("id", rule_id).eq("brand_container_id", bc.id).maybeSingle();
    if (!existing) throw new Error(`Regla ${rule_id} no encontrada.`);

    const { error } = await supabase.from("brand_rules").update(data).eq("id", rule_id);
    if (error) throw error;
    return { success: true, action: "updated", rule_id, titulo };
  } else {
    const { data: created, error } = await supabase
      .from("brand_rules")
      .insert({ brand_container_id: bc.id, ...data })
      .select("id").single();
    if (error) throw error;
    return { success: true, action: "created", rule_id: created.id, titulo };
  }
}

/**
 * Elimina una regla de comunicación.
 */
export async function deleteBrandRule({ organizationId, rule_id }) {
  requireField(rule_id, "rule_id");
  const bc = await resolveBrandContainer(null, organizationId);

  const { data: existing } = await supabase
    .from("brand_rules").select("id, titulo").eq("id", rule_id).eq("brand_container_id", bc.id).maybeSingle();
  if (!existing) throw new Error(`Regla ${rule_id} no encontrada.`);

  const { error } = await supabase.from("brand_rules").delete().eq("id", rule_id);
  if (error) throw error;
  return { success: true, action: "deleted", rule_id, titulo: existing.titulo };
}
