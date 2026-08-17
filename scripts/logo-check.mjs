/**
 * Prüft Logo und E-Mail-Validierung in der gebauten Anwendung:
 * Bildmarke auf allen öffentlichen Seiten, ausgelieferte Icon-Dateien,
 * Fehlermeldung bei nicht zugelassener Adresse und keine Hinweistexte
 * zur Domainbeschränkung.
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   node scripts/logo-check.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3010";
const OUT = join(tmpdir(), "gaz-check");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "de-CH" });
const page = await context.newPage();

const failed = [];
const consoleErrors = [];
page.on("requestfailed", (r) => {
  const error = r.failure()?.errorText ?? "";
  // Durch eine Folgenavigation abgebrochene Anfragen sind kein Fehler.
  if (error.includes("ERR_ABORTED")) return;
  failed.push(`${r.url()} ${error}`);
});
page.on("response", (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

const results = [];
const record = (name, ok, detail = "") => results.push(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` – ${detail}` : ""}`);

for (const path of ["/", "/anmelden", "/registrieren", "/passwort-vergessen"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const logos = await page.locator('img[src="/marke/immotrust-logo.svg"]').count();
  record(`Logo auf ${path}`, logos > 0, `${logos} Vorkommen`);
  const body = await page.locator("body").innerText();
  const leaks = ["@immotrustag.ch offen", "Zugang ausschliesslich", "Adresse des Superusers", "Erlaubt sind ausschliesslich"]
    .filter((t) => body.includes(t));
  record(`Keine Zugangs-Werbetexte auf ${path}`, leaks.length === 0, leaks.join(" | "));
}

for (const asset of ["/marke/immotrust-logo.svg", "/favicon.ico", "/icon.png", "/apple-icon.png"]) {
  const res = await page.request.get(BASE + asset);
  record(`Asset ${asset}`, res.ok(), `${res.status()} ${res.headers()["content-type"]}`);
}

const iconLinks = await page.evaluate(() =>
  [...document.querySelectorAll('link[rel*="icon"]')].map((l) => l.getAttribute("href")),
);
record("Favicon-Links im HTML", iconLinks.length > 0, iconLinks.join(", "));

await page.goto(BASE + "/registrieren", { waitUntil: "networkidle" });
await page.fill("#name", "Test Person");
await page.fill("#email", "test.person@gmail.com");
await page.fill("#password", "Immotrust2026!");
await page.fill("#passwordRepeat", "Immotrust2026!");
await page.click("button[type=submit]");
await page.locator(".notice[role=alert]").waitFor({ timeout: 30000 });
const message = (await page.locator(".notice[role=alert]").innerText()).replace(/\s+/g, " ");
record("Validierungsfehler fremde Adresse", message.includes("nicht zugelassen"), message);
record("E-Mail-Feld als ungültig markiert", (await page.getAttribute("#email", "aria-invalid")) === "true");
record("Kein Superuser-Leak in der Meldung", !message.includes("jonathanslehner"), message);
await page.screenshot({ path: join(OUT, "logo-validierung.png") });

await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.screenshot({ path: join(OUT, "logo-startseite.png") });

record("Keine fehlgeschlagenen Requests", failed.length === 0, failed.join(" | "));
record("Keine Konsolenfehler", consoleErrors.length === 0, consoleErrors.join(" | "));

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
