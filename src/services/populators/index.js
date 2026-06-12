/**
 * populators/index.js — registry
 *
 * Único punto que el job-worker importa. Mapea mission_type → populator.
 *
 * Para añadir una plataforma nueva:
 *   1. crear `<platform>.populator.js` extendiendo BasePopulator
 *   2. registrarla en POPULATORS abajo
 *   3. añadirla a integration_catalog (DB)
 *   4. añadir el branch OAuth en functions/api-integrations-exchange.js
 */
import { ShopifyPopulator } from "./shopify.populator.js";
import { AmazonPopulator } from "./amazon.populator.js";
import { MercadoLibrePopulator } from "./mercadolibre.populator.js";
import { WooCommercePopulator } from "./woocommerce.populator.js";
import { FacebookPopulator } from "./facebook.populator.js";
import { GooglePopulator } from "./google.populator.js";
import { XPopulator } from "./x.populator.js";
import { EnrichmentPopulator } from "./enrichment.populator.js";

const POPULATORS = [
  new ShopifyPopulator(),
  new AmazonPopulator(),
  new MercadoLibrePopulator(),
  new WooCommercePopulator(),
  new FacebookPopulator(),
  new GooglePopulator(),
  new XPopulator(),
  new EnrichmentPopulator(),
];

// mission_type → populator instance
const MISSION_INDEX = new Map();
for (const p of POPULATORS) {
  for (const mt of p.handles()) MISSION_INDEX.set(mt, p);
}

export function getPopulatorForMission(missionType) {
  return MISSION_INDEX.get(missionType) || null;
}

export function getPopulator(platform) {
  return POPULATORS.find(p => p.platform === platform) || null;
}

export function getAllPlatforms() {
  return POPULATORS.map(p => p.platform);
}

export function getAllHandledMissions() {
  return Array.from(MISSION_INDEX.keys());
}

/**
 * Punto de entrada usado por job-worker.service.js.
 * Sustituye al import directo de shopify-bootstrap.service.js.
 */
export async function processIntegrationJob(job) {
  const mt = job?.payload?.mission_type;
  if (!mt) throw new Error("processIntegrationJob: missing mission_type");
  const pop = getPopulatorForMission(mt);
  if (!pop) throw new Error(`processIntegrationJob: no populator for mission_type "${mt}"`);
  return pop.process(job);
}
