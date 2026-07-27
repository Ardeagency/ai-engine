/**
 * Reconciliacion de posts propios: detectar lo que la marca DESPUBLICO.
 *
 * La fila NO se borra nunca. Un post eliminado es la senal mas fuerte que puede
 * dar un equipo —reconocieron que algo fallo— y Vera tiene que poder preguntarse
 * por que. Borrarlo seria destruir justo la evidencia que interesa.
 *
 * LA TRAMPA QUE ESTO EVITA: las APIs devuelven los ultimos N posts, asi que un
 * post viejo que se cae de la pagina NO esta borrado, simplemente no vino. Por
 * eso solo se concluye dentro de la VENTANA que la respuesta cubre: desde el
 * post mas antiguo que devolvio la API hasta el mas reciente. Fuera de ese rango
 * no se toca nada.
 */
import { supabase } from "../lib/supabase.js";

/**
 * @param {object} p
 * @param {string} p.brandContainerId
 * @param {string} p.network            'instagram' | 'facebook' | 'tiktok' | ...
 * @param {string[]} p.idsVivos         post_id que la API acaba de confirmar publicados
 * @returns {Promise<{marcados:number, ids:string[]}>}
 */
export async function marcarDespublicados({ brandContainerId, network, idsVivos }) {
  const vivos = new Set((idsVivos || []).filter(Boolean).map(String));
  // Sin respuesta no se concluye nada: una API que fallo no es una marca que borro.
  if (!vivos.size) return { marcados: 0, ids: [] };

  const { data: enBase, error } = await supabase
    .from("brand_posts")
    .select("id, post_id, captured_at, content")
    .eq("brand_container_id", brandContainerId)
    .eq("post_source", "own")
    .eq("network", network)
    .is("unpublished_at", null)
    .not("post_id", "is", null);
  if (error) throw new Error(`reconciliacion ${network}: ${error.message}`);
  if (!enBase?.length) return { marcados: 0, ids: [] };

  // La ventana cubierta por la respuesta va del post vivo MAS ANTIGUO hasta AHORA.
  // El tope es "ahora" y no el vivo mas reciente a proposito: si la marca borra su
  // ultima publicacion, esa fecha queda por ENCIMA de todos los vivos y con un tope
  // en el maximo se escaparia justo el caso que mas importa — el borrado reciente.
  const fechasVivas = enBase
    .filter((r) => vivos.has(String(r.post_id)))
    .map((r) => new Date(r.captured_at).getTime())
    .filter((n) => Number.isFinite(n));
  if (!fechasVivas.length) return { marcados: 0, ids: [] };
  const desde = Math.min(...fechasVivas);
  const hasta = Date.now();

  const desaparecidos = enBase.filter((r) => {
    if (vivos.has(String(r.post_id))) return false;
    const t = new Date(r.captured_at).getTime();
    return Number.isFinite(t) && t >= desde && t <= hasta;
  });
  if (!desaparecidos.length) return { marcados: 0, ids: [] };

  const ahora = new Date().toISOString();
  const { error: errUpd } = await supabase
    .from("brand_posts")
    .update({ unpublished_at: ahora, updated_at: ahora })
    .in("id", desaparecidos.map((r) => r.id));
  if (errUpd) throw new Error(`reconciliacion ${network} (update): ${errUpd.message}`);

  for (const r of desaparecidos) {
    console.log(
      `[despublicado] ${network} ${r.post_id} — "${String(r.content || "").replace(/\s+/g, " ").slice(0, 60)}"`
    );
  }
  return { marcados: desaparecidos.length, ids: desaparecidos.map((r) => r.id) };
}

/** Sella como vivos los posts que la API acaba de confirmar. */
export async function sellarVistos({ brandContainerId, network, idsVivos }) {
  const vivos = (idsVivos || []).filter(Boolean).map(String);
  if (!vivos.length) return 0;
  const ahora = new Date().toISOString();
  const { error } = await supabase
    .from("brand_posts")
    .update({ last_seen_at: ahora })
    .eq("brand_container_id", brandContainerId)
    .eq("post_source", "own")
    .eq("network", network)
    .in("post_id", vivos);
  if (error) console.warn(`[despublicado] sellar ${network}: ${error.message}`);
  return vivos.length;
}
