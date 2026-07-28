/**
 * Dashboard Write Tools — Vera escribe SU tablero.
 *
 * Hasta hoy ninguna tool tocaba `vera_dashboard_readings`: ai-engine era el
 * unico escritor y por eso tenia que sostener una conversacion de 30 rondas por
 * HTTP, sacar el sobre [[DIAGNOSIS]] del texto y persistirlo. Esa topologia
 * invertida —ai-engine de cerebro, Vera de generador de texto— es de donde
 * salieron los timeouts, los bucles y las sesiones de 45 min sin publicar nada.
 *
 * Con estas tools Vera se orquesta sola: investiga una vez, se programa un
 * trabajo aislado por card (`openclaw cron --at +Ns --session isolated
 * --light-context --delete-after-run`), y cada trabajo deposita SU card. Cuando
 * estan las seis obligatorias, el periodo se publica solo.
 *
 * Herramientas:
 *   publishMiMarcaCard   — deposita UNA card; publica el periodo al completarse
 *   getMiMarcaProgress   — que cards faltan en cada periodo
 */
import {
  depositarCard,
  estadoBorradores,
  MIMARCA_PERIODOS,
} from "../lib/mimarca-publish.js";
import { REQUIRED_TYPES } from "../lib/vera-mimarca-cards.schema.js";
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

/**
 * El contenedor de marca sobre el que trabaja este par de tools.
 *
 * POR QUE EXISTE: el dispatcher solo inyecta `brandContainerId` cuando la
 * llamada viene de una CONVERSACION que ya lo trae. Cuando Vera despierta sola
 * —su latido, un cron— no hay conversacion, y estas dos tools morian con
 * "brandContainerId es requerido". Su propio guion del latido (HEARTBEAT.md) le
 * manda empezar por `getMiMarcaProgress`: el paso 2 de su rutina autonoma fallaba
 * SIEMPRE, en las dos VMs, y el error culpaba a quien llamaba. Verificado en vivo
 * el 2026-07-28 en WAKEUP e IGNIS.
 *
 * POR QUE NO RESUELVE A CIEGAS: `resolveBrandContainer` cae a "la marca mas
 * antigua" cuando no le dan id, y depositar la card de una marca en el tablero de
 * otra es peor que no depositarla. Asi que solo se auto-resuelve cuando la
 * organizacion tiene UNA marca y no hay ambiguedad posible. Con varias, se le
 * devuelve la lista para que elija — un error que dice como salir de el.
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
    .from("brand_containers")
    .select("id, nombre_marca")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(`No se pudo resolver la marca: ${error.message}`);
  if (!data?.length) throw new Error("Esta organizacion no tiene ninguna marca creada.");
  if (data.length === 1) return data[0].id;
  throw new Error(
    "Esta organizacion tiene varias marcas: pasa brandContainerId explicito. " +
    data.map((b) => `${b.nombre_marca}=${b.id}`).join(" | ")
  );
}

/**
 * Deposita UNA card de Mi Marca en el periodo indicado.
 *
 * Devuelve SIEMPRE lo que falta: ese retorno es el lazo con el que Vera decide
 * su siguiente paso sin que nadie se lo dicte.
 *
 * @param {object} p
 * @param {string} p.organizationId
 * @param {string} p.brandContainerId
 * @param {string} p.periodo  week | month | year | all
 * @param {object} p.card     una card cards.v2 (type + su forma)
 * @param {string} [p.sessionId]
 */
export async function publishMiMarcaCard({
  organizationId, brandContainerId, periodo, card, sessionId,
}) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  if (!periodo) {
    throw new Error(
      `El campo 'periodo' es requerido. Validos: ${MIMARCA_PERIODOS.map((x) => x.k).join(", ")}`
    );
  }
  if (!card || typeof card !== "object") {
    throw new Error("El campo 'card' es requerido y debe ser el objeto de UNA card cards.v2.");
  }
  if (Array.isArray(card)) {
    throw new Error(
      "'card' es UNA sola card, no un array. Llama a publishMiMarcaCard una vez por card — " +
      "asi una mala no tumba a las demas."
    );
  }
  if (!card.type) {
    throw new Error(
      `La card no trae 'type'. Obligatorias: ${REQUIRED_TYPES.join(", ")}.`
    );
  }

  return depositarCard({
    organizationId,
    brandContainerId: contenedor,
    periodoKey: periodo,
    card,
    sessionId: sessionId || crypto.randomUUID(),
  });
}

/**
 * Que cards hay y cuales faltan, periodo por periodo. Sirve para retomar
 * despues de un fallo sin repetir trabajo ya hecho.
 */
export async function getMiMarcaProgress({ brandContainerId, organizationId }) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  const porPeriodo = await estadoBorradores(contenedor);
  // La card `audiencia` es OPCIONAL y por eso nunca salia en "faltan": mi propio
  // lazo se la escondia. Vera la omitio en WAKEUP (2026-07-28) teniendo delante
  // 230.635 seguidores con reparto por edad, genero, pais y ciudad. Ahora la
  // tool dice que se puede hacer; si vale la pena o no, lo juzga ella.
  const opcional = {
    tipo: "audiencia",
    cuando: "solo si hay demografia REAL (getMetaAudienceDemographics u otra fuente); inventada es peor que ausente",
    nota: "no cuenta para completar el periodo, pero si tienes los datos el tablero la pinta",
  };

  const listos = Object.entries(porPeriodo)
    .filter(([, v]) => v.publicado)
    .map(([k, v]) => `${k} (hace ${v.antiguedad_horas}h)`);
  const pendientes = Object.entries(porPeriodo)
    .filter(([, v]) => !v.publicado)
    .map(([k, v]) => `${k}: faltan ${v.faltan.join(", ")}`);
  return {
    obligatorias: REQUIRED_TYPES,
    opcional,
    periodos: porPeriodo,
    publicados: listos,
    resumen: [
      listos.length ? `YA PUBLICADOS: ${listos.join(", ")} — los recientes no se rehacen; los viejos los juzgas tu` : null,
      pendientes.length ? `PENDIENTES — ${pendientes.join(" | ")}` : "no queda nada pendiente",
    ].filter(Boolean).join(" || "),
  };
}
