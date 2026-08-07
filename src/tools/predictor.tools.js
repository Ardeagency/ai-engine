/**
 * predictor.tools.js — el Predictor en manos de Vera.
 *
 * Hasta hoy Vera "pre-testeaba" audiencias razonandolas en su cabeza
 * (skill `simulated-audience-pretest`). Eso sigue siendo valido y es lo rapido.
 * Esto es lo otro: un motor de verdad que instancia agentes con personalidad y
 * memoria, los deja debatir por rondas y produce un veredicto.
 *
 * LA REGLA QUE ELLA DEBE ENTENDER: esto NO se espera. Una corrida tarda minutos
 * u horas. `lanzarPredictor` devuelve un id y se acaba su turno; despues consulta
 * con `getPredictor`. Si intenta esperar, se cuelga.
 */
import {
  lanzarPredictor as lanzar,
  getPredictor as leer,
  listarPredictores as listar,
} from "../services/predictor.service.js";

/**
 * Lanza una simulacion. Devuelve el id de inmediato.
 */
export async function lanzarPredictor(params) {
  const r = await lanzar({ ...params, origen: "vera" });

  return {
    ...r,
    // Se le dice explicitamente para que no se quede esperando ni prometa el
    // resultado en este turno.
    como_seguir:
      `La simulacion quedo corriendo. NO la esperes en este turno: tarda minutos u horas. ` +
      `Avisale al usuario que la lanzaste y consultá despues con ` +
      `[[TOOL:getPredictor|params:{"runId":"${r.id}"}]].`,
  };
}

/**
 * Estado o resultado de una corrida.
 */
export async function getPredictor(params) {
  const d = await leer(params);

  if (d.estado === "corriendo" || d.estado === "pendiente") {
    const etapas = {
      ontologia: "leyendo la semilla y sacando las entidades",
      grafo: "armando el grafo de conocimiento",
      perfiles: "generando los agentes con personalidad",
      simulacion: "los agentes estan interactuando",
      reporte: "escribiendo el veredicto",
    };
    return {
      ...d,
      lectura: `Todavia corriendo — ${etapas[d.etapa] || "arrancando"}. Vuelve a consultar mas tarde.`,
    };
  }

  if (d.estado === "fallido") {
    return {
      ...d,
      // Un fallo se dice como fallo. No se maquilla como prediccion floja.
      lectura:
        `La simulacion FALLO — no hay prediccion que leer. NO inventes un resultado ` +
        `ni presentes esto como si hubiera datos. Dile al usuario que fallo y por que.`,
    };
  }

  return {
    ...d,
    lectura:
      `Simulacion terminada con ${d.agentes ?? "?"} agentes. El veredicto es del motor, ` +
      `no tuyo: leelo, interpretalo con tu criterio, y aclara siempre que es una ` +
      `simulacion — orientacion informada, no una prediccion exacta.`,
  };
}

/**
 * Historial de corridas de la organizacion.
 */
export async function listarPredictores(params) {
  const filas = await listar(params);
  return {
    corridas: filas,
    total: filas.length,
    lectura: filas.length
      ? null
      : "Esta organizacion no ha corrido ninguna prediccion todavia.",
  };
}
