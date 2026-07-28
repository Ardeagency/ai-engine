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

  // La fila viva se identifica por estar INCOMPLETA, no por session_id: cada
  // llamada a la tool trae su propio id, asi que atarse a el insertaba una fila
  // nueva por tarjeta. Incompleta = le faltan tipos obligatorios; esa se
  // actualiza. Completa = esta terminada, y una tarjeta nueva abre corrida.
  const { data: ultimas } = await supabase
    .from("vera_dashboard_readings")
    .select("id, reading")
    .eq("brand_container_id", brandContainerId)
    .eq("scope", MIMARCA_SCOPE)
    .eq("periodo", periodo.k)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(1);
  const ultima = ultimas?.[0] || null;
  const tiposUltima = ultima?.reading?.cards?.map((c) => c?.type) || [];
  const ultimaIncompleta = ultima && !REQUIRED_TYPES.every((t) => tiposUltima.includes(t));
  const viva = ultimaIncompleta ? ultima : null;

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

  // La tarjeta se ve YA, sin esperar a las seis.
  await _refrescarLecturaViva({
    organizationId, brandContainerId, periodo,
    cards: borradores.map((b) => b.card), sessionId, trigger: "vera_autonoma",
  });

  if (faltan.length) {
    return {
      ok: true, publicado: false, visible: true, periodo: periodo.k, guardada: valida.type,
      presentes, faltan,
      siguiente: `Guardada y YA VISIBLE en el tablero. Faltan ${faltan.length}: ${faltan.join(", ")}.`,
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

  // Completo: se refresca la MISMA fila viva con el conjunto ya validado. No se
  // inserta otra — la lectura lleva visible desde la primera tarjeta.
  await _refrescarLecturaViva({
    organizationId, brandContainerId, periodo,
    cards: full.data.cards, sessionId, trigger: "vera_autonoma",
  });
  const { windowStart, windowEnd } = await ventanaPeriodo(brandContainerId, periodo);

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

/**
 * Que falta en cada periodo — para que Vera sepa por donde seguir.
 *
 * Mira los borradores Y lo ya PUBLICADO. Sin lo segundo hay bucle de retrabajo:
 * al publicar se borran los borradores del periodo, asi que un periodo terminado
 * volvia como "faltan las 6" y Vera lo rehacia entero. Paso en la primera
 * corrida real (2026-07-28): week se publico 04:24:21 y a las 04:34:06 estaba
 * escribiendola otra vez.
 */
export async function estadoBorradores(brandContainerId) {
  const [{ data: borradores }, { data: publicadas }] = await Promise.all([
    supabase
      .from("vera_mimarca_card_drafts")
      .select("periodo, card_type")
      .eq("brand_container_id", brandContainerId),
    supabase
      .from("vera_dashboard_readings")
      .select("periodo, created_at, reading")
      .eq("brand_container_id", brandContainerId)
      .eq("scope", MIMARCA_SCOPE)
      .eq("status", "published"),
  ]);

  const porPeriodo = {};
  for (const p of MIMARCA_PERIODOS) {
    const enTablero = (publicadas || []).find((r) => r.periodo === p.k);
    // Con guardado incremental "publicado" ya no significa "terminado": la
    // lectura esta visible desde la primera tarjeta. Terminado = tiene las seis.
    const tiposEnTablero = enTablero?.reading?.cards?.map((c) => c?.type) || [];
    const completaEnTablero = REQUIRED_TYPES.every((t) => tiposEnTablero.includes(t));
    const yaPublicado = completaEnTablero ? enTablero : null;
    if (yaPublicado) {
      // Se da la ANTIGUEDAD, no un veredicto. Una lectura de hace media hora
      // esta terminada; una de ayer esta vieja, y quien decide si eso merece
      // rehacerse es Vera, no esta tool. Decir "no rehacer" a secas la dejaba
      // sin tocar lecturas de la corrida anterior.
      const horas = (Date.now() - new Date(yaPublicado.created_at)) / 3600000;
      porPeriodo[p.k] = {
        publicado: true,
        publicado_en: yaPublicado.created_at,
        antiguedad_horas: Math.round(horas * 10) / 10,
        presentes: REQUIRED_TYPES,
        faltan: [],
        nota: horas < 2
          ? "recien publicado en esta corrida — no lo rehagas"
          : `publicado hace ${Math.round(horas)}h — decide tu si sigue vigente o toca refrescarlo`,
      };
      continue;
    }
    const enBorrador = (borradores || []).filter((d) => d.periodo === p.k).map((d) => d.card_type);
    // Si hay lectura viva pero incompleta, sus tipos tambien cuentan: lo que ya
    // esta en el tablero no hay que volver a escribirlo.
    const presentes = [...new Set([...enBorrador, ...tiposEnTablero])];
    porPeriodo[p.k] = {
      publicado: false,
      visible_parcial: presentes.length > 0,
      presentes,
      faltan: REQUIRED_TYPES.filter((t) => !presentes.includes(t)),
    };
  }
  return porPeriodo;
}
