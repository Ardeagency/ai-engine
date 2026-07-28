/**
 * dashboard.routes — reanálisis de una card del dashboard pedido por un HUMANO.
 *
 * "Volver a consultar": el usuario ve una card que escribió Vera y le pide que
 * la mire otra vez. Autenticado con el JWT del usuario (no la internal key: esto
 * lo llama el navegador) y verificando que sea miembro de la org de esa marca.
 *
 * OJO — la lectura se regenera ENTERA, no solo la card pedida: el contrato
 * cards.v2 exige las 5 cards obligatorias, así que no existe un modo parcial.
 * `card` viaja igual, se guarda en el trigger y le dice a Vera QUÉ quiere el
 * humano que reconsidere con más cuidado.
 */
import express from "express";
import { userAuthMiddleware } from "../middleware/auth.middleware.js";
import { supabase } from "../lib/supabase.js";
import { runMiMarcaCards } from "../services/vera-dashboard-session.service.js";

const router = express.Router();

// Una marca a la vez: dos sesiones sobre el mismo org-server colisionan a vacío.
const enCurso = new Set();
// Anti-doble-clic y anti-quemar-creditos: 1 reanálisis por marca cada 3 min.
const ultimo = new Map();
const ESPERA_MS = 3 * 60 * 1000;

router.post("/recheck", userAuthMiddleware, async (req, res) => {
  const { brandContainerId, card } = req.body || {};
  if (!brandContainerId) {
    return res.status(400).json({ ok: false, error: "brandContainerId requerido" });
  }

  // ¿De qué org es esta marca, y el usuario pertenece a ella?
  const { data: brand } = await supabase
    .from("brand_containers").select("id, organization_id")
    .eq("id", brandContainerId).maybeSingle();
  if (!brand) return res.status(404).json({ ok: false, error: "Marca no encontrada" });

  const { data: miembro } = await supabase
    .from("organization_members").select("user_id")
    .eq("organization_id", brand.organization_id).eq("user_id", req.user.id).maybeSingle();
  if (!miembro) return res.status(403).json({ ok: false, error: "No perteneces a esta organización" });

  if (enCurso.has(brandContainerId)) {
    return res.status(409).json({ ok: false, error: "Vera ya está revisando esta marca" });
  }
  const prev = ultimo.get(brandContainerId) || 0;
  const faltan = ESPERA_MS - (Date.now() - prev);
  if (faltan > 0) {
    return res.status(429).json({ ok: false, error: "Vera acaba de revisar esta marca", retryInS: Math.ceil(faltan / 1000) });
  }

  enCurso.add(brandContainerId);
  ultimo.set(brandContainerId, Date.now());
  res.status(202).json({ ok: true, accepted: true, card: card || null });

  const trigger = `recheck_${String(card || "todo").slice(0, 40)}`;
  runMiMarcaCards(brandContainerId, { trigger })
    .then((r) => console.log(`dashboard/recheck [${brandContainerId}] card=${card || "-"}:`, JSON.stringify(r).slice(0, 300)))
    .catch((e) => console.error(`dashboard/recheck [${brandContainerId}] error:`, e.message))
    .finally(() => enCurso.delete(brandContainerId));
});

export default router;
