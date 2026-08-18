/**
 * Prüft den angemeldeten Bereich auf einem Telefon (390 px) und an der
 * Umbruchgrenze der Aufnahmentabelle (699/700 px).
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   MITARBEITER_PASSWORT=… node scripts/mobile-check.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3010";
const EMAIL = process.env.MITARBEITER_EMAIL ?? "samir.weber@immotrustag.ch";
const PASSWORD = process.env.MITARBEITER_PASSWORT;
if (!PASSWORD) {
  console.error(
    "MITARBEITER_PASSWORT fehlt. Die Prüfung meldet sich als Mitarbeitende an:\n" +
      "  MITARBEITER_PASSWORT=… node scripts/mobile-check.mjs",
  );
  process.exit(1);
}
const OUT = join(tmpdir(), "gaz-mobil");
mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

/** Breite des Dokuments gegenüber der Bildschirmbreite. */
async function overflow(page) {
  return page.evaluate(() => ({
    dokument: document.documentElement.scrollWidth,
    fenster: window.innerWidth,
  }));
}

const browser = await chromium.launch({ channel: "msedge" });

/* --- Telefon, 390 px ---------------------------------------------------- */
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "de-CH",
});
const page = await phone.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(`${page.url()} :: ${message.text()}`);
});

await page.goto(`${BASE}/anmelden`, { waitUntil: "load" });
await page.fill("#email", EMAIL);
await page.fill("#password", PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/aufnahmen/, { timeout: 60000 });
await page.waitForTimeout(1200);

const listWidth = await overflow(page);
record(
  "Aufnahmenübersicht passt auf 390 px",
  listWidth.dokument <= listWidth.fenster + 1,
  `${listWidth.dokument} px Dokument / ${listWidth.fenster} px Fenster`,
);

/* Kopfbereich: erste Zeile nur Marke und Menü */
record(
  "Navigation und Abmelden erst im Menü",
  (await page.locator("header nav a:visible").count()) === 0 &&
    (await page.locator('header button:has-text("Abmelden"):visible').count()) === 0,
);
const brandVisible = await page.locator('header a[href="/aufnahmen"]').first().boundingBox();
record(
  "Firmenname im Logo vollständig sichtbar",
  Boolean(brandVisible) && brandVisible.x + brandVisible.width <= 390,
  brandVisible ? `endet bei ${Math.round(brandVisible.x + brandVisible.width)} px` : "nicht gefunden",
);
await page.screenshot({ path: join(OUT, "01-kopf-zu.png") });

await page.click('header button[aria-expanded]');
await page.waitForTimeout(300);
const menuOpen =
  (await page.locator('header a:has-text("Aufnahmen"):visible').count()) > 0 &&
  (await page.locator('header a:has-text("Sammelupload"):visible').count()) > 0 &&
  (await page.locator('header button:has-text("Abmelden"):visible').count()) > 0 &&
  (await page.locator(`header:has-text("${EMAIL}")`).count()) > 0;
record("Menü zeigt Navigation, Konto und Abmelden", menuOpen);
await page.screenshot({ path: join(OUT, "02-kopf-offen.png") });

const openWidth = await overflow(page);
record(
  "Geöffnetes Menü sprengt die Breite nicht",
  openWidth.dokument <= openWidth.fenster + 1,
  `${openWidth.dokument} px`,
);

await page.click('header a:has-text("Sammelupload"):visible');
await page.waitForURL(/upload/, { timeout: 30000 });
await page.waitForTimeout(600);
record(
  "Menü schliesst nach dem Seitenwechsel",
  (await page.locator('header button:has-text("Abmelden"):visible').count()) === 0,
);
await page.goBack();
await page.waitForURL(/aufnahmen/, { timeout: 30000 });
await page.waitForTimeout(800);

/* Kartenansicht der Aufnahmen */
const firstRow = page.locator("tbody tr").first();
await firstRow.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const card = (await firstRow.innerText()).replace(/\s+/g, " ");
const headVisible = await page.locator("thead").first().isVisible();
record("Spaltenköpfe auf dem Telefon ausgeblendet", !headVisible);
record(
  "Karte enthält alle Angaben",
  ["Telefonnummer", "Dauer", "Hochgeladen von", "Bewertung", "Transkription", "Löschmarkierung", "Öffnen"].every(
    (label) => new RegExp(label, "i").test(card),
  ),
  card.slice(0, 200),
);
const box = await firstRow.boundingBox();
record(
  "Karte bleibt innerhalb des Bildschirms",
  Boolean(box) && box.width <= 390,
  box ? `${Math.round(box.width)} px breit` : "nicht gefunden",
);
const actionsVisible =
  (await firstRow.locator('a:has-text("Öffnen")').isVisible()) &&
  (await firstRow.locator("button").first().isVisible());
record("Öffnen und Löschmarkierung erreichbar", actionsVisible);
await page.screenshot({ path: join(OUT, "03-karten.png"), fullPage: false });

/* Löschmarkierung aufklappen: das Begründungsfeld muss in die Karte passen */
const flagButton = firstRow.locator('button:text-is("Löschen")');
if ((await flagButton.count()) > 0) {
  await flagButton.click();
  await page.waitForTimeout(400);
  const field = await firstRow.locator('input[id^="grund-"]').boundingBox();
  record(
    "Begründungsfeld passt in die Karte",
    Boolean(field) && field.x >= 0 && field.x + field.width <= 390,
    field ? `${Math.round(field.width)} px` : "nicht gefunden",
  );
  await page.screenshot({ path: join(OUT, "04-loeschmarkierung.png") });
  await firstRow.locator('button:has-text("Abbrechen")').click();
} else {
  record("Begründungsfeld passt in die Karte", true, "Zeile bereits markiert – übersprungen");
}

/* Suche mit Trefferzeile */
await page.goto(`${BASE}/aufnahmen?q=Weber`, { waitUntil: "load" });
await page.waitForTimeout(800);
const searchWidth = await overflow(page);
record(
  "Suchergebnis mit Trefferzeilen passt auf 390 px",
  searchWidth.dokument <= searchWidth.fenster + 1,
  `${searchWidth.dokument} px`,
);
await page.screenshot({ path: join(OUT, "05-suche.png") });
record("Keine Konsolenfehler auf dem Telefon", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await phone.close();

/* --- Umbruchgrenze der Tabelle ----------------------------------------- */
for (const width of [699, 700]) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    storageState: undefined,
    locale: "de-CH",
  });
  const wide = await context.newPage();
  await wide.goto(`${BASE}/anmelden`, { waitUntil: "load" });
  await wide.fill("#email", EMAIL);
  await wide.fill("#password", PASSWORD);
  await wide.click('button[type="submit"]');
  await wide.waitForURL(/aufnahmen/, { timeout: 60000 });
  await wide.waitForTimeout(1000);
  const headShown = await wide.locator("thead").first().isVisible();
  record(
    `Bei ${width} px ${width < 700 ? "Karten" : "Tabelle"}`,
    width < 700 ? !headShown : headShown,
    headShown ? "Spaltenköpfe sichtbar" : "Spaltenköpfe ausgeblendet",
  );
  const measured = await overflow(wide);
  record(
    `Kein Überlauf bei ${width} px`,
    measured.dokument <= measured.fenster + 1,
    `${measured.dokument} px`,
  );
  await wide.screenshot({ path: join(OUT, `06-${width}px.png`) });
  await context.close();
}

/* --- Desktop bleibt unverändert ----------------------------------------- */
const desktop = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: "de-CH" });
const big = await desktop.newPage();
await big.goto(`${BASE}/anmelden`, { waitUntil: "load" });
await big.fill("#email", EMAIL);
await big.fill("#password", PASSWORD);
await big.click('button[type="submit"]');
await big.waitForURL(/aufnahmen/, { timeout: 60000 });
await big.waitForTimeout(1000);
record(
  "Auf dem Desktop unverändert eine Zeile im Kopf",
  (await big.locator('header a:has-text("Sammelupload"):visible').count()) === 1 &&
    (await big.locator('header button:has-text("Abmelden"):visible').count()) === 1 &&
    (await big.locator('header button[aria-expanded]:visible').count()) === 0,
);
const headers = await big.locator("thead th").allInnerTexts();
record("Tabelle auf dem Desktop mit allen Spalten", headers.length === 10, `${headers.length} Spalten`);
const desktopCell = (await big.locator("tbody tr td").nth(2).innerText()).trim();
record(
  "Kartenbeschriftungen auf dem Desktop ausgeblendet",
  !/Telefonnummer/i.test(desktopCell),
  desktopCell.replace(/\s+/g, " ").slice(0, 60),
);
await big.screenshot({ path: join(OUT, "07-desktop.png") });
await desktop.close();

await browser.close();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden.`);
console.log("Screenshots:", OUT);
process.exit(failed.length === 0 ? 0 : 1);
