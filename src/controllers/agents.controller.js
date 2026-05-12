/**
 * Agents Controller — endpoints de gestión de agentes y misiones.
 */
import { supabase } from "../lib/supabase.js";
import { getAllOrgs, getRegistrySize } from "../services/openclaw.registry.js";
import { provisionOpenClawForOrg, deprovisionOpenClawForOrg } from "../services/openclaw.provisioner.js";
import { stopAgent } from "../services/agent.manager.js";

function assertInternalKey(req, res) {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || req.headers["x-internal-key"] !== key) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// GET /agents/status
export const getStatus = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  try {
    const orgs = getAllOrgs();
    res.json({ active_agents: orgs.length, agents: orgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// GET /agents/fleet
export const fleet = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  try {
    const { data: instances } = await supabase
      .from("openclaw_instances")
      .select("organization_id, agent_id, workspace_path, status, created_at, updated_at")
      .order("created_at", { ascending: false });

    res.json({
      registry_size: getRegistrySize(),
      openclaw_agents: getAllOrgs(),
      db_instances: instances || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// POST /agents/provision
export const provision = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  const { organization_id } = req.body || {};
  if (!organization_id) return res.status(400).json({ error: "organization_id requerido" });

  try {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organization_id)
      .maybeSingle();

    const result = await provisionOpenClawForOrg(organization_id, org?.name || organization_id);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// POST /agents/stop
export const stop = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  const { organization_id, reason, deprovision } = req.body || {};
  if (!organization_id) return res.status(400).json({ error: "organization_id requerido" });

  try {
    await stopAgent(organization_id, reason || "api_request");

    if (deprovision === true) {
      await deprovisionOpenClawForOrg(organization_id);
    }

    res.json({ success: true, organization_id, deprovisioned: deprovision === true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// GET /agents/policy
export const policy = async (req, res) => {
  if (!assertInternalKey(req, res)) return;
  res.json({
    max_agents: Number(process.env.MAX_AGENTS) || 8,
    model: process.env.OPENCLAW_DEFAULT_MODEL || "openai/gpt-4o-mini",
  });
};

// POST /missions
export const createMissionEndpoint = async (req, res) => {
  res.status(501).json({ error: "Missions not implemented in this version." });
};

// GET /missions
export const listMissions = async (req, res) => {
  res.status(501).json({ error: "Missions not implemented in this version." });
};
