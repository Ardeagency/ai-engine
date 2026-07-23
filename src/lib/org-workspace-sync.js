/**
 * org-workspace-sync.js — escribe archivos del workspace de Vera en el
 * org-server de la organizacion, via el endpoint /workspace/file del bridge.
 *
 * Hoy solo USER.md: el manifiesto de identidad de la marca (brand-dna-generator)
 * ES el USER.md que OpenClaw inyecta en CADA sesion (chat, cards, ciclo). Antes
 * se inyectaba inline en el mensaje y solo llegaba al chat; ahora es UN archivo,
 * incrustado en la org asignada, entregado nativo a todas las superficies.
 *
 * Fail-open: nunca lanza al caller. Si el org-server no esta corriendo, se
 * omite — el manifiesto se horneara en el proximo provision/wake (ver
 * hetzner.provisioner.js -> createOrgServer).
 */
import { supabase } from "./supabase.js";

const FRAME =
  "# A QUIEN SIRVO\n\n" +
  "> La marca que cuido, en su propia voz. Es la identidad que asumo cuando " +
  "hablo por ella; no un dato para citar.\n\n";

export function wrapUserMd(dnaText) {
  return FRAME + String(dnaText || "").trim() + "\n";
}

export async function syncOrgUserMd(organizationId, dnaText) {
  if (!organizationId || !dnaText) return { ok: false, skipped: "no-data" };
  try {
    const { data: inst } = await supabase
      .from("openclaw_instances")
      .select("server_ip, server_port, org_token, agent_id, sleeping")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!inst || !inst.server_ip || !inst.server_port || !inst.org_token || !inst.agent_id) {
      return { ok: false, skipped: "no-instance" };
    }
    if (inst.sleeping) return { ok: false, skipped: "sleeping" };

    const res = await fetch(`http://${inst.server_ip}:${inst.server_port}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Org-Token": inst.org_token },
      body: JSON.stringify({ agentId: inst.agent_id, path: "USER.md", content: wrapUserMd(dnaText) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
