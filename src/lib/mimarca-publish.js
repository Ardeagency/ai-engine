/**
 * mimarca-publish.js — ventana, acumulacion y publicacion de las cards de Mi Marca.
 *
 * POR QUE EXISTE: hasta hoy el UNICO escritor de `vera_dashboard_readings` era
 * ai-engine, sosteniendo una conversacion de 30 rondas por HTTP para sacar el
 * sobre [[DIAGNOSIS]] del texto de Vera. De esa topologia invertida salieron los
 * timeouts, los bucles y las sesiones de 45 minutos sin publicar nada.
 *
 * Aqui vive lo que necesitan las tools de Mi Marca para que sea VERA quien
 * escriba: ella se programa sus propios trabajos aislados (`openclaw cron --at
 * --session isolated --light-context`) y cada uno deposita SU card.
 *
 * NINGUNA CARD ES OBLIGATORIA (2026-07-29). Antes seis lo eran y el periodo no
 * se publicaba sin ellas: para cambiar una habia que reescribir las seis, y la
 * septima —`audiencia`, la de mapa y piramide— al no contar para "lo que falta"
 * no se escribia NUNCA; desaparecio del tablero el 27 de julio con la demografia
 * real de la marca delante. Ahora el tablero muestra lo ultimo que se le inserto
 * a cada molde, no se oculta nada por no haberse actualizado, y Vera decide que
 * merece otra pasada.
 *
 * ai-engine deja de ser el cerebro y vuelve a ser el medio.
 */
import { supabase } from "./supabase.js";
import {
  MIMARCA_SCHEMA,
  MIMARCA_SCHEMA_VERSION,
  cardSchema,
  MIMARCA_CARD_TYPES,
  MIMARCA_ITEM_CARDS,
  mimarcaCardsSchema,
} from "./vera-mimarca-cards.schema.js";

export const MIMARCA_SCOPE = "mi_marca";
export const MIMARCA_PERIODO_DEFAULT = "month";

export const MIMARCA_PERIODOS = [
  { k: "week",  dias: 7,    label: "SEMANA — los últimos 7 días" },
  { k: "month", dias: 30,   label: "MES — los últimos 30 días" },
  { k: "year",  dias: 365,  label: "AÑO — los últimos 365 días" },
  { k: "all",   dias: null, label: "TODO — sin recorte de ventana (el patrón que aguantó el tiempo, NO la crónica de la cuenta)" },
];

export function periodoPorClave(k) {
  return MIMARCA_PERIODOS.find((p) => p.k === String(k || "").toLowerCase()) || null;
}

/**
 * Ventana real del periodo. Se ancla al ULTIMO post propio, no a hoy: si la
 * marca lleva dos semanas sin publicar, "los ultimos 7 dias" contra hoy no
 * contienen nada y la lectura saldria vacia. Replica lo que hace el frontend
 * (BrandGrid._gridRango) para que el analisis y el tablero miren lo mismo.
 */
export async function ventanaPeriodo(brandContainerId, periodo) {
  // Rango explicito (el filtro personalizado): manda tal cual, sin anclar. Lo
  // eligio un humano — mover sus fechas seria analizar otra cosa.
  if (periodo.windowStart || periodo.windowEnd) {
    return {
      windowStart: periodo.windowStart || null,
      windowEnd: periodo.windowEnd || new Date().toISOString(),
    };
  }
  const ahora = new Date();
  let ancla = ahora;
  try {
    const { data } = await supabase
      .from("brand_posts")
      .select("captured_at")
      .eq("brand_container_id", brandContainerId)
      .eq("post_source", "own")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ultimo = data?.captured_at ? new Date(data.captured_at) : null;
    if (ultimo && ultimo < ahora) ancla = ultimo;
  } catch (_) { /* sin post propio: se ancla a hoy */ }

  return {
    windowEnd: ancla.toISOString(),
    windowStart: periodo.dias == null
      ? null
      : new Date(ancla.getTime() - periodo.dias * 86400000).toISOString(),
  };
}

/**
 * Publica la lectura COMPLETA de un periodo. El supersede es POR PERIODO:
 * publicar Semana no puede tumbar Año. Las lecturas viejas sin periodo
 * (periodo IS NULL) solo caen cuando se publica el periodo por defecto del tab,
 * que es el que aquellas estaban ocupando de hecho.
 */
export async function publicarLecturaPeriodo({
  organizationId, brandContainerId, periodo, cards, sessionId,
  trigger = "vera_autonoma", toolCallsCount = null, model = null,
}) {
  const { windowStart, windowEnd } = await ventanaPeriodo(brandContainerId, periodo);

  let q = supabase.from("vera_dashboard_readings")
    .update({ status: "superseded" })
    .eq("brand_container_id", brandContainerId)
    .eq("scope", MIMARCA_SCOPE)
    .in("status", ["published", "stale"]);
  q = periodo.k === MIMARCA_PERIODO_DEFAULT
    ? q.or(`periodo.eq.${periodo.k},periodo.is.null`)
    : q.eq("periodo", periodo.k);
  await q;

  const { error } = await supabase.from("vera_dashboard_readings").insert({
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    scope: MIMARCA_SCOPE,
    periodo: periodo.k,
    status: "published",
    schema_version: MIMARCA_SCHEMA_VERSION,
    reading: cards,
    session_id: sessionId,
    tool_calls_count: toolCallsCount,
    model: model || process.env.VERA_DASH_MODEL_LABEL || "openclaw-org-server",
    window_start: windowStart,
    window_end: windowEnd,
    trigger_kind: trigger,
  });
  if (error) throw new Error(`publicar ${periodo.k}: ${error.message}`);
  return { windowStart, windowEnd };
}

/**
 * Escribe (o refresca) la LECTURA VIVA del periodo con lo que haya hasta ahora.
 *
 * Una sola fila por corrida y periodo: la primera tarjeta reemplaza la lectura
 * anterior e inserta; las siguientes actualizan ESA fila. Asi el cliente ve el
 * tablero llenarse en vivo en vez de esperar a la sexta.
 */
async function _refrescarLecturaViva({
  organizationId, brandContainerId, periodo, cards, sessionId, trigger,
}) {
  const lectura = { schema: MIMARCA_SCHEMA, cards };

  // La fila viva se elige por VENTANA, no por session_id ni por estar incompleta.
  //
  // Por session_id insertaba una fila por tarjeta (cada llamada trae su propio id).
  // Por incompletitud arreglaba eso pero rompia lo incremental: sobre un conjunto
  // ya completo, refrescar UNA tarjeta abria una corrida nueva y obligaba a
  // reescribir las seis. Ahora, mientras la ventana del periodo sea la misma, se
  // actualiza ESA fila: cambiar una tarjeta deja las otras cinco intactas.
  // Solo al cambiar la ventana (otra semana, otro mes) la anterior cede el sitio
  // y queda como historia — que es cuando la historia significa algo.
  const { windowStart: winIni } = await ventanaPeriodo(brandContainerId, periodo);
  const { data: ultimas } = await supabase
    .from("vera_dashboard_readings")
    .select("id, reading, window_start")
    .eq("brand_container_id", brandContainerId)
    .eq("scope", MIMARCA_SCOPE)
    .eq("periodo", periodo.k)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(1);
  const ultima = ultimas?.[0] || null;
  const mismaVentana = ultima && String(ultima.window_start) === String(winIni);
  const viva = mismaVentana ? ultima : null;

  if (viva?.id) {
    const { error } = await supabase
      .from("vera_dashboard_readings")
      .update({ reading: lectura })
      .eq("id", viva.id);
    if (error) throw new Error(`refrescar ${periodo.k}: ${error.message}`);
    return { creada: false };
  }

  // Primera tarjeta de esta corrida: la lectura anterior de ESTE periodo cede el
  // sitio. El supersede es por periodo — publicar Semana no puede tumbar Año.
  let q = supabase.from("vera_dashboard_readings")
    .update({ status: "superseded" })
    .eq("brand_container_id", brandContainerId)
    .eq("scope", MIMARCA_SCOPE)
    .in("status", ["published", "stale"]);
  q = periodo.k === MIMARCA_PERIODO_DEFAULT
    ? q.or(`periodo.eq.${periodo.k},periodo.is.null`)
    : q.eq("periodo", periodo.k);
  await q;

  const { windowStart, windowEnd } = await ventanaPeriodo(brandContainerId, periodo);
  const { error } = await supabase.from("vera_dashboard_readings").insert({
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    scope: MIMARCA_SCOPE,
    periodo: periodo.k,
    status: "published",
    schema_version: MIMARCA_SCHEMA_VERSION,
    reading: lectura,
    session_id: sessionId,
    model: process.env.VERA_DASH_MODEL_LABEL || "openclaw-org-server",
    window_start: windowStart,
    window_end: windowEnd,
    trigger_kind: trigger,
  });
  if (error) throw new Error(`abrir lectura viva ${periodo.k}: ${error.message}`);
  return { creada: true };
}

/**
 * Deposita UNA card en el periodo. La lectura se refresca SIEMPRE: no hay
 * conjunto minimo que esperar, una card basta para que el periodo exista y se
 * vea. Devuelve el estado del tablero — ese retorno es el lazo con el que Vera
 * decide su siguiente paso sin que nadie se lo dicte.
 */
export async function depositarCard({
  organizationId, brandContainerId, periodoKey, card, sessionId,
}) {
  const periodo = periodoPorClave(periodoKey);
  if (!periodo) {
    throw new Error(
      `periodo '${periodoKey}' no existe. Validos: ${MIMARCA_PERIODOS.map((p) => p.k).join(", ")}`
    );
  }

  // Se valida la card SUELTA en la puerta: una mala se rechaza aqui, con su
  // motivo, y no contamina el borrador ni tumba a las demas.
  const v = cardSchema.safeParse(card);
  if (!v.success) {
    const errores = v.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`);
    return { ok: false, motivo: "la card no cumple el contrato cards.v2", errores };
  }
  const valida = v.data;

  const { error: errUp } = await supabase
    .from("vera_mimarca_card_drafts")
    .upsert({
      organization_id: organizationId,
      brand_container_id: brandContainerId,
      periodo: periodo.k,
      card_type: valida.type,
      card: valida,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "brand_container_id,periodo,card_type" });
  if (errUp) throw new Error(`guardar borrador: ${errUp.message}`);

  const { data: borradores, error: errSel } = await supabase
    .from("vera_mimarca_card_drafts")
    .select("card_type, card, updated_at")
    .eq("brand_container_id", brandContainerId)
    .eq("periodo", periodo.k)
    .order("created_at", { ascending: true });
  if (errSel) throw new Error(`leer borradores: ${errSel.message}`);

  const presentes = borradores.map((b) => b.card_type);

  /* Cada card viaja con la hora en que Vera la escribio.
     Va SELLADA aqui y no en el contrato que ella llena: la lectura cambia por
     partes —cinco cards de ayer y una de hace un minuto conviven en la misma
     fila—, asi que la fecha de la FILA no dice cuando se escribio cada una. Y
     no es un campo suyo a proposito: es un hecho del sistema, no un juicio; si
     estuviera en su esquema podria declarar una hora que no ocurrio.
     Se sella DESPUES de validar por lo mismo que .strict() existe. */
  const selloPorTipo = new Map(borradores.map((b) => [b.card_type, b.updated_at]));
  const sellar = (cards) => (cards || []).map((c) => (
    selloPorTipo.has(c && c.type) ? { ...c, updated_at: selloPorTipo.get(c.type) } : c
  ));

  // La tarjeta se ve YA. Una sola basta: no hay conjunto que esperar.
  await _refrescarLecturaViva({
    organizationId, brandContainerId, periodo,
    cards: sellar(borradores.map((b) => b.card)), sessionId, trigger: "vera_autonoma",
  });
  const { windowStart, windowEnd } = await ventanaPeriodo(brandContainerId, periodo);

  // Los borradores NO se borran: son el contenido VIGENTE del tablero. Borrarlos
  // hacia que la sesion siguiente abriera con "faltan las 6" y Vera reescribiera
  // seis analisis caros para cambiar, quiza, uno solo.

  const sinEscribir = MIMARCA_CARD_TYPES.filter((t) => !presentes.includes(t));
  return {
    ok: true, visible: true, periodo: periodo.k, guardada: valida.type,
    en_el_tablero: presentes,
    sin_escribir: sinEscribir,
    windowStart, windowEnd,
    siguiente: `Guardada y VISIBLE en '${periodo.k}'. El tablero tiene ${presentes.length} tarjeta(s); ` +
      (sinEscribir.length
        ? `nunca se ha escrito: ${sinEscribir.join(", ")} — ninguna es obligatoria, escribe la que aporte.`
        : "los siete moldes tienen contenido.") +
      " Lo que no toques se queda como esta.",
  };
}

/**
 * Anade o quita items de una card que es LISTA (observaciones, audiencias
 * recomendadas) sin rehacerla.
 *
 * POR QUE: reescribir seis observaciones para corregir una es caro y ademas
 * borra las cinco que seguian siendo ciertas. Vera lee lo que hay y decide por
 * item: esta ya no aplica (fuera), esto es nuevo (dentro), el resto se queda
 * intacto — con su texto original, no con una parafrasis.
 *
 * El resultado se valida como card ENTERA antes de guardar: los limites de la
 * lista (minimo 2, maximo 6/8) son del molde, no del item, y quitar de mas
 * dejaria el tablero con una card invalida.
 */
export async function mutarItemsCard({
  organizationId, brandContainerId, periodoKey, cardType, agregar, eliminar, sessionId,
}) {
  const periodo = periodoPorClave(periodoKey);
  if (!periodo) {
    throw new Error(
      `periodo '${periodoKey}' no existe. Validos: ${MIMARCA_PERIODOS.map((p) => p.k).join(", ")}`
    );
  }
  const molde = MIMARCA_ITEM_CARDS[cardType];
  if (!molde) {
    return {
      ok: false,
      motivo: `'${cardType}' no es una card de lista`,
      detalle: `Se editan por item: ${Object.keys(MIMARCA_ITEM_CARDS).join(", ")}. ` +
        "Las demas son un texto entero: para cambiarlas, publishMiMarcaCard.",
    };
  }

  const { data: fila, error: errSel } = await supabase
    .from("vera_mimarca_card_drafts")
    .select("card")
    .eq("brand_container_id", brandContainerId)
    .eq("periodo", periodo.k)
    .eq("card_type", cardType)
    .maybeSingle();
  if (errSel) throw new Error(`leer la card: ${errSel.message}`);
  if (!fila?.card) {
    return {
      ok: false,
      motivo: `'${cardType}' todavia no existe en '${periodo.k}'`,
      detalle: "No hay nada que editar: creala entera la primera vez con publishMiMarcaCard.",
    };
  }

  const actuales = Array.isArray(fila.card.items) ? fila.card.items : [];
  const clave = molde.clave;
  const idDe = (it) => String((it && it[clave]) || "").trim().toLowerCase();

  // Quitar primero: si en la misma llamada se quita uno y se anade otro con la
  // misma clave, gana el nuevo (es una sustitucion, no un duplicado).
  const fuera = new Set((eliminar || []).map((x) => String(x || "").trim().toLowerCase()));
  const noEncontrados = [...fuera].filter((x) => !actuales.some((it) => idDe(it) === x));
  const items = actuales.filter((it) => !fuera.has(idDe(it)));
  const quitados = actuales.length - items.length;
  let reemplazados = 0;

  const nuevos = [];
  for (const bruto of (agregar || [])) {
    const v = molde.itemSchema.safeParse(bruto);
    if (!v.success) {
      return {
        ok: false,
        motivo: "un item nuevo no cumple el contrato",
        errores: v.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
        detalle: "No se guardo nada: la card sigue como estaba.",
      };
    }
    nuevos.push(v.data);
  }
  // Un item nuevo con la clave de uno que ya estaba lo REEMPLAZA en su sitio:
  // asi se corrige una observacion sin que aparezca dos veces.
  for (const n of nuevos) {
    const i = items.findIndex((it) => idDe(it) === idDe(n));
    if (i >= 0) { items[i] = n; reemplazados++; } else items.push(n);
  }

  const cardNueva = { ...fila.card, items };
  const v = cardSchema.safeParse(cardNueva);
  if (!v.success) {
    return {
      ok: false,
      motivo: `la card quedaria invalida (${items.length} items; el molde admite ${molde.min}-${molde.max})`,
      errores: v.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
      detalle: "No se guardo nada: la card sigue como estaba.",
    };
  }

  const { error: errUp } = await supabase
    .from("vera_mimarca_card_drafts")
    .upsert({
      organization_id: organizationId,
      brand_container_id: brandContainerId,
      periodo: periodo.k,
      card_type: cardType,
      card: v.data,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "brand_container_id,periodo,card_type" });
  if (errUp) throw new Error(`guardar la card: ${errUp.message}`);

  const { data: borradores } = await supabase
    .from("vera_mimarca_card_drafts")
    .select("card_type, card, updated_at")
    .eq("brand_container_id", brandContainerId)
    .eq("periodo", periodo.k)
    .order("created_at", { ascending: true });
  const sello = new Map((borradores || []).map((b) => [b.card_type, b.updated_at]));
  await _refrescarLecturaViva({
    organizationId, brandContainerId, periodo,
    cards: (borradores || []).map((b) => ({ ...b.card, updated_at: sello.get(b.card_type) })),
    sessionId, trigger: "vera_autonoma",
  });

  return {
    ok: true,
    periodo: periodo.k,
    card: cardType,
    quitados,
    anadidos: nuevos.length - reemplazados,
    reemplazados,
    no_encontrados: noEncontrados,
    items_ahora: items.map((it) => it[clave]),
    siguiente: `'${cardType}' de '${periodo.k}' quedo con ${items.length} items y ya se ve en el tablero.` +
      (noEncontrados.length ? ` No estaban y no se quitaron: ${noEncontrados.join(", ")}.` : ""),
  };
}

/**
 * QUE HAY en cada periodo — no que falta.
 *
 * El cambio de pregunta es el cambio de doctrina: ninguna card es obligatoria,
 * asi que "faltan cuatro" era una orden disfrazada de dato. Lo que Vera necesita
 * para decidir es lo que YA esta puesto, de cuando es, y —en las cards que son
 * lista— QUE items contiene, para poder quitar uno y anadir otro en vez de
 * reescribir las seis observaciones cada vez que despierta.
 *
 * Mira los borradores Y lo ya publicado: lo que esta en el tablero sin borrador
 * (lecturas viejas del productor anterior) existe igual y se lista sin edad.
 */
export async function estadoBorradores(brandContainerId) {
  const [{ data: borradores }, { data: publicadas }] = await Promise.all([
    supabase
      .from("vera_mimarca_card_drafts")
      .select("periodo, card_type, updated_at, card")
      .eq("brand_container_id", brandContainerId),
    supabase
      .from("vera_dashboard_readings")
      .select("periodo, created_at, reading")
      .eq("brand_container_id", brandContainerId)
      .eq("scope", MIMARCA_SCOPE)
      .eq("status", "published"),
  ]);

  const ahora = Date.now();
  const edadH = (t) => Math.round(((ahora - new Date(t).getTime()) / 3600000) * 10) / 10;

  const porPeriodo = {};
  for (const p of MIMARCA_PERIODOS) {
    const mias = (borradores || []).filter((d) => d.periodo === p.k);
    const enTablero = (publicadas || []).find((r) => r.periodo === p.k);
    const tiposEnTablero = enTablero?.reading?.cards?.map((c) => c?.type) || [];

    // Las tarjetas guardadas son el contenido VIGENTE del tablero, cada una con
    // su edad. Lo que esta en el tablero pero ya no tiene borrador se lista
    // igual, sin edad: existe, pero no se sabe de cuando.
    const tarjetas = mias
      .map((d) => {
        const molde = MIMARCA_ITEM_CARDS[d.card_type];
        const items = molde && Array.isArray(d.card?.items)
          // Solo la CLAVE de cada item, no su texto: con esto Vera decide a cual
          // quitar sin arrastrar la card entera a su contexto en cada latido.
          ? d.card.items.map((it) => it && it[molde.clave]).filter(Boolean)
          : null;
        return {
          tipo: d.card_type,
          edad_horas: edadH(d.updated_at),
          ...(items ? { items, se_edita_por_item: true } : {}),
        };
      })
      .sort((a, b) => b.edad_horas - a.edad_horas);
    for (const t of tiposEnTablero) {
      if (!tarjetas.some((x) => x.tipo === t)) tarjetas.push({ tipo: t, edad_horas: null });
    }

    const presentes = tarjetas.map((t) => t.tipo);
    const sinEscribir = MIMARCA_CARD_TYPES.filter((t) => !presentes.includes(t));
    const conEdad = tarjetas.filter((t) => t.edad_horas != null);
    const masVieja = conEdad.length ? conEdad[0] : null;

    porPeriodo[p.k] = {
      visible_en_tablero: tiposEnTablero.length > 0,
      tarjetas,
      sin_escribir: sinEscribir,
      mas_vieja: masVieja,
      nota: [
        tarjetas.length
          ? `hay ${tarjetas.length} tarjeta(s) puestas` +
            (masVieja ? `; la mas vieja es '${masVieja.tipo}' (${masVieja.edad_horas}h)` : "")
          : "este periodo no tiene ni una tarjeta todavia",
        sinEscribir.length ? `nunca escritas: ${sinEscribir.join(", ")}` : null,
        "NINGUNA es obligatoria. Lo que no toques se queda tal cual, y el tablero lo sigue mostrando.",
        "Lo que envejece en dias para 'week' puede aguantar semanas en 'year'.",
      ].filter(Boolean).join(". "),
    };
  }

  return porPeriodo;
}
