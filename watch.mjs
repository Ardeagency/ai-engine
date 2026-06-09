import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sinceISO = new Date().toISOString();
const sinceJournal = execSync("date '+%Y-%m-%d %H:%M:%S'").toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("WATCH iniciado", sinceISO, "— esperando job source=studio...");

let job = null;
for (let i = 0; i < 180 && !job; i++) { // 15 min esperando el Run
  const { data } = await sb.from("comfy_flow_jobs").select("id,status,flow_slug,output_run_id,created_at")
    .eq("source", "studio").gt("created_at", sinceISO).order("created_at", { ascending: false }).limit(1);
  if (data && data[0]) job = data[0]; else await sleep(5000);
}
if (!job) { console.log("TIMEOUT: no llego ningun job source=studio en 15min. Relanzar watcher si aun no le diste Run."); process.exit(0); }
console.log(`\nJOB DETECTADO: ${job.id}\n  slug=${job.flow_slug} | run=${job.output_run_id} | status=${job.status}`);

let last = null;
for (let i = 0; i < 165; i++) { // ~27 min esperando que termine (3 img + 3 Kling es lento)
  const { data } = await sb.from("comfy_flow_jobs").select("status,error_message").eq("id", job.id).maybeSingle();
  if (data && data.status !== last) { console.log(`  [${new Date().toISOString().slice(11,19)}] status -> ${data.status}`); last = data.status; }
  if (data && (data.status === "completed" || data.status === "failed")) { job = { ...job, ...data }; break; }
  await sleep(10000);
}

console.log("\n=== RESULTADO ===");
console.log("status:", job.status, "| error:", job.error_message || "(none)");
const { count } = await sb.from("runs_outputs").select("*", { count: "exact", head: true }).eq("run_id", job.output_run_id);
console.log("piezas persistidas (runs_outputs):", count, "(esperado: 6 = 3 img + 3 video)");
const { data: outs } = await sb.from("runs_outputs").select("output_type,storage_path,prompt_used").eq("run_id", job.output_run_id);
(outs || []).forEach((o, i) => console.log(`  [${i}] ${o.output_type} | ${o.storage_path ? "OK" : "SIN PATH"} | prompt: ${(o.prompt_used || "").slice(0, 90)}`));
const { data: cf } = await sb.from("content_flows").select("token_cost,credit_pricing_runs_observed,credit_pricing_avg_observed").eq("id", (await sb.from("comfy_flow_definitions").select("content_flow_id").eq("slug", job.flow_slug).maybeSingle()).data?.content_flow_id).maybeSingle();
console.log("\ncredito auto-calibrado -> token_cost:", cf?.token_cost, "| runs_observed:", cf?.credit_pricing_runs_observed, "| avg:", cf?.credit_pricing_avg_observed);
console.log("\n=== JOURNAL runner (ventana de la corrida) ===");
try { console.log(execSync(`journalctl -u ai-engine.service --since '${sinceJournal}' --no-pager | grep -iE 'comfy|playbook|persist|kie|error|runner|dispatcher|prompt-resolver' | tail -80`).toString()); } catch (e) { console.log("journal err:", e.message); }
process.exit(0);
