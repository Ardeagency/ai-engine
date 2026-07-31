/**
 * search-watchlist.service.js — la lista de terminos que VERA decide vigilar.
 *
 * EL PUNTO. La automatizacion siembra de `brand_containers.palabras_clave`: una
 * lista escrita una vez, que no aprende y no sabe lo que paso ayer. Cuando Vera
 * descubre en vivo que un tema encendio a la audiencia de un competidor, o que
 * una palabra se repite en 300 bios, tiene que poder decir "esto lo quiero ver
 * todos los dias". La automatizacion ejecuta; la inteligencia decide QUE.
 *
 * DOS ACTOS DISTINTOS Y NO HAY QUE CONFUNDIRLOS:
 *   explorar  — mirar un termino UNA vez para decidir si vale la pena. Barato,
 *               inmediato, sin compromiso.
 *   vigilar   — dejarlo montado para que se mida solo cada dia. Compromete cuota
 *               TODOS los dias, y por eso la lista tiene tope y exige un motivo.
 *
 * LO ESCASO ES LA CUOTA, NO EL DINERO. SerpApi Free son 250 busquedas al mes
 * para todo el sistema. Vigilar 5 terminos a diario son 150. Por eso el tope de
 * la lista es la unidad de presupuesto real aqui.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ANALYZER = process.env.PYTHON_ANALYZER_URL || "http://127.0.0.1:8001";

// Tope de la lista = presupuesto. 5 terminos x 30 dias = 150 llamadas/mes, y
// quedan ~100 para los colectores del tablero y para explorar.
export const MAX_VIGILADOS = Number(process.env.SEARCH_WATCH_MAX || 5);

const normalizar = (s) => String(s || "").trim().toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

/** Mira un termino en Google Trends UNA vez. No compromete nada. */
export async function explorar({ term, geo = "", conSerie = true }) {
  const q = String(term || "").trim();
  if (!q) throw new Error("falta el termino a explorar");
  const url = `${ANALYZER}/trends/explore?q=${encodeURIComponent(q)}`
    + `&geo=${encodeURIComponent(geo || "")}&con_serie=${conSerie ? "true" : "false"}`;
  const res = await fetch(url, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail || `analyzer ${res.status}`);
  return json;
}

/** Pone un termino bajo vigilancia diaria. */
export async function vigilar({ organizationId, brandContainerId, term, geo = null, reason, origen = null }) {
  const q = String(term || "").trim();
  if (!q) throw new Error("falta el termino");
  if (!brandContainerId) throw new Error("falta brandContainerId");
  // El motivo es obligatorio a proposito: una lista de vigilancia sin por-que se
  // llena de terminos que nadie recuerda haber puesto y nadie se atreve a quitar.
  if (!String(reason || "").trim()) {
    throw new Error("falta `reason`: por que vale la pena vigilar este termino todos los dias");
  }
  // Google Trends no responde a long-tail; avisarlo ANTES de gastar 30 llamadas
  // al mes en algo que va a volver vacio siempre.
  const palabras = q.split(/\s+/).length;

  const { data: activos } = await supabase
    .from("watched_search_terms").select("id, term")
    .eq("brand_container_id", brandContainerId).eq("is_active", true);
  const yaEsta = (activos || []).find((t) => normalizar(t.term) === normalizar(q));
  if (yaEsta) return { ok: true, ya_estaba: true, term: q, vigilados: (activos || []).length };
  if ((activos || []).length >= MAX_VIGILADOS) {
    throw new Error(
      `[LISTA LLENA] ya hay ${activos.length} terminos vigilados y el tope es ${MAX_VIGILADOS}. `
      + `No es un capricho: cada termino cuesta ~30 busquedas al mes de las 250 que tiene todo el `
      + `sistema. Si este importa mas que alguno de los que estan, quita ese primero con `
      + `unwatchSearchTerm y explica por que. Vigilados hoy: ${activos.map((t) => t.term).join(", ")}`);
  }

  const { data, error } = await supabase.from("watched_search_terms").upsert({
    organization_id: organizationId, brand_container_id: brandContainerId,
    term: q, normalized_term: normalizar(q), geo: geo || null,
    reason: String(reason).trim(), origen, is_active: true,
  }, { onConflict: "brand_container_id,normalized_term" }).select("id").single();
  if (error) throw new Error(`no se pudo vigilar: ${error.message}`);

  return {
    ok: true, term: q, id: data.id, geo: geo || "global",
    vigilados: (activos || []).length + 1, tope: MAX_VIGILADOS,
    note: `Queda bajo medicion diaria. La primera lectura llega en la corrida de mañana.`,
    aviso: palabras >= 3
      ? "OJO: 3+ palabras casi siempre vuelve vacio en Google Trends. Si manana la lectura "
        + "sale sin datos, cambialo por el nucleo de la categoria en vez de la frase entera."
      : null,
  };
}

/** Lo que esta bajo vigilancia, con su ultima lectura y lo que aparecio nuevo. */
export async function listar({ brandContainerId, incluirInactivos = false }) {
  let q = supabase.from("watched_search_terms")
    .select("id, term, geo, reason, origen, is_active, ultima_medicion, ultimo_interes, veces_medido, created_at")
    .eq("brand_container_id", brandContainerId)
    .order("created_at", { ascending: true });
  if (!incluirInactivos) q = q.eq("is_active", true);
  const { data: terminos, error } = await q;
  if (error) throw new Error(`no se pudo listar: ${error.message}`);
  if (!terminos?.length) {
    return {
      vigilados: [], tope: MAX_VIGILADOS,
      note: "Nadie ha puesto nada bajo vigilancia. La automatizacion sigue midiendo las "
        + "palabras_clave estaticas de la marca, que no aprenden de lo que pasa.",
    };
  }

  const conLectura = await Promise.all(terminos.map(async (t) => {
    const { data: r } = await supabase.from("watched_term_readings")
      .select("medido_el, interes, rising, nuevas")
      .eq("term_id", t.id).order("medido_el", { ascending: false }).limit(1).maybeSingle();
    return {
      ...t,
      ultima_lectura: r ? {
        medido_el: r.medido_el, interes: r.interes,
        rising: (r.rising || []).slice(0, 6),
        // Esto es lo que vale: lo que hoy esta y ayer no.
        nuevas: (r.nuevas || []).slice(0, 6),
      } : null,
    };
  }));

  const conNuevas = conLectura.filter((t) => (t.ultima_lectura?.nuevas || []).length);
  return {
    vigilados: conLectura, tope: MAX_VIGILADOS, libres: MAX_VIGILADOS - conLectura.filter((t) => t.is_active).length,
    hay_novedad: conNuevas.length > 0,
    lo_que_cambio: conNuevas.map((t) => ({
      termino: t.term, nuevas: t.ultima_lectura.nuevas.map((n) => n.termino),
    })),
    como_leerlo: "El numero de hoy importa poco: Google ya da la serie entera en una "
      + "llamada. Lo que vale es `nuevas` — consultas que hoy estan y ayer no. Una consulta "
      + "en breakout es una ola empezando.",
  };
}

/** Saca un termino de la lista (no borra su historia). */
export async function dejarDeVigilar({ brandContainerId, term, motivo = null }) {
  const { data, error } = await supabase.from("watched_search_terms")
    .update({ is_active: false, reason: motivo ? `[retirado] ${motivo}` : undefined })
    .eq("brand_container_id", brandContainerId)
    .eq("normalized_term", normalizar(term))
    .select("id, term").maybeSingle();
  if (error) throw new Error(`no se pudo retirar: ${error.message}`);
  if (!data) return { ok: false, note: `"${term}" no estaba en la lista` };
  return { ok: true, term: data.term, note: "Retirado. Su historial de lecturas se conserva." };
}
