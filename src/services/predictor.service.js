/**
 * predictor.service.js — el Predictor: simular publico antes de gastar en el.
 *
 * QUE ES: el frontend y Vera piden una prediccion; aqui se arma la semilla con
 * el dato REAL de la marca, se lanza el motor y se devuelve el id. La corrida se
 * reporta sola a `predictor_runs` (ver bin/correr.py); el frontend solo renderiza
 * esa fila.
 *
 * FRONTERA DE LICENCIA: el motor (MiroFish, AGPL-3.0) vive en /root/mirofish y se
 * invoca SIEMPRE como subproceso por su CLI. Nada de su codigo se importa ni se
 * copia aqui — esa separacion es la que mantiene AGPL fuera de este repo.
 *
 * POR QUE ASINCRONO: una corrida dura minutos u horas. Una peticion bloqueante
 * muere a los 300s. Por eso se lanza y se sondea, nunca se espera.
 *
 * LA SEMILLA ES EL PRODUCTO: un simulador alimentado con personas vacias es
 * teatro. Aqui la semilla se arma del ADN declarado de la marca y de sus
 * audiencias REALES registradas. Si no hay con que, se dice — no se inventa.
 */
import { spawn } from "child_process";
import path from "path";
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

const CORREDOR = "/root/mirofish-arde/bin/correr.py";
const RONDAS_POR_DEFECTO = 5;
const RONDAS_MAX = 40; // el motor advierte que por encima se dispara el consumo

const lista = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const texto = (v) => String(v ?? "").trim();

/**
 * Arma el documento semilla con lo que la marca REALMENTE tiene registrado.
 * Devuelve tambien `faltantes` para poder decir de que se alimento y de que no.
 */
export async function construirSemilla({ brandContainerId, organizationId, contextoExtra }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data: marca } = await supabase
    .from("brand_containers")
    .select(
      "nombre_marca, nicho_core, sub_nichos, arquetipo, propuesta_valor, mision_vision, " +
      "mercado_objetivo, palabras_clave, objetivos_estrategicos, creative_brief"
    )
    .eq("id", bc.id)
    .maybeSingle();

  if (!marca) {
    throw Object.assign(new Error("No se encontro el ADN de la marca."), { statusCode: 404 });
  }

  const { data: audiencias } = await supabase
    .from("audience_segments")
    .select("external_audience_name, platform, age_range, genders, locations, interests, behaviors, estimated_size")
    .eq("organization_id", organizationId)
    .eq("brand_container_id", bc.id)
    .limit(25);

  const faltantes = [];
  const p = [];

  p.push(`# ${texto(marca.nombre_marca) || "La marca"} — contexto de marca\n`);
  if (marca.nicho_core) p.push(`**Categoria:** ${texto(marca.nicho_core)}`);
  if (marca.arquetipo) p.push(`**Arquetipo:** ${texto(marca.arquetipo)}`);
  if (lista(marca.mercado_objetivo).length) {
    p.push(`**Mercados:** ${lista(marca.mercado_objetivo).join(", ")}`);
  }

  if (texto(marca.propuesta_valor)) {
    p.push(`\n## Propuesta de valor\n${texto(marca.propuesta_valor)}`);
  } else {
    faltantes.push("propuesta de valor");
  }

  if (texto(marca.mision_vision)) p.push(`\n## Mision\n${texto(marca.mision_vision)}`);

  if (lista(marca.sub_nichos).length) {
    p.push(`\n## Lineas de producto\n${lista(marca.sub_nichos).map((s) => `- ${s}`).join("\n")}`);
  }

  if (texto(marca.creative_brief)) {
    p.push(`\n## Historia y contexto\n${texto(marca.creative_brief)}`);
  } else {
    faltantes.push("brief de marca");
  }

  if (lista(marca.palabras_clave).length) {
    p.push(`\n## Territorio de lenguaje\n${lista(marca.palabras_clave).join(", ")}.`);
  }

  if (lista(marca.objetivos_estrategicos).length) {
    p.push(
      `\n## Objetivos estrategicos declarados\n` +
      lista(marca.objetivos_estrategicos).map((o) => `- ${o}`).join("\n")
    );
  }

  // Las audiencias reales son lo que separa una simulacion de un invento.
  if (audiencias?.length) {
    const filas = audiencias.map((a) => {
      const partes = [];
      if (a.external_audience_name) partes.push(`**${a.external_audience_name}**`);
      if (a.platform) partes.push(`(${a.platform})`);
      if (a.age_range) partes.push(`edad ${a.age_range}`);
      if (lista(a.genders).length) partes.push(lista(a.genders).join("/"));
      if (lista(a.locations).length) partes.push(`en ${lista(a.locations).slice(0, 6).join(", ")}`);
      if (lista(a.interests).length) partes.push(`intereses: ${lista(a.interests).slice(0, 10).join(", ")}`);
      if (lista(a.behaviors).length) partes.push(`comportamientos: ${lista(a.behaviors).slice(0, 6).join(", ")}`);
      if (a.estimated_size) partes.push(`~${Number(a.estimated_size).toLocaleString("es-CO")} personas`);
      return `- ${partes.join(" · ")}`;
    });
    p.push(`\n## Audiencias reales registradas\n${filas.join("\n")}`);
  } else {
    faltantes.push("audiencias registradas");
  }

  if (texto(contextoExtra)) {
    p.push(`\n## El movimiento que se quiere probar\n${texto(contextoExtra)}`);
  }

  return { semilla: p.join("\n"), marca: bc, faltantes };
}

/**
 * Lanza una prediccion. Devuelve el id de inmediato — NO espera a que termine.
 */
export async function lanzarPredictor({
  organizationId,
  brandContainerId = null,
  titulo,
  pregunta,
  contextoExtra = null,
  rondas = RONDAS_POR_DEFECTO,
  plataforma = "parallel",
  origen = "frontend",
  userId = null,
}) {
  if (!organizationId) {
    throw Object.assign(new Error("organizationId es obligatorio."), { statusCode: 400 });
  }
  if (!texto(pregunta)) {
    throw Object.assign(
      new Error("Falta la pregunta: que quieres predecir exactamente."),
      { statusCode: 400 }
    );
  }

  const n = Number(rondas);
  const rondasOk = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), RONDAS_MAX) : RONDAS_POR_DEFECTO;
  const plataformaOk = ["parallel", "twitter", "reddit"].includes(plataforma) ? plataforma : "parallel";

  const { semilla, marca, faltantes } = await construirSemilla({
    brandContainerId, organizationId, contextoExtra,
  });

  const { data, error } = await supabase
    .from("predictor_runs")
    .insert({
      organization_id: organizationId,
      brand_container_id: marca.id,
      user_id: userId,
      titulo: texto(titulo) || texto(pregunta).slice(0, 120),
      pregunta: texto(pregunta),
      semilla,
      rondas: rondasOk,
      plataforma: plataformaOk,
      origen: origen === "vera" ? "vera" : "frontend",
      estado: "pendiente",
    })
    .select("id, titulo, estado, rondas")
    .single();

  if (error) {
    throw Object.assign(new Error(`No se pudo registrar la corrida: ${error.message}`), { statusCode: 500 });
  }

  // Detached a proposito: la corrida sobrevive a un reinicio de ai-engine, y se
  // reporta sola a la tabla. Si muriera con el padre, un `systemctl restart`
  // dejaria la fila colgada en 'corriendo' para siempre.
  try {
    const hijo = spawn("python3", [CORREDOR, data.id], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(CORREDOR),
    });
    hijo.unref();
  } catch (e) {
    await supabase
      .from("predictor_runs")
      .update({ estado: "fallido", error: `No se pudo lanzar el motor: ${e.message}` })
      .eq("id", data.id);
    throw Object.assign(new Error(`No se pudo lanzar el motor: ${e.message}`), { statusCode: 500 });
  }

  return {
    id: data.id,
    titulo: data.titulo,
    estado: "corriendo",
    rondas: data.rondas,
    marca: marca.nombre_marca,
    // Honestidad sobre el combustible: si la semilla vino coja, se dice aqui.
    semilla_sin: faltantes,
    aviso: faltantes.length
      ? `La semilla se armo sin: ${faltantes.join(", ")}. La prediccion sera mas floja de lo que podria.`
      : null,
  };
}

/** Estado y resultado de una corrida. */
export async function getPredictor({ organizationId, runId, incluirReporte = false }) {
  if (!runId) {
    throw Object.assign(new Error("Falta el id de la corrida."), { statusCode: 400 });
  }

  const columnas =
    "id, titulo, pregunta, estado, etapa, origen, rondas, plataforma, agentes, nodos, aristas, " +
    "veredicto, resumen, costo_usd, llamadas_llm, error, created_at, started_at, finished_at" +
    (incluirReporte ? ", reporte_md" : "");

  const { data, error } = await supabase
    .from("predictor_runs")
    .select(columnas)
    .eq("id", runId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw Object.assign(new Error(`No se pudo leer la corrida: ${error.message}`), { statusCode: 500 });
  }
  if (!data) {
    throw Object.assign(new Error("Esa corrida no existe en esta organizacion."), { statusCode: 404 });
  }
  return data;
}

/** Historial de corridas de la organizacion. */
export async function listarPredictores({ organizationId, limite = 20 }) {
  const { data, error } = await supabase
    .from("predictor_runs")
    .select("id, titulo, pregunta, estado, etapa, origen, agentes, costo_usd, created_at, finished_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Number(limite) || 20, 100));

  if (error) {
    throw Object.assign(new Error(`No se pudo listar: ${error.message}`), { statusCode: 500 });
  }
  return data || [];
}
