/**
 * skills-sync.service.js — mantener a TODAS las Veras con la doctrina al dia.
 *
 * EL PROBLEMA QUE RESUELVE: las skills solo se copiaban al aprovisionar el
 * org-server. Cualquier doctrina escrita despues se quedaba en el control plane
 * y la Vera de esa organizacion no la veia nunca. El 2026-07-27 WAKEUP tenia 21
 * skills instaladas mientras defaults/ ya tenia 45: 25 skills invisibles, entre
 * ellas todas las de ese dia. Y recrear el servidor por cada cambio de doctrina
 * es carisimo con 10 Veras, ademas de innecesario.
 *
 * COMO FUNCIONA: el control plane arma el tarball de defaults y lo EMPUJA al
 * puente de cada org-server sano, que lo instala en caliente. El tarball viaja
 * en el cuerpo de la peticion, asi que no hace falta guardar ningun secreto ni
 * abrir salida a internet en los org-servers.
 *
 * REQUISITO: el puente del org-server debe exponer POST /skills/refresh (se
 * genera en el cloud-init). Los servidores provisionados ANTES de que ese
 * endpoint existiera devuelven 404 — se reportan como pendientes de un ciclo
 * dormir/despertar, que conserva su memoria y los deja con el puente nuevo.
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "../lib/supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.join(__dirname, "..", "..", "defaults");
const TIMEOUT_MS = Number(process.env.SKILLS_SYNC_TIMEOUT_MS || 60_000);

/** Deriva el agentId igual que el provisioner: org_<32 hex del uuid>. */
function deriveAgentId(orgId) {
  return "org_" + String(orgId).replace(/-/g, "").slice(0, 24);
}

function _tarballDefaults() {
  return execSync(`tar -czf - -C "${DEFAULTS_DIR}" .`, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30_000,
  });
}

/** Empuja las skills a UNA organizacion. */
export async function syncSkillsToOrg(instancia, tarball = null) {
  const { organization_id: orgId, server_ip: ip, server_port: puerto, org_token: token, agent_id } = instancia;
  if (!ip || !puerto || !token) {
    return { orgId, ok: false, motivo: "instancia sin ip/puerto/token" };
  }
  const cuerpo = tarball || _tarballDefaults();
  const agentId = agent_id || deriveAgentId(orgId);

  try {
    const resp = await fetch(`http://${ip}:${puerto}/skills/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
        "x-org-token": token,
        "x-agent-id": agentId,
      },
      body: cuerpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.status === 404) {
      return {
        orgId, ok: false,
        motivo: "el puente de este org-server es anterior al endpoint /skills/refresh — necesita un ciclo dormir/despertar",
        necesita_wake: true,
      };
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { orgId, ok: false, motivo: body?.error || `HTTP ${resp.status}` };

    // Se registra lo que quedo REALMENTE instalado, no lo que creemos haber mandado.
    await supabase
      .from("openclaw_instances")
      .update({ skills_installed: body.skills || [], updated_at: new Date().toISOString() })
      .eq("organization_id", orgId);

    return { orgId, ok: true, skills: body.total ?? (body.skills || []).length };
  } catch (e) {
    return { orgId, ok: false, motivo: String(e.message).slice(0, 200) };
  }
}

/** Empuja las skills a todas las organizaciones con agente sano. */
export async function syncSkillsToAllOrgs() {
  const { data: sanas, error } = await supabase
    .from("openclaw_instances")
    .select("organization_id, server_ip, server_port, org_token, agent_id, status")
    .eq("status", "healthy");
  if (error) throw new Error(`skills-sync: ${error.message}`);
  if (!sanas?.length) return { total: 0, ok: 0, resultados: [] };

  // Un solo tarball para todas: se arma una vez y se reutiliza.
  const tarball = _tarballDefaults();
  const resultados = [];
  for (const inst of sanas) {
    resultados.push(await syncSkillsToOrg(inst, tarball));
  }
  const ok = resultados.filter((r) => r.ok).length;
  console.log(
    `skills-sync: ${ok}/${resultados.length} orgs al dia` +
    (ok < resultados.length
      ? ` — pendientes: ${resultados.filter((r) => !r.ok).map((r) => `${String(r.orgId).slice(0, 8)} (${r.motivo})`).join("; ")}`
      : "")
  );
  return { total: resultados.length, ok, resultados };
}
