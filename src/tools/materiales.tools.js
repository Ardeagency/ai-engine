/**
 * materiales.tools.js — ai-engine entrega el MATERIAL; el juicio es de Vera.
 *
 * QUE REEMPLAZA: dos tools que llamaban a gpt-4o con VISION desde ai-engine para
 * juzgar en su lugar —`getDistinctiveAssetsAudit` (blink test de codigos
 * distintivos) y `getPackagingAnalysis` (empaque como activo)— y dos que
 * encapsulaban un juicio en codigo: `getAuthorityClusterPlan` y
 * `scoreContentCitability`.
 *
 * POR QUE SE FUERON: Vera YA tiene esa doctrina como skills —
 * `the-codes-that-make-me-recognizable`, `brand-fidelity-check`,
 * `how-machines-recommend-me`. La teniamos escrita DOS VECES: una como skill que
 * ella lee y otra como codigo que decidia por ella. Y la version en codigo no
 * puede mirar la pieza, no puede pedir mas datos y no aprende.
 *
 * LO QUE SI ES NUESTRO y por eso estas tools existen: saber QUE activos tiene la
 * marca definidos, QUE piezas produjo y DONDE estan sus imagenes. Eso vive en
 * nuestra base y OpenClaw no lo alcanza.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

/**
 * Los codigos distintivos declarados + una muestra de piezas reales para mirar.
 *
 * Antes esto llamaba a gpt-4o con vision y devolvia un veredicto de consistencia.
 * Ahora devuelve el material y el encargo: el blink test lo hace ella, que ademas
 * puede pedir mas piezas si la muestra no le alcanza.
 */
export async function getMaterialDeCodigos({ brandContainerId, organizationId, maxPiezas = 12 }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const tope = Math.max(1, Math.min(Number(maxPiezas) || 12, 24));

  const [{ data: colores }, { data: tipografias }, { data: reglas }, { data: piezas }] = await Promise.all([
    supabase.from("brand_colors").select("color_role, hex_value").eq("organization_id", bc.organization_id || organizationId),
    supabase.from("brand_fonts").select("font_family, font_usage").eq("organization_id", bc.organization_id || organizationId),
    supabase.from("brand_rules").select("rule_type, rule_value").eq("brand_container_id", bc.id),
    supabase.from("runs_outputs")
      .select("id, storage_path, reference_image_url, created_at, output_type")
      .eq("brand_container_id", bc.id).not("storage_path", "is", null)
      .order("created_at", { ascending: false }).limit(tope),
  ]);

  const muestra = (piezas || []).map((p) => ({
    id: p.id, tipo: p.output_type, creada: p.created_at, media: p.storage_path,
  }));

  return {
    codigos_declarados: {
      colores: colores || [],
      tipografias: tipografias || [],
      reglas: reglas || [],
      sin_declarar: !(colores?.length || tipografias?.length || reglas?.length),
    },
    piezas: muestra,
    sin_piezas: muestra.length === 0,
    encargo: muestra.length
      ? "MIRA las piezas de la lista y haz el blink test tu misma: tapando el nombre, " +
        "¿se reconoce la marca? ¿Que codigo declarado aparece de verdad y cual solo esta " +
        "en el papel? Si la muestra no te alcanza, pide mas con maxPiezas."
      : "No hay piezas producidas con imagen para mirar. Dilo como hueco — no juzgues " +
        "la consistencia de unos codigos que nadie ha aplicado todavia.",
  };
}

/**
 * El material del empaque: productos, sus imagenes y las ocasiones de la categoria.
 *
 * Antes esto mandaba las imagenes a un modelo de vision desde ai-engine. Ahora
 * las entrega.
 */
export async function getMaterialDeEmpaque({ brandContainerId, organizationId, maxImagenes = 12 }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const tope = Math.max(1, Math.min(Number(maxImagenes) || 12, 24));

  const { data: productos } = await supabase
    .from("products")
    .select("id, nombre_producto, descripcion_producto, tipo_producto, caracteristicas_visuales")
    .eq("brand_container_id", bc.id).limit(40);

  const ids = (productos || []).map((p) => p.id);
  const { data: imagenes } = ids.length
    ? await supabase.from("product_images")
        .select("product_id, image_url, image_type, image_order")
        .in("product_id", ids).order("image_order").limit(tope)
    : { data: [] };

  const porProducto = (productos || []).map((p) => ({
    id: p.id,
    nombre: p.nombre_producto,
    tipo: p.tipo_producto,
    descripcion: p.descripcion_producto,
    rasgos_visuales: p.caracteristicas_visuales || null,
    imagenes: (imagenes || []).filter((i) => i.product_id === p.id).map((i) => ({ url: i.image_url, tipo: i.image_type })),
  })).filter((p) => p.imagenes.length);

  return {
    productos: porProducto,
    sin_imagenes: porProducto.length === 0,
    total_productos: (productos || []).length,
    encargo: porProducto.length
      ? "MIRA las imagenes de empaque y juzgalas tu: ¿el empaque comunica la ocasion de " +
        "consumo? ¿Se distingue en un anaquel lleno? ¿Que promete el frente y que cumple? " +
        "Cruza con las ocasiones de compra si te sirven."
      : "Hay " + ((productos || []).length) + " productos pero ninguno con imagen guardada. " +
        "Es hueco de datos, no un empaque malo — dilo asi.",
  };
}
