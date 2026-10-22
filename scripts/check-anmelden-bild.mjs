/**
 * Prüft das Bildfeld der Anmeldeseiten unter Fast 3G mit abgeschaltetem Cache:
 * erst die unscharfe Vorschau, dann das scharfe Bild, nie ein leeres Feld – auch nach
 * einer Anmeldung mit falschem Passwort. Dazu: Kopf- und Fusslogo auf gleicher x-Position,
 * bei 390px keine Anfrage an /bilder/portal.
 *
 *   BASE=https://… node scripts/check-anmelden-bild.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3010";
const PAGES = ["/anmelden", "/registrieren"];
// Werte des DevTools-Profils „Fast 3G“.
const FAST_3G = { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 };

// Hält bei jedem Frame fest, was das Bildfeld zeigt: leer, Vorschau oder scharfes Bild.
const SAMPLER = () => {
  window.__bildZustaende = [];
  const tick = () => {
    const img = document.querySelector("aside picture img");
    if (img && img.getBoundingClientRect().height > 0) {
      const sharp = img.complete && img.naturalWidth > 1 && img.currentSrc.includes("/bilder/portal");
      const preview = getComputedStyle(img).backgroundImage.includes("data:image/");
      const state = sharp ? "scharf" : preview ? "vorschau" : "leer";
      if (window.__bildZustaende.at(-1) !== state) window.__bildZustaende.push(state);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? "chrome" });
let failures = 0;
const report = (label, ok, detail) => {
  console.log(`${ok ? "ok    " : "FEHLER"} ${label}: ${detail}`);
  if (!ok) failures++;
};

async function throttledPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", FAST_3G);
  await page.addInitScript(SAMPLER);
  return { context, page };
}

const states = (page) => page.evaluate(() => window.__bildZustaende);
const waitSharp = (page) =>
  page.waitForFunction(() => window.__bildZustaende?.at(-1) === "scharf", null, { timeout: 60_000 });

function checkSequence(label, seq) {
  const ok = seq.length > 0 && !seq.includes("leer") && seq.at(-1) === "scharf";
  report(label, ok, seq.join(" → ") || "kein Bildfeld gefunden");
}

for (const path of PAGES) {
  const { context, page } = await throttledPage(1440);
  await page.goto(BASE + path, { waitUntil: "commit" });
  await waitSharp(page).catch(() => {});
  checkSequence(`${path} @1440px Fast 3G`, await states(page));

  const xs = await page.evaluate(() =>
    ["header a img", "footer img"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().left)),
  );
  report(`${path} Logos`, xs[0] === xs[1], `Kopf x=${xs[0]}, Fuss x=${xs[1]}`);

  await context.close();
}

// Falsches Passwort einmal mit geladenem JavaScript und einmal ohne, wie vor der Hydrierung:
// dann schickt der Browser das Formular selbst ab und lädt die Seite neu.
for (const ohneJs of [false, true]) {
  const { context, page } = await throttledPage(1440);
  if (ohneJs) await page.route("**/_next/static/chunks/**", (r) => r.abort());
  await page.goto(BASE + "/anmelden", { waitUntil: "commit" });
  await waitSharp(page).catch(() => {});
  if (!ohneJs) await page.waitForLoadState("networkidle");
  await page.evaluate(() => (window.__bildZustaende = []));
  await page.fill("#email", "pruefung-falsch@immotrustag.ch");
  await page.fill("#password", "falsches-passwort");
  await page.click("button[type=submit]");
  await page.getByRole("alert").waitFor({ timeout: 60_000 });
  await waitSharp(page).catch(() => {});
  checkSequence(`/anmelden falsches Passwort${ohneJs ? " (Neuladen)" : ""}`, await states(page));
  await context.close();
}

for (const path of PAGES) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const hits = [];
  page.on("request", (r) => r.url().includes("/bilder/portal") && hits.push(r.url()));
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  report(`${path} @390px`, hits.length === 0, `${hits.length} Anfragen an /bilder/portal`);
  await context.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
