/**
 * Org Sync Service — detecta organizaciones sin agente OpenClaw y las provisiona.
 *
 * Por qué existe este servicio:
 *   El provisionamiento normal depende de un Database Webhook de Supabase que
 *   dispara POST /internal/org-created cuando se inserta una fila en `organizations`.
 *   Si ese webhook no está configurado, si la URL cambió, o si el ai-engine estaba
 *   caído cuando se creó la org, la organización queda sin agente.
 *
 *   Este servicio es la red de seguridad: cada N minutos compara las orgs en la DB
 *   con las instancias en openclaw_instances y provisiona cualquier huérfana.
 *
 * Flujo:
 *   1. Leer todas las organizations de Supabase
 *   2. Leer openclaw_instances (status healthy/provisioning/starting)
 *   3. Provisionar las orgs que no tienen instancia activa
 *   4. Limpiar el registro en memoria (registry) de orgs que ya no existen en DB
 */

import { supabase } from "../lib/supabase.js";
import { provisionOpenClawForOrg } from "./openclaw.provisioner.js";
import { getAllOrgs } from "./openclaw.registry.js";

const SYNC_INTERVAL_MS = parseInt(process.env.ORG_SYNC_INTERVAL_MS || "300000", 10); // 5 min
const ACTIVE_STATUSES  = new Set(["healthy", "provisioning", "starting"]);

let _syncInterval = null;

async function runOrgSync() {
  try {
    // 1. Obtener todas las organizaciones
    const { data: orgs, error: orgsErr } = await supabase
      .from("organizations")
      .select("id, name");

    if (orgsErr) {
      console.warn("org-sync: error leyendo organizations:", orgsErr.message);
      return;
    }
    if (!orgs?.length) return;

    // 2. Obtener instancias activas
    const { data: instances, error: instErr } = await supabase
      .from("openclaw_instances")
      .select("organization_id, status")
      .in("status", [...ACTIVE_STATUSES]);

    if (instErr) {
      console.warn("org-sync: error leyendo openclaw_instances:", instErr.message);
      return;
    }

    const provisionedOrgIds = new Set((instances || []).map((i) => i.organization_id));

    // 3. Detectar orgs sin instancia activa
    const orphanOrgs = orgs.filter((org) => !provisionedOrgIds.has(org.id));

    if (orphanOrgs.length === 0) return;

    console.log(`org-sync: ${orphanOrgs.length} org(s) sin instancia activa → provisionando...`);

    for (const org of orphanOrgs) {
      console.log(`org-sync: provisionando org "${org.id}" (${org.name || "sin nombre"})`);
      try {
        await provisionOpenClawForOrg(org.id, org.name);
        console.log(`org-sync: org "${org.id}" provisionada correctamente`);
      } catch (e) {
        console.error(`org-sync: fallo provisionando org "${org.id}":`, e.message?.slice(0, 200));
      }
    }
  } catch (e) {
    console.error("org-sync: error inesperado:", e.message);
  }
}

/**
 * Arranca el ciclo de sincronización periódica.
 * @param {number} [intervalMs] - Intervalo en ms. Default: ORG_SYNC_INTERVAL_MS env var o 5 min.
 */
export function startOrgSyncService(intervalMs = SYNC_INTERVAL_MS) {
  if (_syncInterval) return; // ya arrancado

  // Primera ejecución: correr 30 segundos después del boot para no competir con initRegistry
  const firstRunDelay = 30_000;
  console.log(`org-sync: arrancando — primera ejecución en ${firstRunDelay / 1000}s, luego cada ${intervalMs / 60000}min`);

  setTimeout(async () => {
    await runOrgSync();
    _syncInterval = setInterval(runOrgSync, intervalMs);
  }, firstRunDelay);
}

export function stopOrgSyncService() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}

/** Ejecutar una sincronización manual (útil para tests o endpoints admin). */
export { runOrgSync };
