/**
 * product-classifier.service.js
 *
 * Lee el TITULO de un listado externo (Mercado Libre, Shopify, WooCommerce…) y
 * decide que es realmente: un producto, una presentacion del mismo producto, un
 * pack/multipack, o un bundle (kit/combo/promo).
 *
 * Por que existe: los marketplaces no publican productos, publican LISTADOS. El
 * mismo producto aparece como "Crema De Almendras 240g", "Crema De Almendra
 * Wakeup", "Caja Energy Water 600ml X 12" y "Kit Proteina + Shaker". Sin este
 * paso, cada listado terminaba siendo un producto distinto en `products` y el
 * catalogo de la marca quedaba inservible (caso WAKEUP: 77 filas para 16
 * productos reales).
 *
 * Sin LLM: puro analisis lexico, determinista y auditable (regla del usuario —
 * nada de LLM en background).
 */

// Palabras que solo describen la venta, no el producto.
const FILLER = new Set([
  "sabor", "sabores", "con", "sin", "de", "del", "la", "el", "los", "las", "y", "para",
  "mas", "presentacion", "unidad", "und", "uds", "nuevo", "nueva", "original", "oficial",
  "importado", "envio", "en", "a", "al", "por", "tipo", "linea",
  "ni", "no", "solo", "todo", "toda", "cada", "su", "sus", "que", "es", "un", "una",
]);

// Envase colectivo: por si solo ya delata un multipack ("Caja …", "Bolsa … X4").
// OJO: "pack" suelto NO entra — "Choco One Pack 72g" es el nombre del producto.
const CONTAINER_WORDS = /\b(caja|cajas|bolsa|bolsas|display|multipack|docena|six\s*pack|sixpack|surtido)\b/i;
// Palabras de empaque que solo cuentan acompanadas de una cantidad.
const PACK_WORDS = /\b(caja|cajas|bolsa|bolsas|display|multipack|pack|paquete|six\s*pack|sixpack|docena|surtido)\b/i;
const PACK_UNITS = [
  // "x 12", "X12"  — excluye "x 600ml" (eso es tamano, no cantidad)
  /\bx\s*(\d{1,3})\b(?!\s*(?:g|gr|grs|gramos|kg|ml|l|lt|litro|litros|oz))/i,
  /\b(\d{1,3})\s*(?:unidades|unids|und|uds|piezas|pzas|bombones|sobres|sachets|botellas|barras|tarros|latas)\b/i,
];
const SIX_PACK = /\bsix\s*pack\b|\bsixpack\b/i;
const DOCENA   = /\bdocena\b/i;

// Marcadores de bundle: el listado junta productos distintos o suma un regalo.
const BUNDLE_WORDS = /\b(kit|combo|promo|promocion|tripack|tri\s*pack|duopack|duo\s*pack|bundle|gratis|regalo|obsequio|incluye)\b/i;
// Accesorios: solo delatan bundle si vienen sumados ("+ shaker"), nunca solos
// — "Termo Shaker 3 En 1" es un producto por derecho propio.
const ACCESSORY_WORDS = /\b(shaker|termo|nutribullet|coctelera|vaso|mezclador)\b/i;

// Reclamos de etiqueta: sobran para identificar el producto ("sin lactosa y gluten").
const CLAIM_WORDS = new Set([
  "lactosa", "gluten", "azucar", "azucare", "conservante", "edulcorante", "keto", "vegano",
  "organico", "colageno", "saludable", "light", "premium", "fit", "adicionado", "añadido",
  "anadido", "hormona", "soya", "transgenico", "artificial",
]);

// Tamano/contenido neto.
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|g|gr|grs|gramos|ml|mls|l|lt|litro|litros|oz)\b/gi;

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normaliza un tamano a gramos o mililitros para poder comparar 0.24kg con 240g. */
function normalizeSize(value, unit) {
  const v = Number(String(value).replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const u = unit.toLowerCase();
  if (u.startsWith("kg"))            return { value: v * 1000, unit: "g",  label: `${v}kg` };
  if (u === "g" || u.startsWith("gr")) return { value: v,      unit: "g",  label: `${v}g` };
  if (u === "oz")                    return { value: v * 28.3495, unit: "g", label: `${v}oz` };
  if (u.startsWith("ml"))            return { value: v,        unit: "ml", label: `${v}ml` };
  return { value: v * 1000, unit: "ml", label: `${v}L` };   // l, lt, litro(s)
}

/**
 * Saca la marca del titulo ya normalizado. Cubre los tres casos reales:
 *   - la marca tal cual        ("… wakeup 600ml")
 *   - la marca sin espacios    (marca "Wake Up" publicada como "wakeup")
 *   - la marca partida         (marca "WAKEUP" publicada como "wake up")
 * El caso partido se resuelve pegando ventanas de 2 y 3 tokens y comparando con
 * la marca sin espacios; asi nunca se borra un token suelto como "up", que en
 * "Choco Up Natural" es parte del nombre del producto.
 */
export function stripBrand(normalizedTitle, brandName) {
  const brand = normalizeName(brandName);
  if (!brand) return normalizedTitle;
  const glued = brand.replace(/\s+/g, "");
  let out = normalizedTitle;
  if (brand.includes(" ")) out = out.replace(new RegExp(`\\b${brand}\\b`, "g"), " ");
  out = out.replace(new RegExp(`\\b${glued}\\b`, "g"), " ");

  const tokens = out.split(/\s+/).filter(Boolean);
  const keep = new Array(tokens.length).fill(true);
  for (let i = 0; i < tokens.length; i++) {
    for (const win of [3, 2]) {
      if (i + win > tokens.length) continue;
      if (tokens.slice(i, i + win).join("") === glued) {
        for (let k = i; k < i + win; k++) keep[k] = false;
        i += win - 1;
        break;
      }
    }
  }
  return tokens.filter((_, i) => keep[i]).join(" ");
}

/** Quita plurales simples para que "almendras" y "almendra" sean el mismo token. */
function singular(t) {
  if (t.length > 4 && t.endsWith("es")) {
    const raiz = t.slice(0, -2);
    // En espanol el plural -es solo aplica a palabras terminadas en consonante
    // ("maranones" -> "maranon"). "conservantes" es "conservante" + s.
    if (/[lrndzjs]$/.test(raiz)) return raiz;
    return t.slice(0, -1);
  }
  if (t.length > 3 && t.endsWith("s"))  return t.slice(0, -1);
  return t;
}

// Los diccionarios se comparan contra tokens YA singularizados, asi que hay que
// pasarlos por la misma regla: "conservantes" queda en "conservant" y no
// coincidiria nunca con la entrada "conservante" escrita a mano.
const FILLER_S = new Set([...FILLER].map(singular));
const CLAIMS_S = new Set([...CLAIM_WORDS].map(singular));
const esRelleno = (t) => FILLER.has(t) || FILLER_S.has(t);
const esReclamo = (t) => CLAIM_WORDS.has(t) || CLAIMS_S.has(t);

/**
 * Analiza un titulo de listado.
 * @returns {{
 *   kind: 'producto'|'pack'|'bundle',
 *   coreKey: string, coreTokens: string[],
 *   size: {value:number,unit:string,label:string}|null,
 *   packUnits: number|null, reasons: string[]
 * }}
 */
export function parseListing(rawName, { brand } = {}) {
  const reasons = [];
  const original = String(rawName || "");

  // 1. Los porcentajes son parte del producto ("cacao 58%" != "cacao 70%"): se
  //    convierten en token ANTES de normalizar, que se come el simbolo %.
  let work = normalizeName(original.replace(/(\d{1,3})\s*(?:%|por\s?ciento)/gi, " p$1 "));

  // 2. Fuera la marca. Se quita la marca tal cual y tambien partida en el titulo
  //    ("WAKEUP" publicado como "Wake Up"), pero NUNCA pedazos sueltos: borrar
  //    "up" a secas destruiria "Choco Up Natural".
  work = stripBrand(work, brand);

  // 3. Tamano (se queda con el ultimo: "Caja Energy Water 600ml X 12" -> 600ml)
  let size = null;
  const sizeMatches = [...work.matchAll(SIZE_RE)];
  if (sizeMatches.length) {
    const m = sizeMatches[sizeMatches.length - 1];
    size = normalizeSize(m[1], m[2]);
  }

  // 4. Cantidad de un multipack
  let packUnits = null;
  if (SIX_PACK.test(work)) { packUnits = 6;  reasons.push("six pack"); }
  else if (DOCENA.test(work)) { packUnits = 12; reasons.push("docena"); }
  else {
    for (const re of PACK_UNITS) {
      const m = work.match(re);
      if (m) { packUnits = Number(m[1]); reasons.push(`cantidad x${m[1]}`); break; }
    }
  }
  const hasContainer = CONTAINER_WORDS.test(work);
  if (hasContainer) reasons.push("envase colectivo");

  // 5. Bundle: kit/combo/promo, o una suma explicita ("proteina + shaker").
  //    Un accesorio solo NO basta: "Termo Shaker 3 En 1" es un producto.
  const plus = /\+/.test(original);
  const isBundle = BUNDLE_WORDS.test(work) || (plus && ACCESSORY_WORDS.test(work)) || (plus && packUnits > 1);
  if (isBundle) reasons.push("kit/combo/suma de productos");

  // 6. Nucleo: lo que queda tras sacar tamanos, cantidades, palabras de venta y
  //    relleno. Los reemplazos van en global: "Caja One Pack ... X 12" tiene dos
  //    palabras de empaque y solo borrar la primera dejaba un nucleo distinto al
  //    del producto suelto.
  const sinTamano = work.replace(SIZE_RE, " ");
  const core = stripBrand(sinTamano, brand)      // 2do paso: "Wakeup30g" solo suelta la marca al irse el tamano
    .replace(/\bx\s*\d{1,3}\b/gi, " ")
    .replace(new RegExp(PACK_WORDS.source, "gi"), " ")
    .replace(new RegExp(BUNDLE_WORDS.source, "gi"), " ")
    .replace(/\b(?!p\d)\d+\b/g, " ")
    .split(/\s+/)
    .map((t) => singular(t.trim()))
    // Los reclamos de etiqueta ("sin lactosa", "sin azucar anadida", "keto") no
    // identifican al producto: el mismo SKU se publica con y sin ellos segun el
    // canal. Fuera del nucleo, o "Crema de Almendras" y "Crema de Almendras Sin
    // Azucar Ni Conservantes" terminan siendo dos productos.
    .filter((t) => t && t.length > 1 && !esRelleno(t) && !esReclamo(t));

  const coreTokens = [...new Set(core)].sort();

  // Un pack necesita cantidad (>1) o un envase colectivo. "Choco One Pack 72g"
  // no es un pack: "pack" es parte del nombre.
  let kind = "producto";
  if (isBundle) kind = "bundle";
  else if (packUnits > 1 || hasContainer) kind = "pack";

  return { kind, coreKey: coreTokens.join(" "), coreTokens, size, packUnits, reasons };
}

/** Distancia de edicion acotada a 1: barata y suficiente para erratas de titulo. */
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Dos tokens son el mismo concepto si son iguales, si uno es prefijo del otro
 * con 6+ caracteres ("chocolat" del titulo truncado de Mercado Libre contra
 * "chocolate"), o si difieren en una letra. El minimo de 6 evita que "choco"
 * se coma "chocolate", que en esta marca son productos distintos.
 */
export function tokensMatch(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 6 && l.startsWith(s)) return true;
  return s.length >= 6 && within1(a, b);
}

/** Jaccard tolerante sobre los tokens del nucleo. */
export function coreSimilarity(aTokens, bTokens) {
  const a = [...new Set(aTokens)], b = [...new Set(bTokens)];
  if (!a.length || !b.length) return 0;
  const usadas = new Set();
  let inter = 0;
  for (const t of a) {
    const k = b.findIndex((u, i) => !usadas.has(i) && tokensMatch(t, u));
    if (k >= 0) { usadas.add(k); inter++; }
  }
  return inter / (a.length + b.length - inter);
}

/**
 * ¿El nucleo chico esta contenido en el grande y lo que sobra son solo reclamos
 * de etiqueta? "Proteina Huevo Vainilla Sin Lactosa Y Gluten" contiene a
 * "Proteina Huevo Vainilla" y solo agrega reclamos -> mismo producto.
 * Si lo que sobra es un sabor o ingrediente ("chocolate"), NO lo es.
 */
export function claimsOnlyContainment(aTokens, bTokens) {
  const [chico, grande] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (chico.length < 2) return false;
  const sobra = [];
  for (const t of grande) {
    if (!chico.some((u) => tokensMatch(t, u))) sobra.push(t);
  }
  if (!chico.every((t) => grande.some((u) => tokensMatch(t, u)))) return false;
  return sobra.length > 0 && sobra.every((t) => esReclamo(t));
}

export const _internals = { FILLER, CLAIM_WORDS, PACK_WORDS, CONTAINER_WORDS, BUNDLE_WORDS, singular, normalizeSize, within1 };
