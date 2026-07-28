/**
 * skills-selfupdate.service.js — ai-engine es la BIBLIOTECA; cada Vera se
 * actualiza sola.
 *
 * EL PROBLEMA. El refresco por el puente (`POST /skills/refresh`) instala y
 * sobreescribe, pero el puente vive dentro del cloud-init: para cambiarlo hay
 * que recrear la VM. Eso convertia cada mejora del mecanismo —por ejemplo poder
 * BORRAR una skill retirada— en un ciclo dormir/despertar por organizacion.
 * Caro, lento, y con perdida de huella SSH cada vez.
 *
 * LA VUELTA. No hace falta un puente mas listo: hace falta decirselo a quien ya
 * tiene manos. Vera corre sobre OpenClaw, con bash y descarga de URLs nativas.
 * ai-engine calcula el diferencial contra su biblioteca y le manda UNA
 * instruccion: "esto se anadio, esto cambio, esto se elimino — actualizate".
 * Ella lo hace y reporta. Funciona con CUALQUIER puente, incluso los anteriores
 * a /skills/refresh, porque /agent/run existe en todos desde el principio.
 *
 * EL SECRETO NO VIAJA. `/internal/defaults.tar.gz` exige INTERNAL_WEBHOOK_SECRET,
 * y ese secreto no puede acabar dentro del prompt de un agente: quedaria en su
 * transcripcion y en su memoria. En su lugar se acuna un token de UN SOLO USO y
 * vida corta, valido solo para esa organizacion.
 *
 * CUANDO SE USA CADA CAMINO:
 *   - hay algo que BORRAR, o el puente es viejo  → autoactualizacion (1 turno).
 *   - solo altas y ediciones, puente moderno     → empuje por el puente (gratis).
 * Asi siempre converge, y solo se gasta un turno de agente cuando de verdad
 * hace falta.
 */
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { readdirSync, statSync } from "fs";
import { supabase } from "../lib/supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.join(__dirname, "..", "..", "defaults");
const SKILLS_DIR = path.join(DEFAULTS_DIR, "skills");

const PUBLIC_URL = (process.env.AI_ENGINE_PUBLIC_URL || "https://api.aismartcontent.io").replace(/\/+$/, "");
const TURNO_MS = Number(process.env.SKILLS_SELFUPDATE_TIMEOUT_MS || 600_000);
const TOKEN_TTL_MS = 15 * 60_000;

// ── Tokens de descarga: un solo uso, vida corta, atados a una org ────────────
const _tokens = new Map();   // token -> { orgId, expira }

export function acunarTokenBundle(orgId) {
  const token = crypto.randomBytes(24).toString("hex");
  _tokens.set(token, { orgId, expira: Date.now() + TOKEN_TTL_MS });
  // Aseo perezoso: sin esto un fallo repetido dejaria tokens muertos para siempre.
  for (const [t, v] of _tokens) if (v.expira < Date.now()) _tokens.delete(t);
  return token;
}

/** Valida y QUEMA el token. Devuelve el orgId, o null si no sirve. */
export function consumirTokenBundle(token) {
  const v = _tokens.get(String(token || ""));
  if (!v) return null;
  _tokens.delete(token);                      // un solo uso, pase lo que pase
  if (v.expira < Date.now()) return null;
  return v.orgId;
}

/** Los nombres de la biblioteca: cada subcarpeta de defaults/skills. */
export function bibliotecaActual() {
  return readdirSync(SKILLS_DIR)
    .filter((n) => {
      try { return statSync(path.join(SKILLS_DIR, n)).isDirectory(); }
      catch { return false; }
    })
    .sort();
}

/**
 * Diferencial entre la biblioteca y lo que una Vera tiene instalado.
 * `instaladas` es lo ultimo que ELLA reporto, no lo que creemos haberle mandado.
 */
export function calcularDiferencial(instaladas) {
  const biblioteca = bibliotecaActual();
  const tiene = new Set(instaladas || []);
  return {
    biblioteca,
    aInstalar: biblioteca.filter((s) => !tiene.has(s)),
    aEliminar: [...tiene].filter((s) => !biblioteca.includes(s)).sort(),
  };
}

function _instruccion({ url, aInstalar, aEliminar, total }) {
  const lineas = [
    "Mantenimiento de tu propia biblioteca de skills. Lo pide ai-engine, que es",
    "donde vive la biblioteca maestra. No analices la marca ni uses herramientas de",
    "negocio: esto es tuyo y se hace con bash.",
    "",
    `Tu biblioteca maestra tiene ${total} skills.`,
  ];
  if (aInstalar.length) {
    lineas.push("", `NUEVAS O ACTUALIZADAS (${aInstalar.length}): ${aInstalar.join(", ")}`);
  }
  if (aEliminar.length) {
    lineas.push("", `RETIRADAS — ya no existen en la biblioteca (${aEliminar.length}): ${aEliminar.join(", ")}`,
      "Estas hay que BORRARLAS de tu carpeta. Una skill retirada que sobrevive compite",
      "con la que la reemplazo y te hace dudar al elegir cual invocar.");
  }
  lineas.push(
    "",
    "PASOS (bash, y nada mas):",
    `1. Descarga el paquete:  curl -sfL "${url}" -o /tmp/biblioteca.tar.gz`,
    "   Es un enlace de un solo uso y caduca en 15 minutos.",
    "2. Extraelo en una carpeta temporal propia (mktemp -d), no en tu workspace.",
    "3. Copia el contenido de su carpeta skills/ SOBRE tu carpeta de skills.",
    "   Sobreescribir es lo correcto: asi se actualizan las que cambiaron.",
    "4. Refresca tambien AGENTS.md, IDENTITY.md y SOUL.md desde la raiz del paquete.",
    "5. ESPEJO: borra de tu carpeta de skills toda subcarpeta que NO venga en el",
    "   paquete. Solo dentro de tu carpeta de skills; nada mas del workspace.",
    "6. Borra la carpeta temporal.",
    "",
    "Termina tu respuesta con UNA linea exactamente asi, sin nada detras:",
    "SKILLS_FINAL: nombre1,nombre2,nombre3",
    "con la lista real que quedo tras el espejo, separada por comas.",
    "Antes de esa linea, dos frases: que instalaste y que borraste.",
  );
  return lineas.join("\n");
}

/**
 * Le dicta a UNA Vera que retire skills concretas.
 *
 * Es el unico paso que necesita sus manos: el puente sabe instalar y sobreescribir,
 * pero no borrar. No hay descarga aqui — el contenido ya se lo empujo ai-engine.
 * Esto es una orden con nombres propios, no una invitacion a decidir.
 */
export async function pedirRetirada(instancia, aEliminar) {
  const { organization_id: orgId, server_ip: ip, server_port: puerto, org_token: token, agent_id } = instancia;
  if (!aEliminar?.length) return { orgId, ok: true, borro: 0 };
  const agentId = agent_id || "org_" + String(orgId).replace(/-/g, "").slice(0, 24);

  const mensaje = [
    "Mantenimiento de tu biblioteca de skills. Lo dicta ai-engine, que es donde vive",
    "la biblioteca maestra. No analices la marca ni uses herramientas de negocio.",
    "",
    `Estas skills fueron RETIRADAS de la biblioteca (${aEliminar.length}):`,
    aEliminar.map((s) => `  - ${s}`).join("\n"),
    "",
    "Ya no existen en la maestra. Una skill retirada que sobrevive en tu carpeta",
    "compite con la que la reemplazo y te hace dudar al elegir cual invocar.",
    "",
    "Con bash: borra ESAS subcarpetas de tu carpeta de skills, y ninguna otra.",
    "No toques nada mas del workspace.",
    "",
    "Termina con UNA linea exactamente asi, sin nada detras:",
    "SKILLS_FINAL: nombre1,nombre2,nombre3",
    "con la lista real que quedo. Antes, una frase con lo que borraste.",
  ].join("\n");

  try {
    const resp = await fetch(`http://${ip}:${puerto}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-org-token": token },
      body: JSON.stringify({ agentId, message: mensaje, sessionId: `biblioteca-${new Date().toISOString().slice(0, 10)}` }),
      signal: AbortSignal.timeout(TURNO_MS),
    });
    const cuerpo = await resp.text();
    if (!resp.ok) return { orgId, ok: false, motivo: `retirada: HTTP ${resp.status}` };
    const lista = _leerListaFinal(cuerpo);
    if (!lista) return { orgId, ok: false, motivo: "retiro pero no reporto su lista final (SKILLS_FINAL)" };
    await supabase.from("openclaw_instances")
      .update({ skills_installed: lista, updated_at: new Date().toISOString() })
      .eq("organization_id", orgId);
    const sobran = lista.filter((x) => aEliminar.includes(x));
    return { orgId, ok: !sobran.length, borro: aEliminar.length, skills: lista.length,
             ...(sobran.length ? { no_borro: sobran } : {}) };
  } catch (e) {
    return { orgId, ok: false, motivo: `retirada: ${String(e.message).slice(0, 140)}` };
  }
}

/**
 * Extrae la lista que ELLA reporto. Sin eso no se anota nada: no se inventa estado.
 *
 * Lee SOLO su texto final. El cuerpo de /agent/run trae ademas el prompt que le
 * mandamos —con el ejemplo literal "SKILLS_FINAL: nombre1,nombre2,..."— y los
 * saltos de linea escapados, asi que leer el JSON crudo daba dos errores a la vez:
 * casar con nuestro propio ejemplo, y tragarse miles de caracteres por no hallar
 * fin de linea. Un ensayo llego a reportar 1492 skills.
 */
function _leerListaFinal(cuerpo) {
  let dicho = "";
  let salida = String(cuerpo || "");
  try {
    const j = JSON.parse(cuerpo);
    if (typeof j.output === "string") salida = j.output;
  } catch { /* cuerpo no-JSON: se intenta igual sobre el texto crudo */ }

  // El output es a su vez JSON: { payloads, meta }. Lo que ella DIJO vive en meta.
  try {
    const t = JSON.parse(salida);
    dicho = t?.meta?.finalAssistantVisibleText || t?.meta?.finalAssistantRawText ||
            t?.finalAssistantVisibleText || t?.finalAssistantRawText || "";
  } catch { /* sigue el respaldo por regex */ }

  // Respaldo FUERA del catch: si la forma cambia, esto sigue encontrandolo.
  if (!dicho) {
    const m = salida.match(/"finalAssistant(?:Visible|Raw)Text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) { try { dicho = JSON.parse('"' + m[1] + '"'); } catch { /* ignora */ } }
  }
  if (!dicho) return null;

  const m = dicho.match(/SKILLS_FINAL:\s*([^\n\r]+)/);
  if (!m) return null;

  const lista = [...new Set(
    m[1].split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9._-]{2,64}$/.test(x))
  )];

  // Cordura: un inventario que no se parece a la biblioteca es un parseo malo,
  // no un inventario real. Mejor no anotar que anotar mentira.
  const biblioteca = new Set(bibliotecaActual());
  const reconocidas = lista.filter((x) => biblioteca.has(x)).length;
  if (!lista.length || lista.length > biblioteca.size + 25) return null;
  if (reconocidas < Math.min(3, biblioteca.size)) return null;

  return lista;
}

/**
 * Le pide a UNA Vera que se actualice sola.
 * No toca su VM: le da el diferencial y un enlace, y ella hace el trabajo.
 */
export async function pedirAutoactualizacion(instancia) {
  const { organization_id: orgId, server_ip: ip, server_port: puerto, org_token: token, agent_id, skills_installed } = instancia;
  if (!ip || !puerto || !token) return { orgId, ok: false, motivo: "instancia sin ip/puerto/token" };

  const { biblioteca, aInstalar, aEliminar } = calcularDiferencial(skills_installed);
  const agentId = agent_id || "org_" + String(orgId).replace(/-/g, "").slice(0, 24);
  const url = `${PUBLIC_URL}/internal/skills/bundle/${acunarTokenBundle(orgId)}`;

  let resp;
  try {
    resp = await fetch(`http://${ip}:${puerto}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-org-token": token },
      body: JSON.stringify({
        agentId,
        message: _instruccion({ url, aInstalar, aEliminar, total: biblioteca.length }),
        sessionId: `biblioteca-${new Date().toISOString().slice(0, 10)}`,
      }),
      signal: AbortSignal.timeout(TURNO_MS),
    });
  } catch (e) {
    return { orgId, ok: false, motivo: `no respondio: ${String(e.message).slice(0, 140)}`, aInstalar, aEliminar };
  }

  const cuerpo = await resp.text();
  if (!resp.ok) return { orgId, ok: false, motivo: `HTTP ${resp.status}`, aInstalar, aEliminar };

  const listaFinal = _leerListaFinal(cuerpo);
  if (!listaFinal) {
    return { orgId, ok: false, motivo: "se actualizo pero no reporto su lista final (SKILLS_FINAL)", aInstalar, aEliminar };
  }

  // Se anota lo que ELLA dice tener, no lo que creemos haberle mandado.
  await supabase.from("openclaw_instances")
    .update({ skills_installed: listaFinal, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId);

  const faltan = biblioteca.filter((s) => !listaFinal.includes(s));
  const sobran = listaFinal.filter((s) => !biblioteca.includes(s));
  return {
    orgId, ok: true, via: "autoactualizacion",
    skills: listaFinal.length, instalo: aInstalar.length, borro: aEliminar.length,
    ...(faltan.length ? { aun_faltan: faltan } : {}),
    ...(sobran.length ? { aun_sobran: sobran } : {}),
  };
}
