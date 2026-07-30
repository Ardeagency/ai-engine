/**
 * Vera4 Write Tools — Vera escribe las cards de su CEREBRO.
 *
 * QUE SON: las 30 tarjetas del Ciclo de Relevancia (VERA_BRAIN_MASTER, Parte VI)
 * repartidas en los 4 tabs que ya existen. No reemplazan lo que hay: conviven.
 *
 *   getVera4Encargo   — QUE tiene que decir cada card de un tab (doctrina + encargo)
 *   publishVera4Card  — deposita UNA card (crea o reemplaza). Ninguna es obligatoria.
 *   getVera4Progress  — que hay escrito, de cuando, y QUE VENCIO
 *
 * EL ORDEN IMPORTA: primero el encargo, despues investigar, al final publicar.
 * Una card que cumple el schema y no dice nada es peor que no escribirla — el
 * schema fija la FORMA (y viaja declarado en el esquema MCP, no insinuado); el
 * encargo fija el FONDO.
 *
 * POR QUE UNA CARD POR LLAMADA: la leccion ya pagada dos veces en cards.v2 — una
 * entrega monolitica se cae entera por un campo de 161 caracteres. Aqui cada
 * card se valida sola, se guarda sola y se ve sola.
 */
import { depositarCardV4, estadoVera4, PERIODOS_V4, PERIODO_V4_DEFAULT } from "../lib/vera4-publish.js";
import {
  VERA4_SCOPES, VERA4_TYPES_POR_SCOPE, NOMBRE_TAB_V4,
} from "../lib/vera4-cards.schema.js";
import { encargoDeScope } from "../lib/vera4-encargos.js";
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

/**
 * La marca sobre la que se trabaja. Igual que en dashboard-write.tools.js: el
 * dispatcher solo inyecta brandContainerId cuando la llamada viene de una
 * conversacion; cuando Vera despierta sola no hay ninguna, y sin esto su rutina
 * autonoma falla en el primer paso. No resuelve a ciegas: con varias marcas
 * devuelve la lista para que elija.
 */
async function _contenedor(brandContainerId, organizationId) {
  if (brandContainerId) {
    const bc = await resolveBrandContainer(brandContainerId, organizationId);
    return bc.id;
  }
  if (!organizationId) {
    throw new Error("brandContainerId es requerido (y no llego organizationId para resolverlo).");
  }
  const { data, error } = await supabase
    .from("brand_containers").select("id, nombre_marca")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true }).limit(5);
  if (error) throw new Error(`No se pudo resolver la marca: ${error.message}`);
  if (!data?.length) throw new Error("Esta organizacion no tiene ninguna marca creada.");
  if (data.length === 1) return data[0].id;
  throw new Error(
    "Esta organizacion tiene varias marcas: pasa brandContainerId explicito. " +
    data.map((b) => `${b.nombre_marca}=${b.id}`).join(" | ")
  );
}

function _logRechazo(tool, ctx, r) {
  if (!r || r.ok !== false) return;
  const detalle = [r.motivo, ...(r.errores || [])].filter(Boolean).join(" | ");
  console.warn(`${tool}: RECHAZADA ${JSON.stringify(ctx)} — ${String(detalle).slice(0, 300)}`);
}

/**
 * EL ENCARGO de un tab: la doctrina de su etapa del ciclo y, card por card, que
 * VA, que NO VA y la prueba que tiene que pasar.
 *
 * Se pide UNA VEZ antes de escribir. No es un guion: dentro del encargo manda
 * ella — como razona, que mira, a que conclusion llega y con cuanta profundidad.
 */
export async function getVera4Encargo({ scope }) {
  const sc = String(scope || "").trim().toLowerCase();
  if (!VERA4_SCOPES.includes(sc)) {
    return {
      ok: false,
      motivo: `'${scope}' no es un tab valido`,
      detalle: `Validos: ${VERA4_SCOPES.map((s) => `${s} (${NOMBRE_TAB_V4[s]})`).join(", ")}.`,
    };
  }
  const e = encargoDeScope(sc);
  return {
    ok: true,
    tab: NOMBRE_TAB_V4[sc],
    scope: sc,
    doctrina: e.doctrina,
    cards: e.cards,
    como_se_publica: `Una card por llamada con publishVera4Card({scope:'${sc}', card:{type:'...', ...}}). ` +
      (sc === "mi_marca"
        ? `Mi Marca ademas lleva 'periodo' (${PERIODOS_V4.join(" | ")}): el cliente cambia el filtro en pantalla y las cards se repintan. Una lectura que no sabe que ventana describe miente en tres de los cuatro botones.`
        : "Este tab no tiene filtro de periodo."),
    aviso: "Ninguna card es obligatoria. Escribe las que tengas algo real que decir; " +
      "una tarjeta de relleno ocupa el sitio de la unica cosa que nadie mas puede dar: tu juicio.",
  };
}

/**
 * Deposita UNA card en su tab. Crea la lectura si no existia; si esa card ya
 * estaba, la reemplaza y el resto no se toca.
 */
export async function publishVera4Card({
  organizationId, brandContainerId, scope, periodo, card, sessionId,
}) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  if (!scope) {
    throw new Error(
      `El campo 'scope' es requerido. Validos: ${VERA4_SCOPES.map((s) => `${s} (${NOMBRE_TAB_V4[s]})`).join(", ")}.`
    );
  }
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new Error(
      "El campo 'card' es requerido y es UN objeto con su 'type': {type:'pulso_nicho', ...}. " +
      "No es un array de cards ni un texto. Se publica de a una."
    );
  }

  let org = organizationId;
  if (!org) {
    const { data } = await supabase
      .from("brand_containers").select("organization_id").eq("id", contenedor).maybeSingle();
    org = data?.organization_id || null;
  }

  const r = await depositarCardV4({
    organizationId: org,
    brandContainerId: contenedor,
    scope,
    periodo,
    card,
    sessionId: sessionId || crypto.randomUUID(),
  });
  _logRechazo("publishVera4Card", { scope, type: card?.type }, r);
  return r;
}

/**
 * Que cards hay escritas en cada tab, de cuando son y cuales estan mirando una
 * ventana que ya paso. No obliga a nada: da criterio.
 */
export async function getVera4Progress({ organizationId, brandContainerId }) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  const estado = await estadoVera4({ brandContainerId: contenedor });
  return {
    ...estado,
    brandContainerId: contenedor,
    periodo_por_defecto: PERIODO_V4_DEFAULT,
    caben_por_tab: VERA4_TYPES_POR_SCOPE,
    siguiente: estado.resumen.hay_trabajo
      ? "Empieza por getVera4Encargo(scope) del tab que quieras tocar y publica solo lo que de verdad tengas."
      : "Todo lo escrito sigue vigente. Si nada cambio en la marca ni en el mercado, no hay nada que reescribir.",
  };
}
