import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brandId = "a3000000-0000-0000-0000-000000000001";
const orgId   = "a1000000-0000-0000-0000-000000000001";

// Crear trigger brand_indexer
const { data: existing } = await sb.from("monitoring_triggers").select("id").eq("brand_container_id", brandId).eq("sensor_type", "brand_indexer").is("entity_id", null).maybeSingle();
if (!existing) {
  const { data: ins, error } = await sb.from("monitoring_triggers").insert({
    brand_container_id: brandId,
    organization_id:    orgId,
    entity_id:          null,
    sensor_type:        "brand_indexer",
    cadence:            "daily",
    cadence_value:      "1",
    priority:           4,
    status:             "active",
    next_run_at:        new Date().toISOString(),
    config:             { auto_created_by: "brand-indexer-rollout-2026-04-28" },
  }).select("id").maybeSingle();
  console.log("trigger brand_indexer: " + (error ? error.message : "creado " + ins.id));
} else {
  console.log("trigger brand_indexer: ya existe " + existing.id);
}

// Run inicial — invoca directamente el indexer para ver feedback inmediato
console.log("\n--- Ejecutando brand_indexer inicial ---");
const { runBrandIndexer } = await import("./src/services/brand-indexer.service.js");
const t0 = Date.now();
const r = await runBrandIndexer(brandId, orgId);
console.log("Duración: " + (Date.now() - t0) + "ms");
console.log("Resultado: " + JSON.stringify(r, null, 2));

// Verificar
const { count } = await sb.from("ai_brand_vectors").select("*", { count: "exact", head: true }).eq("brand_container_id", brandId);
console.log("\nai_brand_vectors total: " + (count || 0));

const { data: byBucket } = await sb.from("ai_brand_vectors").select("source_bucket, source_type").eq("brand_container_id", brandId);
const grouped = {};
for (const v of byBucket || []) {
  const k = v.source_bucket + "/" + v.source_type;
  grouped[k] = (grouped[k] || 0) + 1;
}
console.log("\nbreakdown por bucket/type:");
for (const [k, n] of Object.entries(grouped).sort()) console.log("  " + k.padEnd(40) + " " + n);

// Sample: vector de la primera fila
const { data: sample } = await sb.from("ai_brand_vectors").select("source_bucket, source_type, content, metadata").eq("brand_container_id", brandId).limit(1);
if (sample?.[0]) {
  const s = sample[0];
  console.log("\nSample chunk:");
  console.log("  " + s.source_bucket + "/" + s.source_type);
  console.log("  content: " + (s.content || "").slice(0, 120) + "...");
  console.log("  metadata: " + JSON.stringify(s.metadata));
}

// Test de búsqueda semántica: ¿funciona la similitud?
console.log("\n--- TEST de búsqueda semántica ---");
const queryText = "¿cuál es la filosofía creativa de la marca?";
const queryRes = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
  body: JSON.stringify({ model: "text-embedding-3-large", input: queryText, dimensions: 1536 }),
});
const queryEmb = (await queryRes.json()).data?.[0]?.embedding;

// pgvector cosine similarity via Supabase (necesita función rpc o sql directo)
// Alternativa: traer vectores y calcular en JS (5 vectores, OK para test)
const { data: allVecs } = await sb.from("ai_brand_vectors").select("source_bucket, source_type, content, embedding").eq("brand_container_id", brandId).limit(50);

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const ranked = (allVecs || [])
  .map((v) => ({
    bucket: v.source_bucket,
    type: v.source_type,
    content: v.content,
    score: cosineSim(JSON.parse("[" + v.embedding.toString() + "]") || v.embedding, queryEmb),
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

console.log("Query: \"" + queryText + "\"");
console.log("Top 5 más similares:");
for (const r of ranked) {
  console.log("  [" + r.score.toFixed(3) + "] " + r.bucket + "/" + r.type + ": " + (r.content || "").slice(0, 100).replace(/\n/g, " "));
}
