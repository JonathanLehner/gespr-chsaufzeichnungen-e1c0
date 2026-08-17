/**
 * Misst die öffentlichen Seiten im mobilen und im Desktop-Profil:
 * LCP, Layoutverschiebung, Blockierzeit und übertragene Bytes.
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   node scripts/perf-check.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3010";
const PAGES = ["/", "/anmelden", "/registrieren", "/passwort-vergessen"];
const PROFILES = [
  { name: "Mobil", viewport: { width: 390, height: 844 }, scale: 3 },
  { name: "Desktop", viewport: { width: 1440, height: 900 }, scale: 1 },
];

const browser = await chromium.launch({ channel: "msedge" });
let failures = 0;

for (const profile of PROFILES) {
  console.log(`\n${profile.name} (${profile.viewport.width}px)`);
  for (const path of PAGES) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.scale,
      isMobile: profile.viewport.width < 700,
      hasTouch: profile.viewport.width < 700,
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      window.__lcp = 0;
      window.__cls = 0;
      window.__blocking = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__lcp = Math.max(window.__lcp, entry.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__blocking += Math.max(0, entry.duration - 50);
        }
      }).observe({ type: "longtask", buffered: true });
    });

    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    const measured = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource");
      const navigation = performance.getEntriesByType("navigation")[0];
      const byType = {};
      let transferred = navigation?.transferSize ?? 0;
      byType.dokument = navigation?.transferSize ?? 0;
      for (const resource of resources) {
        transferred += resource.transferSize;
        const kind = /\.(woff2?|ttf)/.test(resource.name)
          ? "schrift"
          : /\.(webp|avif|png|jpe?g|svg)/.test(resource.name)
            ? "bild"
            : /\.css/.test(resource.name)
              ? "css"
              : /\.js/.test(resource.name)
                ? "js"
                : "sonstiges";
        byType[kind] = (byType[kind] ?? 0) + resource.transferSize;
      }
      const largestScripts = resources
        .filter((resource) => /\.js/.test(resource.name))
        .sort((a, b) => b.transferSize - a.transferSize)
        .slice(0, 3)
        .map((resource) => `${resource.name.split("/").pop()} ${Math.round(resource.transferSize / 1024)} KB`);
      return {
        lcp: Math.round(window.__lcp),
        cls: Number(window.__cls.toFixed(4)),
        blocking: Math.round(window.__blocking),
        transferred,
        byType,
        largestScripts,
      };
    });

    const kb = (value) => `${(value / 1024).toFixed(0)} KB`;
    const detail = Object.entries(measured.byType)
      .filter(([, size]) => size > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([type, size]) => `${type} ${kb(size)}`)
      .join(", ");

    const ok =
      measured.lcp < 2500 &&
      measured.cls < 0.1 &&
      measured.blocking < 200 &&
      measured.transferred < 400 * 1024;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "OK  " : "FEHL"} ${path.padEnd(20)} LCP ${String(measured.lcp).padStart(5)} ms · CLS ${measured.cls} · Blockierzeit ${measured.blocking} ms · ${kb(measured.transferred)} (${detail})`,
    );
    if (!ok) console.log(`     grösste Skripte: ${measured.largestScripts.join(", ")}`);

    await context.close();
  }
}

await browser.close();
console.log(failures === 0 ? "\nAlle Messwerte im Zielbereich." : `\n${failures} Messung(en) ausserhalb des Zielbereichs.`);
process.exit(failures === 0 ? 0 : 1);
