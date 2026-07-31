/**
 * vera4-publish.js — Vera deposita las cards de su CEREBRO en el tablero.
 *
 * QUE ES: el camino de escritura de `cards.vera4` — las 30 tarjetas del Ciclo de
 * Relevancia de VERA_BRAIN_MASTER repartidas en los 4 tabs. Mismo espiritu que
 * mimarca-publish.js: Vera publica, ai-engine solo es el medio.
 *
 * UNA CARD POR LLAMADA, a proposito. Es la leccion que ya se pago dos veces:
 * una entrega monolitica se cae entera por un `rationale` de 161 caracteres. Aqui
 * cada card se valida sola, se guarda sola y se ve sola. Ninguna es obligatoria.
 *
 * DONDE VIVE: `vera_dashboard_readings` con schema_version 4, UNA fila por
 * (marca, scope, periodo). Convive con la lectura de siempre del mismo tab
 * —narrative v1 (sv 1) o cards.v2 (sv 2)— porque desde 2026-07-30 el indice
 * unico y `get_vera_reading` incluyen el schema: cada lector pide el suyo.
 *
 * CONCURRENCIA: Vera escribe card a card desde trabajos aislados, asi que dos
 * depositos pueden solaparse sobre la misma fila y el segundo borraria la card
 * del primero. Por eso el guardado es CONDICIONAL: se relee, se mezcla y se
 * escribe solo si la fila no cambio mientras tanto (`window_end` hace de sello
 * de ultima escritura). Si cambio, se reintenta con lo que hay ahora.
 */
import { supabase } from "./supabase.js";
import {
  validarCardV4, tabsDeCard, cardCabeEn, VERA4_SCHEMA, VERA4_SCHEMA_VERSION,
  VERA4_SCOPES, VERA4_TYPES_POR_SCOPE, NOMBRE_TAB_V4,
} from "./vera4-cards.schema.js";

/** Mi Marca tiene filtro de periodo en pantalla; los otros tres tabs no. */
export const PERIODOS_V4 = ["week", "month", "year", "all"];
export const PERIODO_V4_DEFAULT = "month";

/** Cada cuanto envejece la lectura de cada tab. Override por env. */
const CADUCIDAD_H = {
  mi_marca:   Number(process.env.VERA4_CADUCIDAD_MIMARCA_H || 72),
  monitoreo:  Number(process.env.VERA4_CADUCIDAD_MONITOREO_H || 72),
  tendencias: Number(process.env.VERA4_CADUCIDAD_TENDENCIAS_H || 48),
  estrategia: Number(process.env.VERA4_CADUCIDAD_ESTRATEGIA_H || 48),
};

const REINTENTOS = 4;

function _normalizarPeriodo(scope, periodo) {
  if (scope !== "mi_marca") return null;          // solo Mi Marca reparte por periodo
  const p = String(periodo || PERIODO_V4_DEFAULT).trim().toLowerCase();
  return PERIODOS_V4.includes(p) ? p : PERIODO_V4_DEFAULT;
}

async function _filaViva(brandContainerId, scope, periodo) {
  let q = supabase.from("vera_dashboard_readings")
    .select("id, reading, window_end, created_at")
    .eq("brand_container_id", brandContainerId)
    .eq("scope", scope)
    .eq("schema_version", VERA4_SCHEMA_VERSION)
    .eq("status", "published");
  q = periodo == null ? q.is("periodo", null) : q.eq("periodo", periodo);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`leer lectura vera4: ${error.message}`);
  return (data && data[0]) || null;
}

/**
 * Deposita UNA card. Crea la lectura del tab si no existia, o reemplaza esa
 * card dentro de la que ya hay. El resto de las cards no se toca.
 *
 * Devuelve SIEMPRE un objeto con `ok`: un contrato incumplido no es una
 * excepcion, es una respuesta que Vera puede leer y corregir en el mismo turno.
 */
export async function depositarCardV4({
  organizationId, brandContainerId, scope, periodo, card, sessionId,
}) {
  const sc = String(scope || "").trim().toLowerCase();
  if (!VERA4_SCOPES.includes(sc)) {
    return {
      ok: false,
      motivo: `'${scope}' no es un tab valido`,
      detalle: `Validos: ${VERA4_SCOPES.map((s) => `${s} (${NOMBRE_TAB_V4[s]})`).join(", ")}.`,
    };
  }

  const v = validarCardV4(card);
  if (!v.ok) {
    return {
      ok: false,
      motivo: "la card no cumple el contrato cards.vera4",
      errores: v.errores,
      detalle: "No se guardo nada; el tab sigue mostrando lo que tenia. " +
        `En ${NOMBRE_TAB_V4[sc]} caben: ${VERA4_TYPES_POR_SCOPE[sc].join(", ")}.`,
    };
  }

  // El reparto es contrato: las reglas de los tabs se contradicen entre si (Mi
  // Marca tiene prohibido nombrar competencia), asi que una card en el tab
  // equivocado hace que el tablero diga lo que no debe.
  if (!cardCabeEn(v.card.type, sc)) {
    const susTabs = tabsDeCard(v.card.type);
    // La Intuicion de Mi Marca no se rechaza a secas: se rechaza diciendo por
    // donde entra. Un rechazo que no nombra la salida es un rechazo a medias.
    const desvio = (v.card.type === "intuicion" && sc === "mi_marca")
      ? "La Intuicion de Mi Marca no va por aqui: se publica con publishMiMarcaCard({periodo, card:{type:'intuicion', ...}}), que es contrato cards.v2 y reparte por periodo. "
      : "";
    return {
      ok: false,
      motivo: `'${v.card.type}' no vive en ${NOMBRE_TAB_V4[sc]}`,
      detalle: susTabs.length
        ? `${desvio}Esa card es de ${susTabs.map((t) => `${NOMBRE_TAB_V4[t]} (scope '${t}')`).join(" o ")}. En ${NOMBRE_TAB_V4[sc]} caben: ${VERA4_TYPES_POR_SCOPE[sc].join(", ")}.`
        : `'${v.card.type}' todavia no tiene tablero: habla de ti, no de la marca. No se publica en ninguno de los cuatro.`,
    };
  }

  const per = _normalizarPeriodo(sc, periodo);
  const ahora = new Date().toISOString();
  const cardSellada = { ...v.card, updated_at: ahora };

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    const fila = await _filaViva(brandContainerId, sc, per);

    // Primera card del tab: nace la lectura.
    if (!fila) {
      const { error } = await supabase.from("vera_dashboard_readings").insert({
        organization_id: organizationId,
        brand_container_id: brandContainerId,
        scope: sc,
        periodo: per,
        status: "published",
        schema_version: VERA4_SCHEMA_VERSION,
        reading: { schema: VERA4_SCHEMA, cards: [cardSellada] },
        session_id: sessionId || crypto.randomUUID(),
        model: process.env.VERA_DASH_MODEL_LABEL || "openclaw-org-server",
        window_end: ahora,
        trigger_kind: "vera_autonoma",
      });
      // Otra sesion la creo entre la lectura y el insert: se reintenta y se
      // mezcla en vez de pisar.
      if (error && String(error.code) === "23505") continue;
      if (error) throw new Error(`crear lectura vera4 (${sc}): ${error.message}`);
      return _respuesta(sc, per, [cardSellada], v.card.type, true);
    }

    const previas = Array.isArray(fila.reading?.cards) ? fila.reading.cards : [];
    const eraNueva = !previas.some((c) => c && c.type === v.card.type);
    const cards = previas.filter((c) => c && c.type !== v.card.type).concat([cardSellada]);

    // Escritura CONDICIONAL: solo si nadie toco la fila desde que la lei.
    let upd = supabase.from("vera_dashboard_readings")
      .update({
        reading: { schema: VERA4_SCHEMA, cards },
        window_end: ahora,
        session_id: sessionId || crypto.randomUUID(),
      })
      .eq("id", fila.id);
    upd = fila.window_end == null ? upd.is("window_end", null) : upd.eq("window_end", fila.window_end);
    const { data, error } = await upd.select("id");
    if (error) throw new Error(`guardar card vera4 (${sc}): ${error.message}`);
    if (data && data.length) return _respuesta(sc, per, cards, v.card.type, eraNueva);
    // 0 filas = otra escritura gano la carrera. Se vuelve a leer y a mezclar.
  }

  return {
    ok: false,
    motivo: "no se pudo guardar por escrituras simultaneas",
    detalle: `Se reintento ${REINTENTOS} veces sobre ${NOMBRE_TAB_V4[sc]}. Vuelve a intentarlo en unos segundos; nada se perdio.`,
  };
}

function _respuesta(scope, periodo, cards, tipo, eraNueva) {
  const faltan = VERA4_TYPES_POR_SCOPE[scope].filter((t) => !cards.some((c) => c.type === t));
  return {
    ok: true,
    visible: true,
    tab: NOMBRE_TAB_V4[scope],
    scope,
    periodo,
    card: tipo,
    accion: eraNueva ? "publicada" : "reemplazada",
    en_el_tab: cards.map((c) => c.type),
    siguiente: faltan.length
      ? `'${tipo}' ya se ve en ${NOMBRE_TAB_V4[scope]}. Sin escribir todavia: ${faltan.join(", ")}. Ninguna es obligatoria — escribe la que tengas algo que decir.`
      : `'${tipo}' ya se ve. ${NOMBRE_TAB_V4[scope]} tiene sus ${cards.length} cards escritas.`,
  };
}

/**
 * Que hay escrito en cada tab, de cuando, y QUE VENCIO.
 *
 * Existe por la misma leccion que costo 20 despertares en blanco: quitar la
 * obligacion sin dejar criterio de vejez paraliza. Esto no obliga a nada —
 * dice que esta mirando una ventana que ya paso.
 */
export async function estadoVera4({ brandContainerId }) {
  const { data, error } = await supabase.from("vera_dashboard_readings")
    .select("scope, periodo, reading, window_end, created_at")
    .eq("brand_container_id", brandContainerId)
    .eq("schema_version", VERA4_SCHEMA_VERSION)
    .eq("status", "published");
  if (error) throw new Error(`leer estado vera4: ${error.message}`);

  const edadH = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : null);
  const tabs = {};
  let vencidas = 0, escritas = 0;

  for (const scope of VERA4_SCOPES) {
    const filas = (data || []).filter((r) => r.scope === scope);
    const umbral = CADUCIDAD_H[scope];
    const cards = [];
    for (const f of filas) {
      for (const c of (Array.isArray(f.reading?.cards) ? f.reading.cards : [])) {
        if (!c || !c.type) continue;
        const e = edadH(c.updated_at || f.window_end || f.created_at);
        const vencida = e == null || e > umbral;
        if (vencida) vencidas++;
        escritas++;
        cards.push({
          tipo: c.type,
          periodo: f.periodo,
          edad_horas: e == null ? null : Math.round(e),
          vencida,
        });
      }
    }
    const faltan = VERA4_TYPES_POR_SCOPE[scope].filter((t) => !cards.some((c) => c.tipo === t));
    tabs[scope] = {
      tab: NOMBRE_TAB_V4[scope],
      caduca_a_las_horas: umbral,
      escritas: cards,
      sin_escribir: faltan,
    };
  }

  return {
    schema: VERA4_SCHEMA,
    resumen: {
      escritas,
      vencidas,
      hay_trabajo: vencidas > 0 || escritas === 0,
      // El criterio, dicho en una linea: ni obligacion ni silencio.
      criterio: "Ninguna card es obligatoria. Una VENCIDA esta describiendo una ventana que ya paso: " +
        "releela y reescribela si cambio algo, o dejala si sigue siendo cierta.",
    },
    tabs,
  };
}
