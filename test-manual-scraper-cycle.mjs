import { runCompetitorScraper } from "./src/services/social-scraper.service.js";
console.log("Forzando ciclo manual de scraper...");
const t0 = Date.now();
try {
  await runCompetitorScraper();
  console.log("OK -- duration:", ((Date.now()-t0)/1000).toFixed(1)+"s");
} catch (e) {
  console.error("FAILED:", e.message);
  console.error(e.stack);
}
