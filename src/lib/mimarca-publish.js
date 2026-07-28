/**
 * mimarca-publish.js — ventana, acumulacion y publicacion de las cards de Mi Marca.
 *
 * POR QUE EXISTE: hasta hoy el UNICO escritor de `vera_dashboard_readings` era
 * ai-engine, sosteniendo una conversacion de 30 rondas por HTTP para sacar el
 * sobre [[DIAGNOSIS]] del texto de Vera. De esa topologia invertida salieron los
 * timeouts, los bucles y las sesiones de 45 minutos sin publicar nada.
 *
 * Aqui vive lo que necesita la tool `publishMiMarcaCard` para que sea VERA quien
 * escriba: ella se programa sus propios trabajos aislados (`openclaw cron --at
 * --session isolated --light-context`) y cada uno deposita SU card. Cuando estan
 * las seis obligatorias, la lectura se publica sola.
 *
 * ai-engine deja de ser el cerebro y vuelve a ser el medio.
 */
import { supabase } from "./supabase.js";
import {
  MIMARCA_SCHEMA,
  MIMARCA_SCHEMA_VERSION,
  cardSchema,
  REQUIRED_TYPES,
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
 * Deposita UNA card en el borrador del periodo y publica en cuanto estan las
 * seis obligatorias. Devuelve SIEMPRE que falta: ese retorno es el lazo de
 * realimentacion con el que Vera se orquesta a si misma.
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
    .select("card_type, card")
    .eq("brand_container_id", brandContainerId)
    .eq("periodo", periodo.k)
    .order("created_at", { ascending: true });
  if (errSel) throw new Error(`leer borradores: ${errSel.message}`);

  const presentes = borradores.map((b) => b.card_type);
  const faltan = REQUIRED_TYPES.filter((t) => !presentes.includes(t));

  if (faltan.length) {
    return {
      ok: true, publicado: false, periodo: periodo.k, guardada: valida.type,
      presentes, faltan,
      siguiente: `Faltan ${faltan.length}: ${faltan.join(", ")}. Entrega cada una con publishMiMarcaCard.`,
    };
  }

  // Estan las seis: se valida el conjunto antes de publicar, porque el contrato
  // completo pide cosas que una card suelta no puede saber (minimo 6, maximo 12).
  const lectura = { schema: MIMARCA_SCHEMA, cards: borradores.map((b) => b.card) };
  const full = mimarcaCardsSchema.safeParse(lectura);
  if (!full.success) {
    return {
      ok: true, publicado: false, periodo: periodo.k, guardada: valida.type, presentes, faltan: [],
      motivo: "estan las seis pero el conjunto no valida",
      errores: full.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
    };
  }

  const { windowStart, windowEnd } = await publicarLecturaPeriodo({
    organizationId, brandContainerId, periodo, cards: full.data, sessionId,
  });

  await supabase
    .from("vera_mimarca_card_drafts")
    .delete()
    .eq("brand_container_id", brandContainerId)
    .eq("periodo", periodo.k);

  return {
    ok: true, publicado: true, periodo: periodo.k, guardada: valida.type,
    cards: full.data.cards.length, windowStart, windowEnd,
    siguiente: `Periodo ${periodo.k} PUBLICADO y visible en el tablero.`,
  };
}

/** Que falta en cada periodo — para que Vera sepa por donde seguir. */
export async function estadoBorradores(brandContainerId) {
  const { data } = await supabase
    .from("vera_mimarca_card_drafts")
    .select("periodo, card_type")
    .eq("brand_container_id", brandContainerId);
  const porPeriodo = {};
  for (const p of MIMARCA_PERIODOS) {
    const presentes = (data || []).filter((d) => d.periodo === p.k).map((d) => d.card_type);
    porPeriodo[p.k] = {
      presentes,
      faltan: REQUIRED_TYPES.filter((t) => !presentes.includes(t)),
    };
  }
  return porPeriodo;
}
