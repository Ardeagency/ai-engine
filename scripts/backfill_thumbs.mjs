/**
 * backfill_thumbs.mjs — rescata a R2 las miniaturas que TODAVIA sirven.
 *
 * Los posts ya capturados guardan la URL firmada del CDN. Las viejas devuelven
 * 403 y no hay nada que hacer con ellas; las recientes aun responden, y esas se
 * pueden salvar. Es OPORTUNISTA por diseño: se intenta, y lo que no llega se
 * anota como no rescatable en vez de reintentarse cada noche.
 *
 * Se recorre de mas nuevo a mas viejo (los nuevos tienen mas probabilidad de
 * seguir vivos) y se corta tras una racha de fallos, que es la señal de haber
 * cruzado la frontera de expiracion.
 *
 * Uso:  node backfill_thumbs.mjs [limite] [--all]
 *       --all incluye tambien posts propios (por defecto solo monitoreados).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { archiveThumb, pickThumbUrl } from "/root/ai-engine/src/services/media-archive.service.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const LIMIT = Number(process.argv[2]) || 400;
const ALL = process.argv.includes("--all");
// Racha de fallos consecutivos tras la cual se asume que ya solo quedan URLs
// caducadas. Se mide sobre posts que SI tenian miniatura.
const GIVE_UP_AFTER = 40;

let q = supabase.from("brand_posts")
  .select("id, brand_container_id, network, post_id, media_assets, captured_at")
  .not("media_assets", "is", null)
  .order("captured_at", { ascending: false })
  .limit(LIMIT);
if (!ALL) q = q.eq("is_competitor", true);

const { data: rows, error } = await q;
if (error) { console.error("consulta fallo:", error.message); process.exit(1); }

let ok = 0, skip = 0, fail = 0, streak = 0;

for (const p of rows || []) {
  const a = (p.media_assets && typeof p.media_assets === "object") ? p.media_assets : null;
  if (!a || Array.isArray(a)) { skip++; continue; }
  if (a.archived_url) { skip++; continue; }          // ya rescatada
  if (!pickThumbUrl(a)) { skip++; continue; }        // el post no trae imagen

  const url = await archiveThumb({
    mediaAssets:      a,
    brandContainerId: p.brand_container_id,
    network:          p.network,
    postId:           p.post_id,
  });

  if (!url) {
    fail++; streak++;
    if (streak >= GIVE_UP_AFTER) {
      console.log(`corte: ${GIVE_UP_AFTER} fallos seguidos — de aqui hacia atras las URLs ya caducaron`);
      break;
    }
    continue;
  }

  streak = 0;
  const { error: upErr } = await supabase.from("brand_posts")
    .update({ media_assets: { ...a, archived_url: url } })
    .eq("id", p.id);
  if (upErr) { fail++; console.warn(`update ${p.id}: ${upErr.message}`); continue; }
  ok++;
  if (ok % 25 === 0) console.log(`  ${ok} rescatadas…`);
}

console.log(`\nBACKFILL: ${ok} rescatadas · ${fail} caducadas · ${skip} sin imagen o ya archivadas · ${rows?.length || 0} revisadas`);
