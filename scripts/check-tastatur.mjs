/**
 * Prüft die Tastaturbedienung der Detailansicht in einem echten Browser.
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   PRUEF_PASSWORT=… node scripts/check-tastatur.mjs
 *
 * Geprüft wird, dass je Satz nur eine Tabulator-Station bleibt, Enter den Satz
 * anspringt, ein Mausklick mitten im Text an den Satzanfang springt und die
 * Sprunglinks am Seitenanfang erst beim Fokussieren erscheinen.
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3010";
const EMAIL = process.env.PRUEF_EMAIL ?? "samir.weber@immotrustag.ch";
const PASSWORT = process.env.PRUEF_PASSWORT;
if (!PASSWORT) {
  console.error("PRUEF_PASSWORT fehlt: PRUEF_PASSWORT=… node scripts/check-tastatur.mjs");
  process.exit(1);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "de-CH",
  timezoneId: "Europe/Zurich",
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.goto(`${BASE}/anmelden`, { waitUntil: "domcontentloaded" });
await page.getByLabel("E-Mail-Adresse").fill(EMAIL);
await page.getByLabel("Passwort").fill(PASSWORT);
await page.getByRole("button", { name: "Anmelden", exact: true }).click();
await page.getByRole("button", { name: "Abmelden" }).first().waitFor({ timeout: 90000 });

await page.goto(`${BASE}/aufnahmen?status=abgeschlossen&pageSize=100`, {
  waitUntil: "domcontentloaded",
});
const hrefs = await page.$$eval('tbody tr a[href^="/aufnahmen/rec_"]', (nodes) => [
  ...new Set(nodes.map((node) => node.getAttribute("href"))),
]);

// Geprüft wird das längste vorhandene Transkript: Dort fällt die
// Tabulator-Reihenfolge am stärksten ins Gewicht.
let detail = null;
let bestSentences = 0;
for (const href of hrefs.slice(0, 8)) {
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
  const found = await page
    .locator('[id^="satz-"]')
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!found) continue;
  const count = await page.locator('[id^="satz-"]').count();
  if (count > bestSentences) {
    bestSentences = count;
    detail = href;
  }
}
record("Aufnahme mit Transkript geöffnet", Boolean(detail), `${detail ?? "keine"} · ${bestSentences} Sätze`);
if (!detail) {
  await browser.close();
  process.exit(1);
}
await page.goto(`${BASE}${detail}`, { waitUntil: "domcontentloaded" });
await page.locator('[id^="satz-"]').first().waitFor({ timeout: 30000 });

await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForTimeout(1200);

/* 1 – Eine Tabulator-Station je Satz */
const sentenceCount = await page.locator('[id^="satz-"]').count();
const wordCount = await page.locator("[id^='satz-'] span[data-wort]").count();
const transcriptStops = await page.evaluate(() => {
  const list = document.querySelector('[id^="satz-"]')?.parentElement;
  return list
    ? list.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ).length
    : -1;
});
record(
  "Pro Satz nur eine Tabulator-Station",
  transcriptStops === sentenceCount && sentenceCount > 0,
  `${transcriptStops} Stationen für ${sentenceCount} Sätze (${wordCount} Wörter)`,
);

const stopsBeforeComments = await page.evaluate(() => {
  const stops = [
    ...document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ];
  return stops.indexOf(document.getElementById("kommentar"));
});
record(
  "Rechte Spalte in wenigen Schritten erreichbar",
  stopsBeforeComments > 0 && stopsBeforeComments <= sentenceCount + 40,
  `${stopsBeforeComments} Stationen bis zum Kommentarfeld`,
);

/* 2 – Tatsächliche Tabulator-Reihenfolge vom Satz bis zur rechten Spalte */
await page.evaluate(() => document.querySelectorAll('[id^="satz-"]')[0]?.focus());
let steps = 0;
let reached = "";
while (steps < 400) {
  await page.keyboard.press("Tab");
  steps += 1;
  const id = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.id || el?.getAttribute("aria-label") || el?.textContent?.trim().slice(0, 30) || "";
  });
  if (id === "kommentar") {
    reached = id;
    break;
  }
}
record(
  "Tabulator erreicht das Kommentarfeld",
  reached === "kommentar",
  `${steps} Tastendrücke ab dem ersten Satz`,
);

/* 3 – Enter springt an den Satzanfang */
await page.evaluate(() => {
  const audio = document.querySelector("audio");
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
});
const focusedId = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[id^="satz-"]')];
  const row = rows[Math.min(6, rows.length - 1)];
  row?.focus();
  return document.activeElement?.id ?? "";
});
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
const afterEnter = await page.evaluate(() => document.querySelector("audio")?.currentTime ?? 0);
record(
  "Enter springt an die Audioposition des Satzes",
  /^satz-\d+$/.test(focusedId) && afterEnter > 0,
  `${focusedId} → ${afterEnter.toFixed(1)} s`,
);

/* 4 – Mausklick mitten im Text springt an den Anfang dieses Satzes.
   Wortzeiten liefert der Dienst nicht; sie wären innerhalb des Satzes geraten.
   Verlässlich ist die Satzgrenze, und genau dorthin springt der Klick. */
await page.evaluate(() => {
  const audio = document.querySelector("audio");
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
});
const words = page.locator("[id^='satz-'] span[data-wort]");
const wordIndex = Math.min(40, (await words.count()) - 1);
await words.nth(wordIndex).click();
await page.waitForTimeout(900);
const afterWordClick = await page.evaluate(() => document.querySelector("audio")?.currentTime ?? 0);
const wordSentenceStart = await page.evaluate((index) => {
  const span = document.querySelectorAll("[id^='satz-'] span[data-wort]")[index];
  const row = span?.closest('[id^="satz-"]');
  return row?.querySelector("span")?.textContent ?? "";
}, wordIndex);
const [startMinutes, startSeconds] = wordSentenceStart.split(":").map(Number);
const expectedStart = (startMinutes || 0) * 60 + (startSeconds || 0);
record(
  "Mausklick im Satztext springt an den Satzanfang",
  // Der Klick startet die Wiedergabe; bis zur Messung läuft sie knapp eine
  // Sekunde weiter. Geprüft wird deshalb ein Fenster, nicht ein Zeitpunkt.
  afterWordClick > expectedStart - 0.5 && afterWordClick < expectedStart + 2.5,
  `Wort ${wordIndex} im Satz ab ${wordSentenceStart} → ${afterWordClick.toFixed(1)} s`,
);
await page.evaluate(() => document.querySelector("audio")?.pause());

/* 5 – Sprunglinks */
await page.evaluate(() => window.scrollTo(0, 0));
const skipTexts = await page.$$eval("a.skip-link", (nodes) =>
  nodes.map((node) => node.textContent.trim()),
);
const hiddenOpacity = await page.evaluate(
  () => getComputedStyle(document.querySelector("a.skip-link")).opacity,
);
await page.evaluate(() => document.querySelectorAll("a.skip-link")[0]?.focus());
await page.waitForTimeout(300);
const shownOpacity = await page.evaluate(
  () => getComputedStyle(document.querySelector("a.skip-link")).opacity,
);
record(
  "Sprunglinks erscheinen erst beim Fokussieren",
  skipTexts.length === 2 &&
    skipTexts[0] === "Zum Transkript" &&
    skipTexts[1] === "Zu den Metadaten und Kommentaren" &&
    hiddenOpacity === "0" &&
    Number(shownOpacity) > 0.9,
  `${skipTexts.join(" · ")} – Deckkraft ${hiddenOpacity} → ${shownOpacity}`,
);
await page.screenshot({ path: "C:/Users/Carlos/AppData/Local/Temp/sprunglink.png" });

await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const transcriptTarget = await page.evaluate(() => document.activeElement?.id ?? "");
await page.evaluate(() => document.querySelectorAll("a.skip-link")[1]?.focus());
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const metadataTarget = await page.evaluate(() => document.activeElement?.id ?? "");
record(
  "Sprunglinks führen ans Ziel",
  transcriptTarget === "transkript" && metadataTarget === "metadaten",
  `${transcriptTarget || "–"} / ${metadataTarget || "–"}`,
);

/* 6 – Erste Tabulator-Station der Seite ab dem Seitenanfang */
await page.goto(`${BASE}${detail}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
const firstSkip = await page.evaluate(() => {
  const stops = [
    ...document.querySelectorAll(
      'main a[href], main button:not([disabled]), main input:not([disabled]), main select, main textarea, main [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const index = stops.findIndex((el) => el.classList.contains("skip-link"));
  return { index, total: stops.length };
});
record(
  "Sprunglinks sind die ersten Stationen des Seiteninhalts",
  firstSkip.index === 0,
  `Position ${firstSkip.index} von ${firstSkip.total} Stationen im Inhaltsbereich`,
);

// Die Sprunglinks liegen unsichtbar über dem Brotkrümelpfad; er muss anklickbar bleiben.
await page.getByRole("link", { name: "Aufnahmen", exact: true }).last().click();
await page.waitForURL(/\/aufnahmen(\?|$)/, { timeout: 20000 }).catch(() => {});
record(
  "Brotkrümelpfad bleibt trotz Sprunglinks anklickbar",
  /\/aufnahmen(\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search),
  page.url(),
);

record("Keine Fehler in der Browserkonsole", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length === 0 ? 0 : 1);
