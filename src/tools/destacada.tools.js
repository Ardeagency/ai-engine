/**
 * Publicación destacada — la pieza que más movió al público, con TODO su cuadro.
 *
 * POR QUE EXISTE: `getTopHighlightedPosts` no sirve para juzgar una pieza.
 * Devuelve `content_preview` VACIO (Vera no ve el copy), sin comentarios, sin
 * descripcion visual — y rankea por `engagement_total` mientras el tablero
 * re-rankea desde `metrics`. Resultado: podia analizar un post DISTINTO al que
 * el cliente esta viendo en pantalla.
 *
 * Aqui se replica la regla del frontend (BrandGrid._paintTopPostPropio +
 * CompGrid._cgridInteractions) para que Vera juzgue exactamente la misma pieza:
 *   INTERACCION = likes + comentarios + compartidos + guardados + ...
 *   ALCANCE (plays, views) se informa pero NO rankea.
 */
import { supabase } from "../lib/supabase.js";
import { resolveBrandContainer } from "../lib/brand-resolver.js";

// Mismas claves que el frontend. Si divergen, Vera analiza otra pieza.
const CLAVES_INTERACCION = [
  "likes", "comments", "shares", "saves", "reposts", "retweets", "quotes", "bookmarks", "replies",
];
const CLAVES_ALCANCE = ["plays", "views", "video_view_count", "reach", "impressions"];

function _interacciones(p) {
  const m = p?.metrics || {};
  let suma = 0;
  for (const k of CLAVES_INTERACCION) suma += Number(m[k]) || 0;
  return Math.max(suma, Number(p?.engagement_total) || 0);
}

function _alcance(p) {
  const m = p?.metrics || {};
  for (const k of CLAVES_ALCANCE) {
    const v = Number(m[k]) || 0;
    if (v > 0) return { valor: v, campo: k };
  }
  const r = Number(p?.reach_total) || 0;
  return r > 0 ? { valor: r, campo: "reach_total" } : { valor: null, campo: null };
}

const VENTANAS = { week: 7, month: 30, year: 365, all: null };

/**
 * La publicación propia con más INTERACCIONES del periodo, con su cuadro completo.
 *
 * @param {object} p
 * @param {string} p.brandContainerId
 * @param {string} p.organizationId
 * @param {string} [p.periodo] week | month | year | all  (por defecto month)
 */
export async function getPublicacionDestacada({ brandContainerId, organizationId, periodo = "month" }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  const dias = VENTANAS[String(periodo).toLowerCase()];
  if (dias === undefined) {
    throw new Error(`periodo '${periodo}' no existe. Validos: ${Object.keys(VENTANAS).join(", ")}`);
  }

  // La ventana se ancla al ULTIMO post propio, igual que el tablero: contra
  // "hoy" una marca que lleva dos semanas sin publicar sale sin destacada.
  const { data: ultimo } = await supabase
    .from("brand_posts").select("captured_at")
    .eq("brand_container_id", bc.id).eq("post_source", "own")
    .order("captured_at", { ascending: false }).limit(1).maybeSingle();
  const ancla = ultimo?.captured_at ? new Date(ultimo.captured_at) : new Date();
  const desde = dias == null ? null : new Date(ancla.getTime() - dias * 86400000).toISOString();

  let q = supabase.from("brand_posts")
    .select(
      "id, network, profile_handle, author_display_name, content, metrics, " +
      "engagement_total, reach_total, captured_at, permalink, post_id, " +
      "media_assets, hashtags, mentions, unpublished_at, vera_por_que"
    )
    .eq("brand_container_id", bc.id).eq("post_source", "own")
    .order("engagement_total", { ascending: false, nullsFirst: false })
    .limit(40);
  if (desde) q = q.gte("captured_at", desde);
  const { data: filas, error } = await q;
  if (error) throw error;

  const rankeadas = (filas || [])
    .map((p) => ({ p, inter: _interacciones(p) }))
    .filter((x) => x.inter > 0)
    .sort((a, b) => b.inter - a.inter);

  if (!rankeadas.length) {
    return { hay: false, periodo, motivo: "ninguna publicacion propia con interaccion en este periodo" };
  }
  const { p: win, inter } = rankeadas[0];
  const segunda = rankeadas[1] || null;

  // Los comentarios son la voz del publico: sin leerlos no se puede decir POR QUE
  // le gusto. Se traen todos los que haya (el tablero muestra 4, ella los ve todos).
  const { data: comentarios } = await supabase
    .from("brand_post_comments")
    .select("author_handle, content, metrics, sentiment, created_at")
    .eq("brand_post_id", win.id)
    .limit(200);

  const alc = _alcance(win);
  const desc = win.media_assets?.description || null;

  return {
    hay: true,
    periodo,
    ventana: { desde: desde || "sin recorte", hasta: ancla.toISOString() },
    publicacion: {
      id: win.id,
      red: win.network,
      autor: win.author_display_name || win.profile_handle,
      publicada: win.captured_at,
      despublicada: win.unpublished_at || null,
      enlace: win.permalink,
      copy: win.content || "",             // el TEXTO COMPLETO, no un preview
      que_se_ve: desc,                     // descripcion de la imagen o el video
      sin_analisis_visual: !desc,
      media_type: win.media_assets?.media_type || null,
      hashtags: win.hashtags || [],
      menciones: win.mentions || [],
    },
    resultado: {
      interacciones: inter,
      desglose: win.metrics || {},
      alcance: alc.valor,
      alcance_campo: alc.campo,
      alcance_sin_dato: alc.valor == null,
      ventaja_sobre_la_segunda: segunda
        ? `${inter} vs ${segunda.inter} (${(inter / Math.max(segunda.inter, 1)).toFixed(1)}x)`
        : "no hay segunda pieza con interaccion",
    },
    comentarios: {
      total: (comentarios || []).length,
      sin_cosechar: (comentarios || []).length === 0,
      lista: (comentarios || [])
        .map((c) => ({
          quien: c.author_handle,
          dice: c.content,
          likes: Number(c.metrics?.likes) || 0,
          sentimiento: c.sentiment,
        }))
        .sort((a, b) => b.likes - a.likes),
    },
    analisis_previo: win.vera_por_que || null,
    // Un hueco que no dice como taparse se queda abierto. Si falta lo visual o
    // los comentarios, aqui va la tool exacta que los consigue.
    para_completar_el_cuadro: [
      !desc
        ? `esta pieza NO tiene descripcion visual — llama a verPublicacion con postId "${win.id}" antes de juzgar su formato`
        : null,
      !(comentarios || []).length
        ? `esta pieza NO tiene comentarios cosechados — llama a harvestPostComments con postId "${win.id}" y recogelos con getHarvestedComments`
        : null,
    ].filter(Boolean),
    encargo:
      "Para responder POR QUE funciono no basta el numero: lee el copy, mira que_se_ve, " +
      "lee los comentarios y nombra a los protagonistas. Quienes salen, de que trata, que " +
      "tematica toca, como esta hecha, a quien le hablaba. Y que se REPITE la proxima vez. " +
      "Si te falta lo visual o los comentarios, PIDELOS: estan en para_completar_el_cuadro. " +
      "Opinar del formato de algo que no viste es inventar con buena redaccion.",
  };
}

/**
 * Guarda el "¿por qué?" de una publicación. Va PEGADO al post, no al periodo:
 * el tablero re-rankea en vivo, asi que el analisis tiene que viajar con la
 * pieza para que nunca se muestre debajo de otra.
 */
export async function explainPublicacionDestacada({ postId, brandContainerId, organizationId, analisis }) {
  const bc = await resolveBrandContainer(brandContainerId, organizationId);
  if (!postId) throw new Error("postId es requerido — el id de la publicacion que analizaste.");
  const texto = String(analisis || "").trim();
  if (texto.length < 120) {
    throw new Error(
      `El analisis tiene ${texto.length} caracteres y se esperan al menos 120. ` +
      "Un 'por que' de una linea es una etiqueta, no una explicacion: quienes, de que trata, " +
      "que tematica, como esta hecha, a quien le hablaba, y que se repite."
    );
  }
  if (texto.length > 1200) throw new Error("El analisis pasa de 1200 caracteres — es una card, no un informe.");

  const { data, error } = await supabase
    .from("brand_posts")
    .update({ vera_por_que: { texto, escrito_en: new Date().toISOString() } })
    .eq("id", postId).eq("brand_container_id", bc.id)
    .select("id, network, captured_at")
    .maybeSingle();
  if (error) throw new Error(`guardar el porque: ${error.message}`);
  if (!data) throw new Error("esa publicacion no existe o no es de esta marca");

  return { ok: true, postId: data.id, red: data.network, caracteres: texto.length, visible_en: "Publicacion destacada" };
}
