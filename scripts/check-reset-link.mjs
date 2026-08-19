/**
 * Prüft den Weg zu einem vergessenen Passwort von Anfang bis Ende:
 *
 *  1. Die Passwort-vergessen-Seite zeigt den Reset-Link nie und antwortet für
 *     bestehende und unbekannte Adressen identisch.
 *  2. Der Postausgang im Admin-Dashboard zeigt ebenfalls keinen Reset-Link.
 *  3. „Reset-Link erzeugen“ in der Kontenliste zeigt dem Superuser einen Link,
 *     mit dem sich das Passwort tatsächlich neu setzen lässt.
 *
 * Voraussetzung: `npm run build` und `npm run start -- -p 3123` laufen.
 *
 *   ADMIN_PASSWORD=… node scripts/check-reset-link.mjs [basis-url]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3123";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "jonathanslehner@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RUN = Date.now();
const TEST_EMAIL = `pruefung.mail.${RUN}@immotrustag.ch`;
const FIRST_PASSWORD = "Immotrust2026!";
const NEW_PASSWORD = `Neu${RUN}!ab`;

let failures = 0;
function record(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

async function visit(path) {
  await page.goto(path.startsWith("http") ? path : `${BASE}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(500);
}

async function notice() {
  await page.waitForSelector(".notice[role=alert]", { timeout: 30000 });
  await page.waitForTimeout(400);
  return (await page.textContent(".notice[role=alert]"))?.replace(/\s+/g, " ").trim() ?? "";
}

async function login(email, password) {
  await visit("/anmelden");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
  return page
    .getByRole("button", { name: "Abmelden" })
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
}

async function logout() {
  const button = page.getByRole("button", { name: "Abmelden" });
  if (await button.count()) {
    await button.click();
    await page.waitForURL(/\/anmelden/, { timeout: 30000 }).catch(() => {});
  }
}

/* 1 – Die öffentliche Seite gibt nichts preis. */

const notices = [];
for (const email of [ADMIN_EMAIL, `gibtesnicht.${RUN}@immotrustag.ch`]) {
  await visit("/passwort-vergessen");
  await page.fill("#email", email);
  await page.click("button[type=submit]");
  const text = await notice();

  const tokenLinks = await page.$$eval("a[href*='token=']", (nodes) =>
    nodes.map((node) => node.getAttribute("href")),
  );
  const tokenInBody = /passwort-neu\?token=|token=[A-Za-z0-9_-]{16,}/.test(await page.content());
  notices.push(text);
  record(`kein Reset-Link sichtbar für ${email}`, tokenLinks.length === 0 && !tokenInBody, text.slice(0, 80));
}
record(
  "identische Meldung für bestehende und unbekannte Adresse",
  notices[0] === notices[1],
  notices[1]?.slice(0, 80),
);

/* 2 – Ein frisches Konto, damit der Reset niemandem das Passwort verstellt. */

await visit("/registrieren");
await page.fill("#name", "Prüfung Mailversand");
await page.fill("#email", TEST_EMAIL);
await page.fill("#password", FIRST_PASSWORD);
await page.fill("#passwordRepeat", FIRST_PASSWORD);
await page.click("button[type=submit]");
const registerNotice = await notice();

// Ohne eingerichteten Versand wird der Bestätigungslink weiterhin angezeigt;
// ist der Versand eingerichtet, geht er ausschliesslich per E-Mail hinaus.
const verifyLink = await page.getAttribute("a[href^='/bestaetigen']", "href").catch(() => null);
let verified = true;
if (verifyLink) {
  await visit(verifyLink);
  verified = ((await page.textContent("body")) ?? "").includes("bestätigt");
}
record(
  verifyLink ? "Testkonto angelegt und bestätigt" : "Testkonto angelegt, Bestätigung per E-Mail",
  verified,
  `${TEST_EMAIL} · ${registerNotice.slice(0, 60)}`,
);

/* 3 – Der Superuser erzeugt einen Reset-Link. */

if (!ADMIN_PASSWORD) {
  console.log(
    "\nADMIN_PASSWORD fehlt – Teil 3 (Reset-Link im Admin-Dashboard) wurde übersprungen.\n" +
      "  ADMIN_PASSWORD=… node scripts/check-reset-link.mjs",
  );
} else {
  await logout();
  const adminIn = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  record("Anmeldung als Superuser", adminIn);

  await visit("/admin");
  const row = page.locator("tr", { hasText: TEST_EMAIL }).first();
  await row.waitFor({ timeout: 30000 });
  await row.getByRole("button", { name: "Reset-Link erzeugen" }).click();

  const field = row.locator("input[aria-label^='Reset-Link']");
  await field.waitFor({ timeout: 30000 });
  const link = await field.inputValue();
  record("Reset-Link wird dem Superuser angezeigt", /\/passwort-neu\?token=/.test(link), link.slice(0, 60) + "…");

  const outboxLinks = await page.$$eval("a[href*='passwort-neu']", (nodes) => nodes.length);
  record("Postausgang zeigt weiterhin keinen Reset-Link", outboxLinks === 0);

  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(link, { waitUntil: "load" });
  await freshPage.waitForTimeout(400);
  await freshPage.fill("#password", NEW_PASSWORD);
  await freshPage.fill("#passwordRepeat", NEW_PASSWORD);
  await freshPage.click("button[type=submit]");
  await freshPage.waitForSelector(".notice[role=alert]", { timeout: 30000 });
  const resetNotice = (await freshPage.textContent(".notice[role=alert]"))?.trim() ?? "";
  record("Passwort über den Link gesetzt", resetNotice.includes("Passwort geändert"), resetNotice.slice(0, 80));

  await fresh.close();
  await logout();
  const userIn = await login(TEST_EMAIL, NEW_PASSWORD);
  record("Anmeldung mit dem neuen Passwort", userIn);
  await logout();
}

await browser.close();
console.log(
  failures === 0
    ? "\nBestanden. Testkonto danach entfernen: npx tsx --env-file=.env.local --conditions=react-server scripts/cleanup-testdata.mts"
    : `\nFehlgeschlagen (${failures}).`,
);
process.exit(failures === 0 ? 0 : 1);
