/**
 * self-repair.service.js — DETECTOR de errores del sintetizador (in-process).
 *
 * Corre en un timer. Cuando hay un rechazo del sintetizador capturado en
 * `vera_synth_errors` (status=open), lanza el RUNNER DESACOPLADO
 * (scripts/self-repair-runner.mjs) que adapta el sintetizador con Claude Code y
 * reinicia/verifica/rollback. El detector NO reinicia nada por sí mismo (se
 * mataría); solo dispara el runner detached y lo deja correr.
 *
 * Guardas: env-gate, circuit-breaker, tope por hora, una reparación a la vez,
 * y no reintenta firmas que ya terminaron en rollback/failed.
 *
 * Activar con SELF_REPAIR_ENABLED=true.
 */
import { spawn } from "child_process";
import { supabase } from "../lib/supabase.js";

const ENABLED       = process.env.SELF_REPAIR_ENABLED === "true";
const INTERVAL_MS   = Number(process.env.SELF_REPAIR_INTERVAL_MS) || 120000; // 2 min
const MAX_PER_HOUR  = Number(process.env.SELF_REPAIR_MAX_PER_HOUR) || 3;
// Cuántas veces se puede "reparar" la MISMA firma en 24h antes de rendirse. Cierra
// el loop: un fix marcado 'repaired' que NO frena el rechazo hace que la firma
// reaparezca; sin este tope se re-reparaba y re-reiniciaba en bucle (hasta
// MAX_PER_HOUR/h). Al alcanzarlo: skip + abrir breaker para que un humano mire.
const MAX_SIG_REPAIRS = Number(process.env.SELF_REPAIR_MAX_SIGNATURE_RETRIES) || 2;
const ROOT          = "/root/ai-engine";

let _timer = null;
let _busy  = false;

async function tick() {
  if (_busy) return;
  _busy = true;
  try {
    // 0. Circuit breaker
    const { data: st } = await supabase.from("vera_repair_state").select("*").eq("id", 1).maybeSingle();
    if (st?.breaker_open) return;

    // 1. No correr si ya hay una reparación en curso
    const { data: inflight } = await supabase.from("vera_synth_errors")
      .select("id").eq("status", "repairing").limit(1);
    if (inflight && inflight.length) return;

    // 2. Tope por hora
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabase.from("vera_synth_errors")
      .select("id", { count: "exact", head: true })
      .in("status", ["repaired", "rollback"]).gte("updated_at", hourAgo);
    if ((count || 0) >= MAX_PER_HOUR) return;

    // 3. Tomar el error abierto más antiguo cuya firma no haya fracasado antes
    const { data: open } = await supabase.from("vera_synth_errors")
      .select("id, signature").eq("status", "open").order("created_at", { ascending: true }).limit(5);
    if (!open || !open.length) return;

    const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
    let target = null;
    for (const e of open) {
      // (a) firma que YA fracasó (rollback/failed) → no reintentar nunca.
      const { data: prior } = await supabase.from("vera_synth_errors")
        .select("id").eq("signature", e.signature).in("status", ["rollback", "failed"]).limit(1);
      if (prior && prior.length) {
        await supabase.from("vera_synth_errors").update({ status: "skipped", updated_at: new Date().toISOString() }).eq("id", e.id);
        continue; // firma ya fracasó antes — no reintentar (evita loops)
      }
      // (b) firma "reparada" >= MAX_SIG_REPAIRS veces en 24h y SIGUE reapareciendo:
      //     el fix no pega. Dejar de reintentar (marcar skipped) y ABRIR el breaker
      //     para que un humano mire — en vez de re-reparar/reiniciar en bucle.
      const { count: repairedTimes } = await supabase.from("vera_synth_errors")
        .select("id", { count: "exact", head: true })
        .eq("signature", e.signature).eq("status", "repaired").gte("updated_at", dayAgo);
      if ((repairedTimes || 0) >= MAX_SIG_REPAIRS) {
        await supabase.from("vera_synth_errors")
          .update({ status: "skipped", repair_summary: `reparada ${repairedTimes}x/24h y sigue fallando — loop-guard, requiere humano`, updated_at: new Date().toISOString() })
          .eq("id", e.id);
        await supabase.from("vera_repair_state")
          .update({ breaker_open: true, updated_at: new Date().toISOString() }).eq("id", 1);
        console.warn(`[self-repair] firma ${e.signature} reparada ${repairedTimes}x sin pegar → breaker ABIERTO, requiere humano`);
        continue;
      }
      target = e; break;
    }
    if (!target) return;

    // 4. Marcar repairing + lanzar runner DESACOPLADO
    await supabase.from("vera_synth_errors").update({ status: "repairing", updated_at: new Date().toISOString() }).eq("id", target.id);
    console.log(`[self-repair] lanzando runner para error ${target.id}`);
    const child = spawn("node", ["--env-file=.env", "scripts/self-repair-runner.mjs", target.id], {
      cwd: ROOT, detached: true, stdio: "ignore", env: { ...process.env },
    });
    child.unref(); // sobrevive al restart que hará el runner
  } catch (e) {
    console.warn("[self-repair] tick error:", e.message);
  } finally {
    _busy = false;
  }
}

export function startSelfRepair() {
  if (!ENABLED) { console.log("self-repair: deshabilitado (SELF_REPAIR_ENABLED!=true)"); return; }
  console.log(`self-repair: detector iniciado (cada ${INTERVAL_MS / 60000}min, máx ${MAX_PER_HOUR}/h, primera corrida en 60s)`);
  setTimeout(tick, 60000);
  _timer = setInterval(tick, INTERVAL_MS);
}
