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
 * --light-context --delete-after-run`), y cada trabajo deposita SU card.
 *
 * NINGUNA CARD ES OBLIGATORIA (2026-07-29): el tablero muestra lo ultimo que se
 * le inserto a cada molde y nada se oculta por no haberse actualizado. Ella lee
 * que hay y decide que merece otra pasada.
 *
 * Herramientas:
 *   publishMiMarcaCard        — deposita UNA card entera (crea o reemplaza)
 *   updateMiMarcaCardItems    — anade/quita items de una card que es LISTA
 *   getMiMarcaProgress        — que hay en cada periodo, de cuando, y con que items
 */
import {
  depositarCard,
  mutarItemsCard,
  estadoBorradores,
  MIMARCA_PERIODOS,
} from "../lib/mimarca-publish.js";
import { MIMARCA_CARD_TYPES, MIMARCA_ITEM_CARDS } from "../lib/vera-mimarca-cards.schema.js";
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
      `La card no trae 'type'. Los moldes del tablero son: ${MIMARCA_CARD_TYPES.join(", ")}. ` +
      "Ninguno es obligatorio: escribe el que aporte."
    );
  }
  // Rehacer entera una card que es lista borra items que seguian siendo ciertos.
  // No se prohibe —a veces se quiere empezar de cero— pero se dice.
  const esLista = Boolean(MIMARCA_ITEM_CARDS[card.type]);

  const r = await depositarCard({
    organizationId,
    brandContainerId: contenedor,
    periodoKey: periodo,
    card,
    sessionId: sessionId || crypto.randomUUID(),
  });
  if (r.ok && esLista) {
    r.aviso = `Acabas de REEMPLAZAR '${card.type}' entera. Es una card de lista: ` +
      "para corregir o sumar sin borrar lo que sigue siendo cierto, usa updateMiMarcaCardItems.";
  }
  return r;
}

/**
 * Anade o quita items de una card que es LISTA (observaciones, audiencias
 * recomendadas) sin rehacerla.
 *
 * @param {object} p
 * @param {string} p.periodo   week | month | year | all
 * @param {string} p.cardType  observacion | audiencias_recomendadas
 * @param {object[]} [p.agregar]  items nuevos (o corregidos: misma clave = reemplaza)
 * @param {string[]} [p.eliminar] claves a quitar (titulo en observacion, id en audiencias)
 */
export async function updateMiMarcaCardItems({
  organizationId, brandContainerId, periodo, cardType, agregar, eliminar, sessionId,
}) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  if (!periodo) {
    throw new Error(
      `El campo 'periodo' es requerido. Validos: ${MIMARCA_PERIODOS.map((x) => x.k).join(", ")}`
    );
  }
  if (!cardType) {
    throw new Error(
      `El campo 'cardType' es requerido. Se editan por item: ${Object.keys(MIMARCA_ITEM_CARDS).join(", ")}.`
    );
  }
  const nada = !(agregar || []).length && !(eliminar || []).length;
  if (nada) {
    throw new Error(
      "Llamada vacia: pasa 'agregar' (items nuevos), 'eliminar' (claves a quitar), o ambos. " +
      "Si no hay nada que cambiar, no llames — dejarla como esta es una decision valida."
    );
  }
  if (!Array.isArray(agregar || []) || !Array.isArray(eliminar || [])) {
    throw new Error("'agregar' y 'eliminar' son arrays.");
  }

  return mutarItemsCard({
    organizationId,
    brandContainerId: contenedor,
    periodoKey: periodo,
    cardType,
    agregar: agregar || [],
    eliminar: eliminar || [],
    sessionId: sessionId || crypto.randomUUID(),
  });
}

/**
 * QUE HAY en el tablero, periodo por periodo: cada tarjeta con su edad, y las de
 * lista con las claves de sus items.
 *
 * Antes esta tool respondia "que falta" contra una lista de obligatorias, y su
 * resumen leia campos que `estadoBorradores` ya no devolvia (`publicado`,
 * `antiguedad_horas`): 'YA PUBLICADOS' salia siempre vacio y todo periodo se
 * anunciaba pendiente. Vera decidia sobre un resumen falso.
 */
export async function getMiMarcaProgress({ brandContainerId, organizationId }) {
  const contenedor = await _contenedor(brandContainerId, organizationId);
  const porPeriodo = await estadoBorradores(contenedor);

  const conCards = Object.entries(porPeriodo)
    .filter(([, v]) => v.tarjetas.length)
    .map(([k, v]) => `${k}: ${v.tarjetas.length} tarjeta(s)` +
      (v.mas_vieja ? `, la mas vieja '${v.mas_vieja.tipo}' (${v.mas_vieja.edad_horas}h)` : ""));
  const vacios = Object.entries(porPeriodo)
    .filter(([, v]) => !v.tarjetas.length)
    .map(([k]) => k);

  return {
    moldes: MIMARCA_CARD_TYPES,
    ninguna_obligatoria: true,
    se_editan_por_item: Object.fromEntries(
      Object.entries(MIMARCA_ITEM_CARDS).map(([t, m]) => [t, `clave='${m.clave}', ${m.min}-${m.max} items`])
    ),
    periodos: porPeriodo,
    resumen: [
      conCards.length ? `EN EL TABLERO — ${conCards.join(" | ")}` : "el tablero esta vacio en los cuatro periodos",
      vacios.length ? `SIN NADA todavia: ${vacios.join(", ")}` : null,
      "Ninguna tarjeta es obligatoria y ninguna se oculta: lo que no toques se sigue mostrando tal cual. " +
      "En observacion y audiencias_recomendadas NO rehagas la card: lee sus items y usa " +
      "updateMiMarcaCardItems para quitar lo que ya no aplica y sumar lo nuevo.",
    ].filter(Boolean).join(" || "),
  };
}
