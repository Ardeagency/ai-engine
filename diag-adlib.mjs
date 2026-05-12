import { chromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const browser = await addExtra(chromium).use(StealthPlugin()).launch({
  headless: true,
  args: ["--no-sandbox"],
});

const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  locale: "es-ES",
});

const page = await ctx.newPage();
const urls = [];
const responseSizes = [];

page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("graphql") || u.includes("/ads/library/") || u.includes("search_ads")) {
    urls.push({ status: r.status(), url: u.slice(0, 200) });
    if (urls.length <= 8) {
      try {
        const t = await r.text();
        responseSizes.push({ url: u.slice(0, 100), size: t.length, preview: t.slice(0, 200).replace(/\s+/g, " ") });
      } catch {}
    }
  }
});

try {
  console.log("[1] Navegando...");
  await page.goto(
    "https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=CO&q=Red+Bull&search_type=keyword_unordered&media_type=all",
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  console.log("[2] Page loaded. Esperando 12s para que carguen ads...");
  await page.waitForTimeout(12_000);

  console.log("[3] Aceptando cookies si aparece...");
  try {
    const cookieBtn = await page.$('button[data-cookiebanner="accept_button"]');
    if (cookieBtn) {
      await cookieBtn.click();
      await page.waitForTimeout(2000);
      console.log("    Cookie accepted");
    }
  } catch {}

  console.log("[4] Scroll para forzar más cargas...");
  await page.evaluate(() => window.scrollBy(0, 1500));
  await page.waitForTimeout(6000);

  console.log("\n=== URLs capturadas ===");
  console.log("Total: " + urls.length);
  for (const u of urls.slice(0, 12)) {
    console.log("  [" + u.status + "] " + u.url);
  }

  console.log("\n=== Sample responses ===");
  for (const r of responseSizes) {
    console.log(`  size=${r.size} url=${r.url}`);
    console.log(`    ${r.preview.slice(0, 200)}`);
  }

  const html = await page.content();
  const hasLoginWall   = /you must log in|inicia sesi[oó]n|log in to (?:continue|facebook)/i.test(html);
  const hasNoResults   = /no se han encontrado|no results|sin resultados/i.test(html);
  const hasAdLibraryUI = /ad library|biblioteca de anuncios/i.test(html);
  console.log("\n=== Page state ===");
  console.log("title: " + (await page.title()));
  console.log("login wall: " + hasLoginWall);
  console.log("no results: " + hasNoResults);
  console.log("ad library UI: " + hasAdLibraryUI);
  console.log("html length: " + html.length);
} finally {
  await ctx.close();
  await browser.close();
}
