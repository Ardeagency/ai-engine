/**
 * Prompt Resolver — FEAT-034 (prompts dinamicos por tenant, sin deformar).
 * Tecnica: "golden template" + structured outputs. El LLM SOLO llena campos creativos
 * (schema estricto); el esqueleto/NEGATIVE/CAMERA quedan verbatim; la identidad de
 * producto viene de DATA del tenant. Guardrail: si las secciones frozen no quedan
 * intactas o el schema falla -> fallback al prompt estatico original.
 *
 * FEAT-034b (RAG): antes de generar, recupera conocimiento de direccion de arte
 * curado de ARDE desde ai_global_vectors (composicion/luz/color/anti-patrones/metodo)
 * y lo inyecta como PLAYBOOK para que el prompt NO dependa al 100% del ejemplo oro y
 * salga profesional + VARIADO sin importar el input. Gateado por PROMPT_RAG_ENABLED
 * (default ON); fail-open al comportamiento previo.
 * Ver [[project-prompts-dinamicos-agente]] + [[feedback-brand-spec-no-dump]].
 */
import { chatCompletion } from "../lib/openai.js";
import { retrieveCreativeKnowledge } from "./creative-knowledge.service.js";

const RAG_ENABLED = process.env.PROMPT_RAG_ENABLED !== "false";

// Rellena {{key}} en un string desde un objeto de valores.
function fill(tpl, vals) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vals ? String(vals[k]) : `{{${k}}}`));
}

// Limpia valores de PRODUCT LOCK que se insertan a mitad de frase del skeleton:
// quita espacios y puntuacion final para evitar dobles puntos ("energy drink.." / "can. geometry").
function cleanLock(v) {
  return String(v ?? "").trim().replace(/\s*[.,;:]+\s*$/, "");
}

/**
 * Resuelve UN slot de prompt (imagen o video).
 * slot imagen = { node, prompt_field, skeleton, frozen, product_keys, creative_schema, golden, static_fallback }
 * slot video  = { node, kind:'video', derives_from:'<nodo imagen>', prompt_field, skeleton, frozen, creative_schema, static_fallback }
 * ctx = { product, products, brandBrief, hardConstraints, knowledgeBlock?, userDirection?, scenesByNode? }
 *   userDirection = { escenario, props, movimiento_video }  (variables que el usuario eligio en el Studio)
 * Retorna { node, field, prompt, dynamic, grounded, kind }
 */
export async function resolveSlot(slot, ctx = {}) {
  const isVideo = slot.kind === "video";
  const product = ctx.product || {};
  const hasProductData = product && typeof product === "object" && Object.keys(product).length > 0;
  const ud = ctx.userDirection || {};

  // product_keys (PRODUCT LOCK, solo imagen): presentes se respetan; faltantes los extrae el LLM de la data real.
  const presentVals = {}; const toExtract = [];
  for (const k of slot.product_keys || []) {
    const v = product[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") presentVals[k] = cleanLock(v);
    else toExtract.push(k);
  }

  try {
    const creativeFields = slot.creative_schema?.fields || [];
    const extractFields = (!isVideo && hasProductData) ? toExtract : [];
    const allFields = [...creativeFields, ...extractFields];
    const schema = { type: "object", additionalProperties: false,
      properties: Object.fromEntries(allFields.map(f => [f, { type: "string" }])),
      required: allFields };
    const hasKnowledge = !!(ctx.knowledgeBlock && ctx.knowledgeBlock.trim());

    let sys, user;
    if (isVideo) {
      // VIDEO (i2v): anima un frame YA producido -> el prompt describe MOVIMIENTO, no re-direcciona la escena.
      const scene = ctx.scenesByNode?.[String(slot.derives_from)] || "";
      const dirVideo = ud.movimiento_video ? `MOVIMIENTO pedido por el usuario (respetar): ${ud.movimiento_video}` : "";
      sys = (slot.system_prompt ||
        "Eres director de cinematografia de ARDE para video de producto image-to-video. El video ANIMA un primer frame YA producido: NO cambies producto, branding, escena, luz ni composicion. " +
        "scene_anchor = resumen FIEL y breve en ingles de lo que se ve en el frame (producto + escena), tomado de la ESCENA dada; no inventes elementos. " +
        "camera_movement + action = movimiento de camara y micro-accion cinematografica, sutil y fotorrealista, coherente con la escena.") +
        (hasKnowledge ? "\n\nUsa el PLAYBOOK ARDE (camara/encuadre) como criterio y VARIA el enfoque entre tomas." : "") +
        (dirVideo ? "\n\nSi el usuario pidio un movimiento, hazlo el movimiento principal." : "");
      user =
        (hasKnowledge ? `PLAYBOOK ARDE (camara/movimiento a APLICAR):\n${ctx.knowledgeBlock}\n\n` : "") +
        `ESCENA YA PRODUCIDA (primer frame a animar):\n${scene || "(hero shot del producto sobre fondo monocromatico)"}\n\n` +
        `PRODUCTO:\n${JSON.stringify(product, null, 2)}\n` +
        (dirVideo ? `\n${dirVideo}\n` : "") +
        `\nGenera ${creativeFields.join(", ")} para animar ESTE frame. Movimiento sutil y cinematografico, sin alterar nada del frame.`;
    } else {
      // IMAGEN: golden template + RAG + extraccion de PRODUCT LOCK + direccion del usuario (escenario/props).
      const dirImage = [
        ud.escenario ? `ESCENARIO pedido por el usuario: ${ud.escenario}` : "",
        ud.props ? `PROPS pedidos por el usuario: ${ud.props}` : "",
      ].filter(Boolean).join("\n");
      sys = (slot.system_prompt ||
        "Eres director de arte de ARDE. Generas los campos creativos de un prompt de foto de producto, imitando EXACTAMENTE estilo, detalle y formato del ejemplo. Fondo = gradiente monocromatico matching al color del producto. Props coherentes con el mundo del producto. Mismo largo y riqueza que el ejemplo.") +
        (hasKnowledge ? "\n\nAplica el PLAYBOOK ARDE de abajo como CRITERIO profesional para decidir composicion, luz y color. El EJEMPLO es solo referencia de formato y nivel: NO lo copies literal — propon una variante fresca apoyada en el playbook." : "") +
        (extractFields.length ? `\n\nLos campos ${extractFields.join(", ")} son PRODUCT LOCK: EXTRAELOS FIELMENTE de los datos del PRODUCTO (caracteristicas_visuales, tipo, nombre, materiales). NO inventes — describe el producto REAL en frase corta en ingles (ej. product_finish: "matte black soft-touch aluminum").` : "") +
        (dirImage ? "\n\nIntegra la DIRECCION DEL USUARIO (escenario/props) si se indica, combinandola con el playbook de forma coherente." : "");
      const knowledge = hasKnowledge
        ? `PLAYBOOK ARDE (conocimiento de direccion de arte a APLICAR, no a copiar textual):\n${ctx.knowledgeBlock}\n\n`
        : "";
      const exampleLabel = hasKnowledge ? "EJEMPLO (referencia de formato y nivel, NO a calcar)" : "EJEMPLO (estilo a imitar)";
      user = knowledge +
        `${exampleLabel}:\n${JSON.stringify(slot.golden, null, 2)}\n\nPRODUCTO NUEVO:\n${JSON.stringify(product, null, 2)}\n` +
        (ctx.brandBrief ? `\nBRIEF DE MARCA:\n${ctx.brandBrief}\n` : "") +
        (ctx.hardConstraints ? `\nRESTRICCIONES (cumplir):\n${ctx.hardConstraints}\n` : "") +
        (dirImage ? `\nDIRECCION DEL USUARIO:\n${dirImage}\n` : "") +
        `\nGenera los campos creativos (${creativeFields.join(", ")}) para ESTE producto` +
        (extractFields.length ? `, y EXTRAE fielmente de la data del producto: ${extractFields.join(", ")}` : "") + "." +
        (hasKnowledge
          ? " Aplica el PLAYBOOK para decisiones de composicion/luz/color profesionales y VARIADAS; el ejemplo es solo referencia, no lo repitas literal."
          : " Mismo estilo y calidad que el ejemplo.");
    }

    const { content } = await chatCompletion({
      model: slot.model || "gpt-4o", temperature: 0.8, max_tokens: 1100,
      response_format: { type: "json_schema", json_schema: { name: "creative", strict: true, schema } },
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    const gen = JSON.parse(content);
    // En video los campos creativos van a mitad de frase del skeleton -> limpiar puntuacion final.
    const creative = {}; for (const f of creativeFields) creative[f] = isVideo ? cleanLock(gen[f]) : (gen[f] ?? "");
    const extracted = {}; for (const f of extractFields) extracted[f] = cleanLock(gen[f]);
    const blanks = {}; if (!isVideo && !hasProductData) for (const k of toExtract) blanks[k] = "";

    const prompt = fill(slot.skeleton, { ...slot.frozen, ...presentVals, ...blanks, ...extracted, ...creative });

    // GUARDRAIL: todas las secciones frozen deben quedar verbatim
    for (const [k, v] of Object.entries(slot.frozen || {})) {
      if (v && !prompt.includes(v)) throw new Error(`frozen perdido: ${k}`);
    }
    if (/\{\{\w+\}\}/.test(prompt)) throw new Error("placeholders sin llenar");
    return { node: slot.node, field: slot.prompt_field || "prompt", prompt, dynamic: true, grounded: hasKnowledge, kind: isVideo ? "video" : "image" };
  } catch (e) {
    // fallback seguro: prompt estatico original (nunca peor que hoy)
    console.warn(`prompt-resolver: slot ${slot.node} fallback (${e.message})`);
    return { node: slot.node, field: slot.prompt_field || "prompt", prompt: slot.static_fallback || "", dynamic: false, error: e.message, kind: isVideo ? "video" : "image" };
  }
}

/**
 * Resuelve todos los slots de un flow -> bindings set_widget de prompt por nodo.
 * DOS PASADAS: primero las imagenes (escenas), luego los videos ANCLADOS a la escena
 * que cada uno anima (slot.derives_from) — porque antes de animar siempre se produce la escena.
 */
export async function resolvePromptBindings(promptSlots = [], ctx = {}) {
  const imageSlots = (promptSlots || []).filter(s => s.kind !== "video");
  const videoSlots = (promptSlots || []).filter(s => s.kind === "video");

  // PASADA 1 — imagenes (playbook de IMAGEN: composicion/luz/color)
  let imgCtx = ctx;
  if (RAG_ENABLED) {
    const { block, used } = await retrieveCreativeKnowledge({ ...ctx, productionType: "image" });
    if (block) { imgCtx = { ...ctx, knowledgeBlock: block }; console.log(`prompt-resolver: playbook IMAGEN (${used.length}: ${used.map(u => u.type).join(",")})`); }
  }
  const imageResults = await Promise.all(imageSlots.map(s => resolveSlot(s, imgCtx)));
  const scenesByNode = {};
  for (const r of imageResults) if (r.prompt) scenesByNode[String(r.node)] = r.prompt;

  // PASADA 2 — videos (playbook de VIDEO: camara/movimiento + la escena hermana ya resuelta)
  let videoResults = [];
  if (videoSlots.length) {
    let vidCtx = { ...ctx, scenesByNode };
    if (RAG_ENABLED) {
      const { block, used } = await retrieveCreativeKnowledge({ ...ctx, productionType: "video" });
      if (block) { vidCtx = { ...vidCtx, knowledgeBlock: block }; console.log(`prompt-resolver: playbook VIDEO (${used.length}: ${used.map(u => u.type).join(",")})`); }
    }
    videoResults = await Promise.all(videoSlots.map(s => resolveSlot(s, vidCtx)));
  }

  const results = [...imageResults, ...videoResults];
  const bindings = {};
  for (const r of results) {
    if (r.prompt) bindings[`__prompt_${r.node}`] = { action: "set_widget", widget: r.field, nodes: [Number(r.node)], value: r.prompt };
  }
  return { bindings, results };
}
