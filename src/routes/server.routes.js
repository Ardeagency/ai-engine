import express from "express";
import { getCurrentHealth } from "../services/server.health.service.js";

const router = express.Router();

// Health check público — solo estado mínimo para load balancers y monitoreo externo.
// Datos de capacidad, registry y configuración están en /agents/fleet (requiere auth).
router.get("/health", (req, res) => {
  try {
    const health = getCurrentHealth();
    const isHealthy = health.state !== "critical";
    res.status(isHealthy ? 200 : 503).json({
      ok: isHealthy,
      state: health.state,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({ ok: false, state: "error" });
  }
});

export default router;
