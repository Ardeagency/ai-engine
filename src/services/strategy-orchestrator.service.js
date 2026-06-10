/**
 * strategy-orchestrator.service.js
 *
 * F1 + F2 de la orquestacion (ver ~/VERA_MARKETING_TEAM_ORCHESTRATION.md).
 * El brain-feed es el project manager: cada ciclo deriva el estado de cada
 * estrategia activa y la empuja al siguiente paso, parando en los gates humanos
 * (que se materializan como Tareas en el panel de Actividad).
 */
import { supabase } from "../lib/supabase.js";

// Maquina de estados de una estrategia
export const STRATEGY_STATES = {
  PLANIFICADA:    "planificada",     // brief listo, sin producir -> siguiente: producir
  PRODUCIENDO:    "produciendo",     // flows generando outputs
  LISTA_PUBLICAR: "lista_publicar",  // producciones listas, sin publicar -> GATE humano
  EN_VIVO:        "en_vivo",         // publicada (organico) o pauta lanzada
  MIDIENDO:       "midiendo",        // recibiendo metricas (post-publicacion)
};

/**
 * Deriva la etapa de una estrategia leyendo sus nodos + producciones tagueadas
 * (FEAT-037) + publicaciones. Retorna estado + contadores + ids para el orquestador.
 */
export async function deriveStrategyState(strategyId) {
  const { data: placements } = await supabase
    .from("canvas_node_placements")
    .select("node_type, node_id")
    .eq("strategy_id", strategyId);

  const byType = {};
  for (const p of placements || []) (byType[p.node_type] ||= []).push(p.node_id);
  const briefIds    = byType.brief || [];
  const campaignIds = byType.campaign || [];

  const base = { strategy_id: strategyId, briefIds, campaignIds, productions: 0, completed: 0, published: 0 };

  // Sin brief ni campana => todavia armandose
  if (!briefIds.length && !campaignIds.length) {
    return { ...base, state: STRATEGY_STATES.PLANIFICADA };
  }

  // Producciones de la estrategia (tagueadas por brief_id o campaign_id)
  const ors = [];
  if (briefIds.length)    ors.push(`brief_id.in.(${briefIds.join(",")})`);
  if (campaignIds.length) ors.push(`campaign_id.in.(${campaignIds.join(",")})`);
  let productions = [];
  if (ors.length) {
    const { data } = await supabase
      .from("runs_outputs")
      .select("id, status, published_at")
      .or(ors.join(","));
    productions = data || [];
  }
  const prodIds   = productions.map((p) => p.id);
  const completed = productions.filter((p) => p.status === "completed").length;

  // Publicadas: organico (social_publications.status=published) + pauta (published_at)
  let organicPublished = 0;
  if (prodIds.length) {
    const { data: pubs } = await supabase
      .from("social_publications")
      .select("id")
      .in("output_id", prodIds)
      .eq("status", "published");
    organicPublished = (pubs || []).length;
  }
  const paidPublished  = productions.filter((p) => p.published_at).length;
  const totalPublished = organicPublished + paidPublished;

  let state;
  if (productions.length === 0)   state = STRATEGY_STATES.PLANIFICADA;     // listo para producir
  else if (totalPublished > 0)    state = STRATEGY_STATES.EN_VIVO;         // ya hay algo publicado
  else if (completed > 0)         state = STRATEGY_STATES.LISTA_PUBLICAR;  // listas, sin publicar -> GATE
  else                            state = STRATEGY_STATES.PRODUCIENDO;     // generandose

  return { ...base, state, productions: productions.length, completed, published: totalPublished, prodIds };
}

/**
 * F2: lista las estrategias activas de una marca con su estado derivado, para que
 * el brain-feed se las entregue a Vera y ella ejecute el siguiente paso de cada una
 * (Vera elige el flow/decision en runtime; el orquestador solo da el estado).
 */
export async function listActiveStrategiesWithState(brandContainerId, limit = 8) {
  const { data: strategies } = await supabase
    .from("canvas_strategies")
    .select("id, name, updated_at")
    .eq("brand_container_id", brandContainerId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  const out = [];
  for (const st of strategies || []) {
    try {
      const s = await deriveStrategyState(st.id);
      out.push({ id: st.id, name: st.name, state: s.state, productions: s.productions, completed: s.completed, published: s.published, brief_id: (s.briefIds || [])[0] || null, campaign_id: (s.campaignIds || [])[0] || null });
    } catch (_) { /* estrategia rota; saltar */ }
  }
  return out;
}
