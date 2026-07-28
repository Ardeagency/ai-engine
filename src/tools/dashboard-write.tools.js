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
  if (!brandContainerId) throw new Error("brandContainerId es requerido.");
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
    brandContainerId,
    periodoKey: periodo,
    card,
    sessionId: sessionId || crypto.randomUUID(),
  });
}

/**
 * Que cards hay y cuales faltan, periodo por periodo. Sirve para retomar
 * despues de un fallo sin repetir trabajo ya hecho.
 */
export async function getMiMarcaProgress({ brandContainerId }) {
  if (!brandContainerId) throw new Error("brandContainerId es requerido.");
  const porPeriodo = await estadoBorradores(brandContainerId);
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
