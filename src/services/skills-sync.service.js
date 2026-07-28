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
import { readFileSync } from "fs";
import { watch as fsWatch } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "../lib/supabase.js";
import { calcularDiferencial, pedirAutoactualizacion, pedirRetirada } from "./skills-selfupdate.service.js";

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

// Ficheros de doctrina RAIZ. El endpoint /skills/refresh solo instala `skills/`,
// asi que sin esto AGENTS.md e IDENTITY.md solo cambiaban al recrear la VM.
// /workspace/file existe tambien en los puentes viejos: su lista blanca es
// ['USER.md','AGENTS.md','IDENTITY.md','SOUL.md','MEMORY.md'].
const RAIZ = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];

async function _empujarRaiz({ ip, puerto, token, agentId }) {
  const escritos = [];
  for (const f of RAIZ) {
    try {
      const contenido = readFileSync(path.join(DEFAULTS_DIR, f), "utf8");
      const r = await fetch(`http://${ip}:${puerto}/workspace/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-org-token": token },
        body: JSON.stringify({ path: f, agentId, content: contenido }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.ok) escritos.push(f);
    } catch { /* la doctrina raiz no debe tumbar el refresco de skills */ }
  }
  return escritos;
}

/** Empuja las skills a UNA organizacion. */
export async function syncSkillsToOrg(instancia, tarball = null) {
  const { organization_id: orgId, server_ip: ip, server_port: puerto, org_token: token, agent_id } = instancia;
  if (!ip || !puerto || !token) {
    return { orgId, ok: false, motivo: "instancia sin ip/puerto/token" };
  }
  const cuerpo = tarball || _tarballDefaults();
  const agentId = agent_id || deriveAgentId(orgId);

  // Primero la doctrina raiz: funciona hasta en los puentes viejos, asi que una
  // org sin /skills/refresh al menos no se queda con un AGENTS.md fosil.
  const raiz = await _empujarRaiz({ ip, puerto, token, agentId });

  // Lo que hay que RETIRAR se calcula ANTES de empujar, contra lo que ella reporto
  // la ultima vez. El empuje instala y sobreescribe; borrar es lo unico que ningun
  // endpoint del puente sabe hacer, y va despues, ya con el contenido en su sitio.
  const { aEliminar } = calcularDiferencial(instancia.skills_installed);

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
      // Puente anterior a /skills/refresh. Ya no es motivo para recrear la VM:
      // /agent/run existe en todos los puentes desde el principio.
      const r = await pedirAutoactualizacion(instancia);
      return { ...r, raiz, nota: "puente viejo — resuelto por autoactualizacion, sin dormir/despertar" };
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { orgId, ok: false, motivo: body?.error || `HTTP ${resp.status}` };

    // Se registra lo que quedo REALMENTE instalado, no lo que creemos haber mandado.
    await supabase
      .from("openclaw_instances")
      .update({ skills_installed: body.skills || [], updated_at: new Date().toISOString() })
      .eq("organization_id", orgId);

    // El contenido ya esta puesto por ai-engine. Si algo fue retirado, ahora si se
    // le dicta la lista exacta: es el unico paso que necesita sus manos.
    const retirada = aEliminar.length ? await pedirRetirada(instancia, aEliminar) : null;

    return {
      orgId, ok: retirada ? retirada.ok : true,
      skills: retirada?.skills ?? (body.total ?? (body.skills || []).length),
      raiz,
      ...(aEliminar.length ? { retiradas: aEliminar, retirada } : { retiradas: body.retiradas || [] }),
    };
  } catch (e) {
    return { orgId, ok: false, motivo: String(e.message).slice(0, 200) };
  }
}

/** Empuja las skills a todas las organizaciones con agente sano. */
export async function syncSkillsToAllOrgs() {
  const { data: sanas, error } = await supabase
    .from("openclaw_instances")
    .select("organization_id, server_ip, server_port, org_token, agent_id, status, skills_installed")
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

// ── Automatico: cualquier cambio en las skills se propaga solo ───────────────
// El usuario no deberia tener que acordarse de sincronizar. Se vigila el
// directorio de skills y ante cualquier alta, edicion o borrado se empuja a
// todas las Veras. Con antirrebote, porque guardar un fichero dispara varios
// eventos y editar tres skills seguidas no debe ser tres sincronizaciones.
let _temporizador = null;
let _sincronizando = false;
let _pendiente = false;

const REBOTE_MS = Number(process.env.SKILLS_WATCH_DEBOUNCE_MS || 15_000);

async function _sincronizarDeboundeado(motivo) {
  if (_sincronizando) { _pendiente = true; return; }   // se reintenta al terminar
  _sincronizando = true;
  try {
    console.log(`skills-sync: cambio detectado (${motivo}) — propagando a las Veras`);
    await syncSkillsToAllOrgs();
  } catch (e) {
    console.warn(`skills-sync: fallo propagando — ${e.message}`);
  } finally {
    _sincronizando = false;
    if (_pendiente) { _pendiente = false; _sincronizarDeboundeado("cambios acumulados"); }
  }
}

/**
 * Vigila defaults/skills y propaga cualquier cambio. Deshabilitar con
 * SKILLS_WATCH_ENABLED=false.
 */
export function startSkillsWatcher() {
  const dir = path.join(DEFAULTS_DIR, "skills");
  let watcher;
  try {
    // recursive:true para enterarse tambien de un SKILL.md editado dentro de su carpeta.
    watcher = fsWatch(dir, { recursive: true }, (_evento, archivo) => {
      if (archivo && !/SKILL\.md$/i.test(String(archivo)) && String(archivo).includes(".")) return;
      clearTimeout(_temporizador);
      _temporizador = setTimeout(() => _sincronizarDeboundeado(String(archivo || "skills/")), REBOTE_MS);
    });
  } catch (e) {
    console.warn(`skills-sync: no se pudo vigilar ${dir} — ${e.message}`);
    return null;
  }
  console.log(`skills-sync: vigilando ${dir} — todo cambio se propaga solo (antirrebote ${Math.round(REBOTE_MS / 1000)}s)`);
  return watcher;
}
