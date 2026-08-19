/**
 * Abnahmehilfe für das Bearbeiten und Löschen von Kommentaren.
 *
 * Geprüft wird, dass
 *  - ein eigener Kommentar (Kennzeichen „Sie“) „Bearbeiten“ und „Löschen“ trägt,
 *  - der Text im Feld weiterbearbeitbar ist und die Änderung mit dem Hinweis
 *    „bearbeitet am …“ neben dem Erstellungszeitpunkt sichtbar bleibt,
 *  - das Löschen eine kurze Rückfrage stellt und danach greift,
 *  - fremde Kommentare für Mitarbeitende keine Aktionen anbieten,
 *  - der Superuser sie im Admin-Dashboard nach Rückfrage entfernen kann.
 *
 *   node scripts/check-kommentare.mjs [basis-url]
 *
 * Der Lauf räumt seine Testkommentare selbst wieder ab.
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const BASE = process.argv.find((arg) => arg.startsWith("http")) ?? "http://localhost:3010";
const USER = { email: "samir.weber@immotrustag.ch", password: "Immotrust2026!" };
// Das Passwort des Superusers gehört der Kundschaft und steht nicht im
// Repository; für den Admin-Teil wird es übergeben:
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/check-kommentare.mjs
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "jonathanslehner@gmail.com",
  password: process.env.ADMIN_PASSWORD,
};

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "OK  " : "FEHL"} ${label}${detail ? ` – ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1500, height: 950 },
  locale: "de-CH",
  timezoneId: "Europe/Zurich",
});
const page = await context.newPage();

async function anmelden({ email, password }) {
  await page.goto(`${BASE}/anmelden`, { waitUntil: "networkidle" });
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("button", { name: "Abmelden" }).waitFor({ timeout: 90000 });
}

async function abmelden() {
  await page.getByRole("button", { name: "Abmelden" }).click();
  await page.waitForURL(/anmelden/, { timeout: 60000 });
}

/* ------------------------------------------------ Mitarbeitende: eigener Kommentar */

await anmelden(USER);
await page.goto(`${BASE}/aufnahmen`, { waitUntil: "networkidle" });
await page.locator('tbody tr a:has-text("Öffnen")').first().click();
await page.waitForURL(/aufnahmen\/rec_/, { timeout: 60000 });
const detailUrl = page.url();

// Eindeutige Kennung, damit Reste eines abgebrochenen Laufs die Prüfung nicht
// verfälschen.
const stamp = `${randomUUID().slice(0, 8)} ${new Date().toISOString()}`;
const original = `Prüfkommentar ${stamp}`;
await page.fill("#kommentar", original);
await page.getByRole("button", { name: "Kommentar speichern" }).click();
await page.waitForSelector(`text=${original.slice(0, 32)}`, { timeout: 30000 });

let eigener = page.locator("article", { hasText: original });
const kopf = await eigener.locator("header").innerText();
check(
  "Eigener Kommentar mit Kennzeichen „Sie“ und Aktionen",
  kopf.includes("Sie") &&
    (await eigener.getByRole("button", { name: "Bearbeiten" }).count()) === 1 &&
    (await eigener.getByRole("button", { name: "Löschen", exact: true }).count()) === 1,
  kopf.replace(/\s+/g, " "),
);

/* Bearbeiten */
await eigener.getByRole("button", { name: "Bearbeiten" }).click();
const feldWert = await eigener.locator("textarea").inputValue();
const geaendert = `${original} – korrigiert`;
await eigener.locator("textarea").fill(geaendert);
await eigener.getByRole("button", { name: "Änderung speichern" }).click();
// Der geänderte Text beginnt wie der ursprüngliche; gewartet wird deshalb auf
// den Änderungshinweis, nicht auf den Textanfang.
await page.locator("article", { hasText: geaendert }).waitFor({ timeout: 30000 });

eigener = page.locator("article", { hasText: geaendert });
await eigener.locator("text=/bearbeitet am/").first().waitFor({ timeout: 30000 });
const kopfNachher = await eigener.locator("header").innerText();
check(
  "Text weiterbearbeitbar und Änderung gespeichert",
  feldWert === original && (await eigener.innerText()).includes("korrigiert"),
  `Feld enthielt „${feldWert.slice(0, 40)}…“`,
);
check(
  "Hinweis „bearbeitet am …“ zusätzlich zum Erstellungszeitpunkt",
  /bearbeitet am \d/.test(kopfNachher) && kopfNachher.split("bearbeitet am")[0].trim().length > 0,
  kopfNachher.replace(/\s+/g, " "),
);

/* Löschen mit Rückfrage */
await eigener.getByRole("button", { name: "Löschen", exact: true }).click();
const rueckfrage = await eigener
  .locator("text=Diesen Kommentar endgültig löschen?")
  .first()
  .isVisible();
const nochDa = (await page.locator("article", { hasText: geaendert }).count()) === 1;
await eigener.getByRole("button", { name: "Abbrechen" }).click();
check(
  "Löschen fragt zuerst zurück und löscht nicht sofort",
  rueckfrage && nochDa,
  rueckfrage ? "Rückfrage erschien" : "keine Rückfrage",
);

await eigener.getByRole("button", { name: "Löschen", exact: true }).click();
await eigener.getByRole("button", { name: "Endgültig löschen" }).click();
await page.waitForFunction(
  (text) => !document.body.innerText.includes(text),
  geaendert.slice(0, 32),
  { timeout: 30000 },
);
await page.reload({ waitUntil: "networkidle" });
check(
  "Eigener Kommentar nach Bestätigung dauerhaft entfernt",
  (await page.locator("article", { hasText: geaendert }).count()) === 0,
);

/* Fremdkommentar für den Superuser stehen lassen */
const fremd = `Fremdkommentar der Prüfung ${stamp}`;
await page.fill("#kommentar", fremd);
await page.getByRole("button", { name: "Kommentar speichern" }).click();
await page.waitForSelector(`text=${fremd.slice(0, 32)}`, { timeout: 30000 });
await abmelden();

/* --------------------------------------------- Superuser: fremder Kommentar */

if (!ADMIN.password) {
  console.log(
    "\nADMIN_PASSWORD fehlt – der Admin-Teil wird übersprungen. Der Prüfkommentar bleibt stehen.",
  );
  await browser.close();
  const offen = results.filter((entry) => !entry.ok);
  process.exit(offen.length === 0 ? 0 : 1);
}

await anmelden(ADMIN);
await page.goto(detailUrl, { waitUntil: "networkidle" });
const fremdAufDetail = page.locator("article", { hasText: fremd });
check(
  "Fremder Kommentar bietet auf der Detailseite keine Aktionen",
  (await fremdAufDetail.getByRole("button", { name: "Bearbeiten" }).count()) === 0 &&
    (await fremdAufDetail.getByRole("button", { name: "Löschen", exact: true }).count()) === 0,
);

await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
const eintrag = page.locator("li", { hasText: fremd }).first();
const gelistet = (await eintrag.count()) > 0;
check("Fremder Kommentar im Admin-Dashboard gelistet", gelistet);

if (gelistet) {
  await eintrag.getByRole("button", { name: "Kommentar entfernen" }).click();
  const adminRueckfrage = await eintrag.locator("text=/entfernen\\?/").first().isVisible();
  await eintrag.getByRole("button", { name: "Entfernen", exact: true }).click();
  await page.waitForFunction((text) => !document.body.innerText.includes(text), fremd.slice(0, 32), {
    timeout: 30000,
  });
  await page.goto(detailUrl, { waitUntil: "networkidle" });
  check(
    "Superuser entfernt fremden Kommentar nach Rückfrage",
    adminRueckfrage && (await page.locator("article", { hasText: fremd }).count()) === 0,
    adminRueckfrage ? "Rückfrage erschien" : "keine Rückfrage",
  );
}

await browser.close();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden.`);
process.exit(failed.length === 0 ? 0 : 1);
