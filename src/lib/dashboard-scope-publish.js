/**
 * dashboard-scope-publish.js — Vera escribe los OTROS tres tabs del tablero.
 *
 * POR QUE EXISTE (2026-07-30): Mi Marca ya lo escribia ella con sus propias
 * tools (`publishMiMarcaCard`), pero Competencia, Tendencias y Estrategia
 * seguian dependiendo de `runDashboardSession` — la topologia vieja, con
 * ai-engine sosteniendo 30 rondas de conversacion por HTTP para extraer el sobre
 * [[DIAGNOSIS]] de su texto. Esa sesion la lanzaba UNICAMENTE el
 * `startDiagnosisScheduler`, que se apago en `.env` el 2026-07-28 despues de
 * encadenar fallos (`org_server_inalcanzable`, `bucle de entrega sin sobre
 * completo`). Resultado medido en WAKEUP: monitoreo 186h, tendencias 309h,
 * estrategia 332h sin actualizar, y Vera SIN NINGUNA HERRAMIENTA para escribirlos
 * aunque hubiera querido. Tres tabs muertos y nadie a quien culpar.
 *
 * Aqui vive lo mismo que en mimarca-publish.js pero para una lectura ENTERA por
 * tab: no hay tarjetas ni borradores, el tab es una sola lectura narrative v1
 * (headline + narrative + evidence) que se reemplaza completa.
 *
 * ai-engine sigue siendo el medio, no el cerebro.
 */
import { supabase } from "./supabase.js";
import { scopeReadingSchema, READING_SCHEMA_VERSION } from "./vera-reading.schema.js";

/** Los tabs que se escriben por aqui. 'mi_marca' NO: tiene productor dedicado. */
export const SCOPES_ESCRIBIBLES = ["monitoreo", "tendencias", "estrategia"];

/** Como se llama cada tab en la pantalla del cliente, para poder nombrarselo. */
export const NOMBRE_TAB = {
  monitoreo: "Competencia",
  tendencias: "Tendencias",
  estrategia: "Estrategia",
};

/**
 * Reemplaza la lectura de UN tab.
 *
 * A diferencia de Mi Marca no hay acumulacion por partes: estas lecturas son un
 * hilo argumental entero —headline, bloques encadenados y su mapa de evidencia—
 * y media lectura no significa la mitad, significa otra cosa. Por eso se publica
 * completa o no se publica.
 */
export async function publicarLecturaScope({
  organizationId, brandContainerId, scope, reading, sessionId, trigger = "vera_autonoma",
}) {
  const sc = String(scope || "").trim().toLowerCase();
  if (!SCOPES_ESCRIBIBLES.includes(sc)) {
    return {
      ok: false,
      motivo: `'${scope}' no es un tab escribible por aqui`,
      detalle: `Validos: ${SCOPES_ESCRIBIBLES.join(", ")} (${SCOPES_ESCRIBIBLES.map((s) => NOMBRE_TAB[s]).join(", ")}). ` +
        "Mi Marca no se escribe aqui: es tarjeta a tarjeta con publishMiMarcaCard.",
    };
  }

  // Se valida en la puerta y con su motivo, igual que las cards: una lectura mala
  // se rechaza aqui —donde Vera puede corregirla— y no ensucia el tablero.
  const v = scopeReadingSchema.safeParse(reading);
  if (!v.success) {
    return {
      ok: false,
      motivo: "la lectura no cumple el contrato narrative v1",
      errores: v.error.issues.slice(0, 12).map(
        (i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`
      ),
      detalle: "No se guardo nada: el tab sigue mostrando la lectura anterior. " +
        "Recuerda que toda referencia evN usada en los bloques tiene que existir en el mapa 'evidence'.",
    };
  }

  // La anterior cede el sitio y queda como historia. El supersede es POR SCOPE:
  // publicar Competencia no puede tumbar Estrategia.
  await supabase.from("vera_dashboard_readings")
    .update({ status: "superseded" })
    .eq("brand_container_id", brandContainerId)
    .eq("scope", sc)
    .in("status", ["published", "stale"]);

  const { error } = await supabase.from("vera_dashboard_readings").insert({
    organization_id: organizationId,
    brand_container_id: brandContainerId,
    scope: sc,
    periodo: null,
    status: "published",
    schema_version: READING_SCHEMA_VERSION,
    reading: v.data,
    session_id: sessionId,
    model: process.env.VERA_DASH_MODEL_LABEL || "openclaw-org-server",
    window_end: new Date().toISOString(),
    trigger_kind: trigger,
  });
  if (error) throw new Error(`publicar ${sc}: ${error.message}`);

  const otros = SCOPES_ESCRIBIBLES.filter((s) => s !== sc);
  return {
    ok: true,
    visible: true,
    tab: NOMBRE_TAB[sc],
    scope: sc,
    bloques: v.data.narrative.length,
    evidencias: Object.keys(v.data.evidence || {}).length,
    siguiente: `'${NOMBRE_TAB[sc]}' ya se ve en el tablero con ${v.data.narrative.length} bloque(s). ` +
      `Los otros dos tabs (${otros.map((s) => NOMBRE_TAB[s]).join(", ")}) siguen como estaban: ` +
      "getMiMarcaProgress te dice de cuando son y cuales vencieron.",
  };
}
