/**
 * MCP Routes — endpoints consumidos por el MCP server distribuido en cada org-server.
 *
 * Auth: X-Org-Token (mismo token que usa el bridge HTTP /agent/run)
 * Rate-limit / abuse: por ahora confiamos en que el token es secreto y el firewall
 *                     restringe quién puede hablar con ai-engine. Si en el futuro
 *                     hay leak, rotamos org_tokens y forzamos re-provisioning.
 */
import express from "express";
import { mcpDispatch, mcpListTools, mcpHealth } from "../controllers/mcp.controller.js";

const router = express.Router();

router.get("/health",     mcpHealth);
router.get("/list-tools", mcpListTools);
router.post("/dispatch",  mcpDispatch);

export default router;
