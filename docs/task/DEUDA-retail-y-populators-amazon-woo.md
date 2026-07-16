# DEUDA — runShelfPresenceAudit (fila 6) + activate_populator_amazon_woo (fila 7)

Diferidas por decision del usuario (2026-07-09): requieren credenciales / actor /
presupuesto externos no disponibles. El resto del roadmap ai-engine CMO quedo HECHO.
Este documento fija el CONTRATO exacto para retomarlas sin re-investigar.

---

## Fila 6 — `runShelfPresenceAudit` (P0, ai-engine + supabase)

**Objetivo:** auditar share of shelf, disponibilidad, stock y precio real en retailers
(hoy la tabla `retail_prices` esta VACIA). Cierra la deuda `retailer_monitoring_gap`.

**Causa raiz del bloqueo (diagnosticada):** `scrapeAmazonProduct` / `scrapeAmazonSearch`
en el path marketplace son `_legacyStub` (Playwright removido → retornan []). Los
scrapers SOCIALES se migraron a Apify batch (runActor), pero la rama MARKETPLACE no.
El resto del pipeline (persistAmazonSignal → `retail_prices`) esta OK.

**Lo que se necesita del usuario para construir:**
1. Un **actor Apify de Amazon** (o equivalente MELI retail) registrado en `scraper_actors`.
   OJO: `scraper_actors` NO tiene columna `actor_id` — revisar el schema real antes.
2. **Targets competidores**: ASINs (Amazon) / MLM ids (MELI) por marca — via onboarding.
3. **Presupuesto Apify** aprobado (cada run cuesta; hoy hard-limit puede estar en 0).
4. NO es verificable sin un run pagado.

**Como construir (cuando haya lo anterior):**
- Reimplementar la rama marketplace sobre `apify.client.runActor()` (patron identico a
  los scrapers sociales ya migrados).
- Servicio ai-engine `runShelfPresenceAudit(brand)` que dispara el/los actor(es) retail,
  calcula presencia/stock/precio por retailer×producto y persiste en `retail_prices`.
- Alimenta `compute_distribution_gap` (ya vivo) y `analyze_price_architecture` (ya vivo).

---

## Fila 7 — `activate_populator_amazon_woo` (P1, ai-engine)

**Objetivo:** convertir los STUBS de Amazon (SP-API) y WooCommerce (REST) en populators
reales (catalogo canonico + imagenes a bucket), como Shopify/MELI.

**Estado actual:** `src/services/populators/amazon.populator.js` y `woocommerce.populator.js`
son STUBS (45 lineas c/u): `bootstrap` marca `populator_status: stub_phase_1` y encola
subjobs que no hacen nada real (`stubSync`). El contrato `BasePopulator` y el Registry
de populators ya existen y funcionan (Shopify/MELI son la referencia).

**Lo que se necesita del usuario para construir:**
- **Amazon SP-API**: registro como developer + LWA (Login with Amazon) refresh token +
  role/marketplace. Endpoints a mapear (ya anotados en el stub):
  - `GET /catalog/2022-04-01/items?marketplaceIds=...&keywords=...` → products
  - `GET /listings/2021-08-01/items/{sellerId}/{sku}` → variants
  - `GET /aplus/2020-11-01/contentDocuments/...` → product_images (descargar a bucket)
- **WooCommerce**: consumer_key + consumer_secret (REST API v3) de una tienda real +
  su base URL. Endpoints: `/wp-json/wc/v3/products` (+ variations, + images).
- Sin credenciales NO se puede probar (no verificable a ciegas).

**Como construir (cuando haya credenciales):**
- Implementar el contrato `BasePopulator` para SP-API y Woo REST con dedupe e imagenes a
  bucket (calcado de `shopify.populator.js` / `mercadolibre.populator.js`).
- Registrar en el Registry de populators (`src/services/populators/index.js`).
- Habilita analisis de esos canales para Vera (elimina capacidad falsa).

---

_Referencias de memoria: `project_retailer_monitoring_gap`, `project_apify_hardlimit_silent_fail`,
`project_cmo_roadmap_impl` (DETALLE B). Retomar con credenciales+actor+budget confirmados._
