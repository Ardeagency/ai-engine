/**
 * predictor.routes — lanzar una prediccion desde el navegador.
 *
 * Solo el LANZAMIENTO pasa por aqui. La lectura de resultados NO: el frontend
 * lee `predictor_runs` directo de Supabase con su propio JWT y la RLS de la
 * tabla, igual que el resto de la app. Aqui hace falta un endpoint unicamente
 * porque hay que levantar un proceso en el server, que el navegador no puede.
 *
 * Devuelve 202 y el id: la corrida dura minutos u horas y se sondea despues.
 */
import express from "express";
import { userAuthMiddleware } from "../middleware/auth.middleware.js";
import { supabase } from "../lib/supabase.js";
import { lanzarPredictor } from "../services/predictor.service.js";

const router = express.Router();

// Anti-doble-clic: una corrida por organizacion cada 30s. No es un tope de
// gasto —el usuario decidio no tratarlo como restriccion— sino la red que evita
// que un boton nervioso levante cinco simulaciones iguales.
const ultimoLanzamiento = new Map();
const ESPERA_MS = 30 * 1000;

router.post("/run", userAuthMiddleware, async (req, res) => {
  const { organizationId, brandContainerId, titulo, pregunta, contextoExtra, rondas, plataforma } =
    req.body || {};

  if (!organizationId) {
    return res.status(400).json({ ok: false, error: "organizationId requerido" });
  }
  if (!String(pregunta || "").trim()) {
    return res.status(400).json({ ok: false, error: "Falta la pregunta: que quieres predecir" });
  }

  const { data: miembro } = await supabase
    .from("organization_members").select("user_id")
    .eq("organization_id", organizationId).eq("user_id", req.user.id).maybeSingle();
  if (!miembro) {
    return res.status(403).json({ ok: false, error: "No perteneces a esta organización" });
  }

  const prev = ultimoLanzamiento.get(organizationId) || 0;
  const faltan = ESPERA_MS - (Date.now() - prev);
  if (faltan > 0) {
    return res.status(429).json({
      ok: false,
      error: "Acabas de lanzar una prediccion. Espera un momento.",
      retryInS: Math.ceil(faltan / 1000),
    });
  }
  ultimoLanzamiento.set(organizationId, Date.now());

  try {
    const r = await lanzarPredictor({
      organizationId,
      brandContainerId: brandContainerId || null,
      titulo,
      pregunta,
      contextoExtra,
      rondas,
      plataforma,
      origen: "frontend",
      userId: req.user.id,
    });
    return res.status(202).json({ ok: true, ...r });
  } catch (e) {
    ultimoLanzamiento.delete(organizationId); // no cobrar la espera por un fallo
    console.error("predictor/run error:", e.message);
    return res.status(e.statusCode || 500).json({ ok: false, error: e.message });
  }
});

export default router;
