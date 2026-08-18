/**
 * Kurzprüfung: Die Passwort-vergessen-Seite darf den Reset-Link niemals zeigen –
 * weder für eine bestehende noch für eine unbekannte Adresse.
 *
 *   node scripts/check-reset-link.mjs [basis-url]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3123";

const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;

for (const email of ["samir.weber@immotrustag.ch", "gibtesnicht@immotrustag.ch"]) {
  await page.goto(`${BASE}/passwort-vergessen`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.click("button[type=submit]");
  await page.waitForSelector(".notice[role=alert]", { timeout: 20000 });
  await page.waitForTimeout(500);

  const notice = (await page.textContent(".notice[role=alert]"))?.replace(/\s+/g, " ").trim() ?? "";
  const tokenLinks = await page.$$eval("a[href*='token=']", (nodes) => nodes.map((n) => n.getAttribute("href")));
  const tokenInBody = /passwort-neu\?token=|token=[A-Za-z0-9_-]{16,}/.test(await page.content());

  const clean = tokenLinks.length === 0 && !tokenInBody;
  if (!clean) failures += 1;
  console.log(`${clean ? "OK  " : "FEHL"} ${email}`);
  console.log(`     Meldung: ${notice}`);
  if (!clean) console.log(`     Gefunden: ${JSON.stringify(tokenLinks)} inBody=${tokenInBody}`);
}

await browser.close();
console.log(failures === 0 ? "\nBestanden: kein Reset-Link sichtbar." : `\nFehlgeschlagen (${failures}).`);
process.exit(failures === 0 ? 0 : 1);
