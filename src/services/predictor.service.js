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
 * Arma el documento semilla.
 *
 * REGLA QUE GOBIERNA ESTE DOCUMENTO: el motor extrae los agentes de las
 * ENTIDADES que el texto protagoniza. Si la semilla habla de la marca, los
 * agentes son la marca, sus fundadores y sus retailers — medido: una corrida
 * simulo a WAKEUP, El Pollo, FDA, Amazon y Carulla debatiendo entre si.
 *
 * Por eso aqui mandan LAS PERSONAS. Salen de `audience_personas` (dolores,
 * deseos, objeciones, gatillos, forma de hablar), NO de `audience_segments`
 * —esos son objetos de pauta de Meta: cubos de retargeting y geo-targeting con
 * intereses vacios, que no describen a nadie.
 *
 * La marca entra al final y en corto: es lo que se les propone, no el sujeto.
 * En particular NO entra `creative_brief`, cuya narrativa de fundadores y
 * cadenas de retail es justo lo que envenenaba el grafo.
 *
 * Devuelve `faltantes` para poder decir de que NO se alimento la simulacion.
 */
export async function construirSemilla({ brandContainerId, organizationId, contextoExtra }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);

  const { data: marca } = await supabase
    .from("brand_containers")
    .select("nombre_marca, nicho_core, sub_nichos, propuesta_valor, mercado_objetivo")
    .eq("id", bc.id)
    .maybeSingle();

  if (!marca) {
    throw Object.assign(new Error("No se encontro el ADN de la marca."), { statusCode: 404 });
  }

  const { data: personas } = await supabase
    .from("audience_personas")
    .select("name, description, awareness_level, dolores, deseos, objeciones, gatillos_compra, estilo_lenguaje")
    .eq("organization_id", organizationId)
    .eq("brand_container_id", bc.id)
    .neq("is_active", false)
    .limit(20);

  // Una persona sin dolores/deseos/objeciones no es un personaje: es una fila
  // vacia. Meterla produce un agente hueco que no aporta y ensucia el grafo.
  const utiles = (personas || []).filter((p) => {
    const carne = [p.dolores, p.deseos, p.objeciones, p.gatillos_compra]
      .filter((a) => Array.isArray(a) && a.length).length;
    return carne >= 2 || (texto(p.description).length > 80 && carne >= 1);
  });

  const faltantes = [];
  const p = [];

  p.push(`# El publico de ${texto(marca.nombre_marca) || "la marca"}\n`);
  p.push(
    "Este documento describe a las personas reales que deciden. Cada una piensa, " +
    "duda y compra por su cuenta.\n"
  );

  if (utiles.length) {
    for (const per of utiles) {
      p.push(`\n## ${texto(per.name)}`);
      if (texto(per.description)) p.push(texto(per.description));
      if (per.awareness_level) p.push(`Que tanto conoce la categoria: ${texto(per.awareness_level)}.`);

      const bloque = (etiqueta, valores) => {
        const v = lista(valores);
        if (v.length) p.push(`\n${etiqueta}\n${v.map((x) => `- ${x}`).join("\n")}`);
      };
      bloque("Lo que le duele:", per.dolores);
      bloque("Lo que quiere:", per.deseos);
      bloque("Lo que objeta o desconfia:", per.objeciones);
      bloque("Lo que la convence:", per.gatillos_compra);

      const habla = lista(per.estilo_lenguaje);
      if (habla.length) p.push(`\nComo habla: ${habla.join("; ")}.`);
    }
  } else {
    // Sin personas no hay a quien simular. Se dice fuerte: el resultado sera
    // un analisis generico disfrazado de simulacion.
    faltantes.push("personas de audiencia (audience_personas vacias o sin contenido)");
    p.push(
      "\n> AVISO: esta marca no tiene personas de audiencia descritas. Sin ellas no " +
      "hay publico que simular y la prediccion sera generica.\n"
    );
  }

  // La marca, corta y como oferta — no como protagonista.
  p.push(`\n## Lo que se les propone`);
  const oferta = [];
  if (texto(marca.nombre_marca)) oferta.push(`**${texto(marca.nombre_marca)}**`);
  if (texto(marca.nicho_core)) oferta.push(`(${texto(marca.nicho_core)})`);
  p.push(oferta.join(" ") + ".");
  if (texto(marca.propuesta_valor)) {
    p.push(texto(marca.propuesta_valor));
  } else {
    faltantes.push("propuesta de valor");
  }
  if (lista(marca.sub_nichos).length) {
    p.push(`Lineas: ${lista(marca.sub_nichos).join(", ")}.`);
  }
  if (lista(marca.mercado_objetivo).length) {
    p.push(`Mercados: ${lista(marca.mercado_objetivo).join(", ")}.`);
  }

  if (texto(contextoExtra)) {
    p.push(`\n## El movimiento que se va a evaluar\n${texto(contextoExtra)}`);
  }

  return { semilla: p.join("\n"), marca: bc, faltantes, personas: utiles.length };
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
