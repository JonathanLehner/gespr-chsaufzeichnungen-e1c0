/**
 * Prüft das Mitlaufen des Transkripts in einem echten Browser.
 *
 * Zwei Beschwerden gaben den Anlass: Die Wortmarkierung stand auf einem anderen
 * Wort als dem gesprochenen, und die Liste sprang beim Abspielen unvermittelt.
 * Geprüft wird deshalb, dass (a) kein einzelnes Wort als „laufend“ markiert
 * wird, (b) die markierte Zeile im sichtbaren Ausschnitt der Liste bleibt und
 * (c) die Liste sich nur in kleinen Schritten bewegt.
 *
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   node scripts/check-mitlaufen.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3010";
const EMAIL = process.env.CHECK_EMAIL ?? "samir.weber@immotrustag.ch";
const PASSWORD = process.env.CHECK_PASSWORD;
if (!PASSWORD) {
  console.error("CHECK_PASSWORD fehlt: CHECK_PASSWORD=… node scripts/check-mitlaufen.mjs");
  process.exit(1);
}
const OUT = join(tmpdir(), "gaz-mitlaufen");
mkdirSync(OUT, { recursive: true });

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

await page.goto(`${BASE}/anmelden`, { waitUntil: "domcontentloaded" });
await page.getByLabel("E-Mail-Adresse").fill(EMAIL);
await page.getByLabel("Passwort").fill(PASSWORD);
await page.getByRole("button", { name: "Anmelden", exact: true }).click();
await page.getByRole("button", { name: "Abmelden" }).waitFor({ timeout: 90000 });

/* Eine transkribierte Aufnahme aus dem Bestand wählen – möglichst eine lange,
   weil nur dort abschnittsweise transkribiert wird und die Liste scrollt. */
await page.goto(`${BASE}/aufnahmen?status=abgeschlossen&pageSize=100`, {
  waitUntil: "domcontentloaded",
});
const hrefs = await page.$$eval('tbody tr a[href^="/aufnahmen/rec_"]', (nodes) => [
  ...new Set(nodes.map((node) => node.getAttribute("href"))),
]);

let chosen = null;
for (const href of hrefs.slice(0, 8)) {
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
  const ok = await page
    .locator('[id^="satz-"]')
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) continue;
  const count = await page.locator('[id^="satz-"]').count();
  if (!chosen || count > chosen.count) chosen = { href, count };
  if (chosen.count >= 40) break;
}
record("Transkribierte Aufnahme gefunden", Boolean(chosen), chosen ? `${chosen.href} · ${chosen.count} Sätze` : "keine");
if (!chosen) {
  await browser.close();
  process.exit(1);
}
await page.goto(`${BASE}${chosen.href}`, { waitUntil: "domcontentloaded" });
await page.locator('[id^="satz-"]').first().waitFor({ timeout: 30000 });

const listState = () =>
  page.evaluate(() => {
    const first = document.querySelector('[id^="satz-"]');
    const list = first?.parentElement;
    const active = document.querySelector('[id^="satz-"].bg-petrol-soft');
    if (!list) return null;
    const box = list.getBoundingClientRect();
    const row = active?.getBoundingClientRect();
    return {
      scrollTop: Math.round(list.scrollTop),
      hoehe: Math.round(box.height),
      aktiv: active?.id ?? null,
      sichtbar: row ? row.top >= box.top - 1 && row.bottom <= box.bottom + 1 : false,
      karaoke: [...document.querySelectorAll("[id^='satz-'] span[data-wort]")].filter((span) =>
        span.classList.contains("bg-petrol"),
      ).length,
    };
  });

/* Mitten in die Aufnahme springen, damit die Liste tatsächlich scrollen muss. */
await page.evaluate(() => {
  const audio = document.querySelector("audio");
  if (audio) audio.currentTime = Math.max(0, (audio.duration || 60) * 0.45);
});
await page.click('button:has-text("Abspielen")');

const samples = [];
for (let step = 0; step < 12; step += 1) {
  await page.waitForTimeout(1200);
  samples.push(await listState());
}
await page.click('button:has-text("Pause")');
await page.screenshot({ path: join(OUT, "mitlaufen.png"), fullPage: false });

const withActive = samples.filter((sample) => sample?.aktiv);
record(
  "Laufende Passage durchgehend markiert",
  withActive.length >= samples.length - 1,
  `${withActive.length} von ${samples.length} Messungen`,
);
const unsichtbar = withActive.filter((sample) => !sample.sichtbar);
record(
  "Markierte Zeile bleibt im Ausschnitt",
  unsichtbar.length === 0,
  `${unsichtbar.length} Messungen ausserhalb`,
);
record(
  "Keine wandernde Wortmarkierung",
  samples.every((sample) => sample?.karaoke === 0),
  `${samples.reduce((sum, sample) => sum + (sample?.karaoke ?? 0), 0)} markierte Wörter`,
);

/* Sprünge: Zwischen zwei Messungen darf sich die Liste höchstens um ihre eigene
   Höhe bewegen. Der alte Fehler rechnete gegen die Seite statt gegen den
   Behälter und warf die Liste in einem Schritt ans Ende. */
const spruenge = samples
  .slice(1)
  .map((sample, index) => Math.abs((sample?.scrollTop ?? 0) - (samples[index]?.scrollTop ?? 0)));
const hoehe = samples.find((sample) => sample?.hoehe)?.hoehe ?? 560;
record(
  "Keine Sprünge über die Ausschnitthöhe hinaus",
  spruenge.every((weite) => weite <= hoehe),
  `grösster Schritt ${Math.max(0, ...spruenge)} px bei ${hoehe} px Ausschnitt`,
);

/* Von Hand scrollen schaltet das Mitlaufen ab und die Liste bleibt stehen. */
await page.click('button:has-text("Abspielen")');
await page.waitForTimeout(800);
await page.locator('[id^="satz-"]').first().hover();
await page.mouse.wheel(0, 400);
await page.waitForTimeout(200);
const nachRad = await listState();
await page.waitForTimeout(3000);
const spaeter = await listState();
const followBox = await page.getByRole("checkbox", { name: "Mitlaufen" }).isChecked();
await page.click('button:has-text("Pause")');
record(
  "Scrollen von Hand schaltet das Mitlaufen ab",
  followBox === false && Math.abs((spaeter?.scrollTop ?? 0) - (nachRad?.scrollTop ?? 0)) < 8,
  `Kästchen ${followBox ? "an" : "aus"}, Versatz ${Math.abs((spaeter?.scrollTop ?? 0) - (nachRad?.scrollTop ?? 0))} px`,
);

/* Suche: Treffer über mehrere Wörter werden auch dann markiert, wenn kein
   einzelnes Wort den ganzen Begriff enthält. */
const zweiWorte = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[id^="satz-"]')].find(
    (candidate) => candidate.querySelectorAll("span[data-wort]").length >= 4,
  );
  const words = [...(row?.querySelectorAll("span[data-wort]") ?? [])].map((span) =>
    span.textContent.trim(),
  );
  return words.slice(1, 3).join(" ");
});
await page.getByLabel("Im Transkript suchen").fill(zweiWorte);
await page.waitForTimeout(500);
const markiert = await page.evaluate(
  () =>
    [...document.querySelectorAll("[id^='satz-'] span[data-wort]")].filter((span) =>
      span.className.includes("fdeaa8"),
    ).length,
);
record("Suchbegriff über mehrere Wörter markiert", markiert >= 2, `„${zweiWorte}“ → ${markiert} Wörter`);

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
console.log(`Bildschirmfoto: ${join(OUT, "mitlaufen.png")}`);
process.exit(failed.length === 0 ? 0 : 1);
