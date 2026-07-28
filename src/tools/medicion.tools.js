/**
 * medicion.tools.js — Vera mide, ai-engine anota, y le devuelve la serie.
 *
 * DE DONDE SALE: `audit-distinctive-assets.service.js` hacia el blink test con
 * gpt-4o VISION desde ai-engine y escribia el resultado en `asset_equity`. La
 * mitad estaba bien y la otra al reves: MEDIR y guardar una serie es trabajo
 * nuestro —una serie dice si la marca mejora, no solo como esta hoy—, pero el
 * JUICIO de si un activo se reconoce es de ella, que tiene la doctrina en
 * `the-codes-that-make-me-recognizable`.
 *
 * Ademas la serie era un callejon sin salida: `asset_equity` tenia 16 filas y
 * sus dos consumidores no existian (la RPC track_asset_consistency nunca se
 * creo y contention_guard estaba huerfano). Aqui se cierra el circulo: se anota
 * Y se puede releer.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

// Los tipos se guardan con el vocabulario que YA esta en la tabla (color, font,
// logo, rule). Si aqui se hubiera usado el español, `font:Open Sans` y
// `tipografia:Open Sans` serian dos activos distintos y la serie historica se
// partiria en dos para siempre. Se aceptan ambos y se normaliza al guardar.
const NORMALIZA = {
  color: "color",
  tipografia: "font", font: "font", fuente: "font",
  logo: "logo", wordmark: "logo", logotipo: "logo",
  regla: "rule", rule: "rule",
  otro: "other", other: "other",
};

/**
 * Anota la medición de consistencia de los códigos distintivos.
 *
 * El blink test lo hace ELLA sobre las piezas que le devuelve
 * `getMaterialDeCodigos`. Aquí solo se guarda, y se calcula lo que es
 * aritmética —la consistencia— para que no dependa de que ella divida bien.
 *
 * @param {object} p
 * @param {Array<{tipo:string, activo:string, piezas_con_el:number,
 *                piezas_miradas:number, reconocimiento:number}>} p.mediciones
 */
export async function registrarMedicionDeCodigos({ brandContainerId, organizationId, mediciones }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!Array.isArray(mediciones) || !mediciones.length) {
    throw new Error("mediciones debe ser una lista con al menos un activo medido.");
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const filas = [];
  const rechazos = [];

  for (const m of mediciones) {
    const activo = String(m?.activo || "").trim();
    const tipo = String(m?.tipo || "otro").toLowerCase();
    const miradas = Number(m?.piezas_miradas);
    const conEl = Number(m?.piezas_con_el);
    const reconocimiento = Number(m?.reconocimiento);

    if (!activo) { rechazos.push("un activo sin nombre"); continue; }
    const tipoNorm = NORMALIZA[tipo];
    if (!tipoNorm) {
      rechazos.push(`${activo}: tipo '${tipo}' no valido (${[...new Set(Object.keys(NORMALIZA))].join("/")})`);
      continue;
    }
    if (!Number.isFinite(miradas) || miradas < 1) { rechazos.push(`${activo}: piezas_miradas debe ser >= 1`); continue; }
    if (!Number.isFinite(conEl) || conEl < 0 || conEl > miradas) {
      rechazos.push(`${activo}: piezas_con_el (${conEl}) fuera de rango sobre ${miradas} miradas`); continue;
    }
    if (!Number.isFinite(reconocimiento) || reconocimiento < 0 || reconocimiento > 1) {
      rechazos.push(`${activo}: reconocimiento debe ir de 0 a 1 (te llego ${m?.reconocimiento})`); continue;
    }

    filas.push({
      organization_id: bc.organization_id || organizationId,
      brand_container_id: bc.id,
      asset_type: tipoNorm,
      asset_ref: activo,
      applied_count: conEl,
      total_outputs: miradas,
      // Aritmetica, no juicio: se calcula aqui para que la serie sea comparable
      // entre corridas aunque quien mida cambie de criterio al redondear.
      consistency_score: Number((conEl / miradas).toFixed(4)),
      recognized_score: Number(reconocimiento.toFixed(4)),
      snapshot_date: hoy,
      measured_at: new Date().toISOString(),
    });
  }

  if (!filas.length) {
    return { ok: false, anotadas: 0, rechazos, motivo: "ninguna medicion valida" };
  }

  const { error } = await supabase.from("asset_equity").insert(filas);
  if (error) throw new Error(`anotar la medicion: ${error.message}`);

  return {
    ok: true,
    anotadas: filas.length,
    fecha: hoy,
    rechazos: rechazos.length ? rechazos : undefined,
    siguiente: "Consulta getSerieDeCodigos para ver si esto mejora o empeora contra las mediciones anteriores.",
  };
}

/**
 * La serie histórica de cada código: para poder decir si MEJORA, no solo cómo está.
 */
export async function getSerieDeCodigos({ brandContainerId, organizationId, desde = null }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  let q = supabase.from("asset_equity")
    .select("asset_type, asset_ref, applied_count, total_outputs, consistency_score, recognized_score, snapshot_date")
    .eq("brand_container_id", bc.id)
    .order("snapshot_date", { ascending: true });
  if (desde) q = q.gte("snapshot_date", desde);

  const { data, error } = await q;
  if (error) throw new Error(`leer la serie: ${error.message}`);
  if (!data?.length) {
    return {
      hay: false,
      motivo: "esta marca no tiene ninguna medicion anotada todavia",
      siguiente: "Haz el blink test con getMaterialDeCodigos y anotalo con registrarMedicionDeCodigos. " +
                 "La primera medicion no dice si mejora — dice desde donde se cuenta.",
    };
  }

  const porActivo = {};
  for (const f of data) {
    const clave = `${f.asset_type}:${f.asset_ref}`;
    (porActivo[clave] ||= []).push({
      fecha: f.snapshot_date,
      consistencia: f.consistency_score,
      reconocimiento: f.recognized_score,
      piezas: `${f.applied_count}/${f.total_outputs}`,
    });
  }

  const activos = Object.entries(porActivo).map(([clave, serie]) => {
    const primera = serie[0], ultima = serie[serie.length - 1];
    const delta = serie.length > 1
      ? (ultima.consistencia - primera.consistencia).toFixed(4)
      : null;
    return {
      activo: clave,
      mediciones: serie.length,
      ultima,
      tendencia: delta == null
        ? "una sola medicion — todavia no hay tendencia, no la inventes"
        : Number(delta) > 0.05 ? `mejora (+${delta})`
        : Number(delta) < -0.05 ? `empeora (${delta})`
        : `estable (${delta})`,
      serie,
    };
  });

  return { hay: true, activos, total_mediciones: data.length };
}
