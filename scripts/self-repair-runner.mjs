/**
 * self-repair-runner.mjs — reparador DESACOPLADO del sintetizador de Vera.
 *
 * Lo lanza `self-repair.service.js` con `nohup node --env-file=.env
 * scripts/self-repair-runner.mjs <errorId>`. Corre FUERA del proceso ai-engine
 * para sobrevivir al `systemctl restart`.
 *
 * Flujo (núcleo de seguridad NO negociable):
 *   1. Backup de los archivos del sintetizador (allowlist).
 *   2. Snapshot de `git diff --name-only` (para detectar si Claude tocó algo fuera).
 *   3. Claude Code (-p, headless) adapta el sintetizador al formato de Vera.
 *   4. Verifica que SOLO cambió la allowlist; si no → rollback.
 *   5. `node --check` de los archivos cambiados; si falla → rollback.
 *   6. systemctl restart ai-engine.
 *   7. Verifica boot-guard ("phase↔registry OK", sin FATAL) + is-active + /health.
 *      OK → status=repaired, breaker=0.  FALLA → rollback + restart → status=rollback, breaker++.
 *
 * Solo se le permite editar el SINTETIZADOR (validador/parser/catálogo de formato).
 */
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { supabase } from "../src/lib/supabase.js";

const ROOT = "/root/ai-engine";
const ALLOWLIST = [
  "src/lib/tool-call.validator.js",
  "src/services/openclaw.adapter.js",
  "src/lib/tool-catalog.js",
];
const BACKUP_DIR = `/root/ai-engine/backups/self-repair-${Date.now()}`;
const errorId = process.argv[2];

function log(m) { console.log(`[self-repair ${new Date().toISOString()}] ${m}`); }
async function setStatus(fields) {
  await supabase.from("vera_synth_errors").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", errorId);
}
async function bumpBreaker(rollback) {
  const { data: st } = await supabase.from("vera_repair_state").select("*").eq("id", 1).maybeSingle();
  const cr = rollback ? (st?.consecutive_rollbacks || 0) + 1 : 0;
  await supabase.from("vera_repair_state").update({
    consecutive_rollbacks: cr, breaker_open: cr >= 2, updated_at: new Date().toISOString(),
  }).eq("id", 1);
  if (cr >= 2) log("CIRCUIT BREAKER ABIERTO — 2 rollbacks seguidos. Auto-repair pausado.");
}
// Backup del scope editable (src/lib + src/services) para poder restaurar
// CUALQUIER archivo que Claude toque, no solo la allowlist.
const BACKUP_SCOPE = ["src/lib", "src/services"];
function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const rel of BACKUP_SCOPE) {
    execSync(`cp -a "${path.join(ROOT, rel)}" "${path.join(BACKUP_DIR, rel.replace(/\//g, "__"))}"`);
  }
}
// Restaura una lista de archivos (rel a ROOT) desde el backup.
function restoreFiles(relFiles) {
  for (const f of relFiles) {
    const scope = BACKUP_SCOPE.find((s) => f.startsWith(s + "/"));
    if (!scope) continue;
    const bak = path.join(BACKUP_DIR, scope.replace(/\//g, "__"), path.relative(scope, f));
    if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(ROOT, f));
  }
}
// Snapshot de mtime+size de todos los .js bajo src/ — robusto sin importar git.
function snapshotTree() {
  const map = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "node_modules") walk(full); }
      else if (ent.name.endsWith(".js")) {
        const st = fs.statSync(full);
        map.set(path.relative(ROOT, full), `${st.mtimeMs}:${st.size}`);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return map;
}
function changedFiles(before, after) {
  const out = [];
  for (const [f, sig] of after) if (before.get(f) !== sig) out.push(f);
  return out;
}
function restart() { execSync("systemctl restart ai-engine.service", { stdio: "ignore" }); }
function healthy() {
  try {
    const active = execSync("systemctl is-active ai-engine.service", { encoding: "utf8" }).trim();
    if (active !== "active") return false;
    const jr = execSync(`journalctl -u ai-engine.service --since "40 sec ago" --no-pager`, { encoding: "utf8" });
    if (/FATAL/.test(jr)) return false;
    if (!/phase↔registry OK/.test(jr)) return false;
    const code = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 6 http://127.0.0.1:3000/`, { encoding: "utf8" }).trim();
    return code === "200";
  } catch { return false; }
}
function sleep(ms) { execSync(`sleep ${Math.ceil(ms / 1000)}`); }

(async () => {
  if (!errorId) { log("falta errorId"); process.exit(1); }
  const { data: err } = await supabase.from("vera_synth_errors").select("*").eq("id", errorId).maybeSingle();
  if (!err) { log("error no encontrado"); process.exit(1); }
  log(`reparando error ${errorId} tool=${err.tool_name} reason="${err.reason}"`);

  backup();
  const before = snapshotTree();

  const prompt = [
    "Eres el reparador del SINTETIZADOR de Vera (la capa que valida/parsea las tool-calls del agente).",
    "Vera (el agente) emitió una tool-call con un formato LEGÍTIMO que el sintetizador rechazó por error.",
    "",
    `Tool: ${err.tool_name}`,
    `Razón del rechazo: ${err.reason}`,
    `Payload que Vera envió (JSON): ${JSON.stringify(err.rejected_payload).slice(0, 2000)}`,
    "",
    "TAREA: adapta el sintetizador para que ACEPTE el formato que Vera necesita usar.",
    "REGLAS ESTRICTAS:",
    "1. Edita SOLO estos archivos: " + ALLOWLIST.join(", ") + ". Ningún otro.",
    "2. NO debilites la seguridad: mantén las protecciones contra <script> (XSS), __proto__/prototype (pollution) y SQL en campos estructurados. Solo relaja la regla que produjo el falso positivo, idealmente acotándola al campo de texto libre específico.",
    "3. Cambio MÍNIMO y quirúrgico. No refactorices.",
    "4. Al terminar, corre `node --check` sobre cada archivo que edites y corrige si hay error de sintaxis.",
    "Devuelve un resumen de una línea de qué cambiaste.",
  ].join("\n");

  let claudeOut = "";
  try {
    const res = spawnSync("claude", [
      "-p", prompt,
      "--allowedTools", "Edit", "Read", "Bash(node --check*)",
      "--add-dir", path.join(ROOT, "src/lib"), "--add-dir", path.join(ROOT, "src/services"),
      "--permission-mode", "acceptEdits", "--model", "sonnet",
      "--max-budget-usd", "1.50", "--output-format", "json",
    ], { cwd: ROOT, encoding: "utf8", timeout: 240000, env: { ...process.env } });
    claudeOut = (res.stdout || "") + (res.stderr || "");
    try { const j = JSON.parse(res.stdout); if (j.result) log(`claude: ${String(j.result).slice(0, 200)}`); } catch {}
  } catch (e) { log(`claude error: ${e.message}`); }

  // Verificar que SOLO tocó la allowlist (detección por contenido, no git)
  const after = snapshotTree();
  const newlyChanged = changedFiles(before, after);
  const outside = newlyChanged.filter((f) => !ALLOWLIST.includes(f));
  if (outside.length) {
    log(`ABORT: Claude tocó archivos fuera de la allowlist: ${outside.join(", ")} → restore total`);
    restoreFiles(newlyChanged);
    await setStatus({ status: "rollback", repair_summary: `tocó fuera de allowlist: ${outside.join(",")}`, files_changed: newlyChanged.join(",") });
    await bumpBreaker(true);
    process.exit(0);
  }
  if (newlyChanged.length === 0) {
    log("Claude no cambió nada → failed (no-op)");
    await setStatus({ status: "failed", repair_summary: "sin cambios" });
    process.exit(0);
  }

  // node --check de los cambiados
  for (const f of newlyChanged) {
    const chk = spawnSync("node", ["--check", path.join(ROOT, f)], { encoding: "utf8" });
    if (chk.status !== 0) {
      log(`syntax error en ${f} → rollback`);
      restoreFiles(newlyChanged);
      await setStatus({ status: "rollback", repair_summary: `syntax error en ${f}`, files_changed: newlyChanged.join(",") });
      await bumpBreaker(true);
      process.exit(0);
    }
  }

  // Restart + verificar
  log(`cambios OK en ${newlyChanged.join(", ")} → restart + verificación`);
  restart();
  sleep(7000);
  if (healthy()) {
    log("HEALTHY tras el fix → status=repaired");
    await setStatus({ status: "repaired", repair_summary: `adaptado: ${newlyChanged.join(",")}`, files_changed: newlyChanged.join(",") });
    await bumpBreaker(false);
  } else {
    log("NO HEALTHY tras el fix → ROLLBACK");
    restoreFiles(newlyChanged);
    restart();
    sleep(7000);
    const ok = healthy();
    await setStatus({ status: "rollback", repair_summary: `fix rompió el boot; rollback ${ok ? "OK" : "PERO server no recuperó!"}`, files_changed: newlyChanged.join(",") });
    await bumpBreaker(true);
    log(ok ? "rollback OK, server recuperado" : "ATENCIÓN: server no recuperó tras rollback");
  }
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
