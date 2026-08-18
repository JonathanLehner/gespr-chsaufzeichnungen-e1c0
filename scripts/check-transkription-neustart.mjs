/**
 * Abnahmehilfe für den Neustart fehlgeschlagener Transkriptionen.
 *
 * Geprüft wird, dass eine fehlgeschlagene Aufnahme
 *  - auf der Detailseite eine verständliche deutsche Fehlermeldung zeigt,
 *  - die technische Rohmeldung nur hinter „Technische Details“ preisgibt,
 *  - im Metadatenblock „Letzter Versuch“ statt „Transkription abgeschlossen“ führt,
 *  - auf Detailseite und in der Übersichtszeile eine Schaltfläche
 *    „Transkription erneut starten“ anbietet, die sich beim Klick sofort sperrt
 *    und den Verlauf „Wird gestartet …“ → „In Arbeit …“ anzeigt.
 *
 *   node scripts/check-transkription-neustart.mjs [basis-url] [--klick]
 *
 * Ohne `--klick` bleibt der Lauf reine Anzeigeprüfung und stösst keine
 * Transkription an.
 */
import { chromium } from "playwright";

const BASE = process.argv.find((arg) => arg.startsWith("http")) ?? "http://localhost:3000";
const KLICK = process.argv.includes("--klick");
const USER = { email: "samir.weber@immotrustag.ch", password: "Immotrust2026!" };

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "OK  " : "FEHL"} ${label}${detail ? ` – ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await (
  await browser.newContext({
    viewport: { width: 1500, height: 950 },
    locale: "de-CH",
    timezoneId: "Europe/Zurich",
  })
).newPage();

await page.goto(`${BASE}/anmelden`, { waitUntil: "networkidle" });
await page.getByLabel("E-Mail-Adresse").fill(USER.email);
await page.getByLabel("Passwort").fill(USER.password);
await page.getByRole("button", { name: "Anmelden", exact: true }).click();
await page.getByRole("button", { name: "Abmelden" }).waitFor({ timeout: 90000 });

/* ------------------------------------------------------------------ Übersicht */

await page.goto(`${BASE}/aufnahmen?status=fehlgeschlagen`, { waitUntil: "networkidle" });
const rows = page.locator("tbody tr").filter({ hasText: "Fehlgeschlagen" });
const rowCount = await rows.count();

if (rowCount === 0) {
  console.log("Zurzeit ist keine Aufnahme fehlgeschlagen – nichts zu prüfen.");
  await browser.close();
  process.exit(0);
}

const statusCell = (await rows.first().locator("td").nth(7).innerText()).trim();
check(
  "Übersicht zeigt verständliche Meldung statt Rohtext",
  /Transkriptionsdienst|Verbindung|Audiodatei/.test(statusCell) && !/error code|\/gemini/.test(statusCell),
  statusCell.replace(/\n/g, " · "),
);
check(
  "Übersichtszeile bietet „Transkription erneut starten“",
  (await rows.first().getByRole("button", { name: /Transkription erneut starten/ }).count()) === 1,
);

/* ----------------------------------------------------------------- Detailseite */

const href = await rows.first().locator('a[href^="/aufnahmen/rec_"]').first().getAttribute("href");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });

const alert = page.getByRole("alert").filter({ hasText: "Transkription fehlgeschlagen" });
await alert.waitFor();
const alertText = (await alert.innerText()).trim();
check(
  "Detailseite nennt die Ursache in verständlichem Deutsch",
  /Transkriptionsdienst|Verbindung|Audiodatei/.test(alertText),
  alertText.split("\n")[1],
);
check(
  "Detailseite verweist nicht mehr allein auf die Administration",
  !/Administration kann die Transkription im Admin-Dashboard/.test(alertText),
);

const technical = page.getByText(/error code|\/gemini fehlgeschlagen/).first();
const hasTechnical = (await technical.count()) > 0;
if (hasTechnical) {
  check("Rohmeldung ist zunächst eingeklappt", !(await technical.isVisible()));
  await page.getByText("Technische Details").first().click();
  await page.waitForTimeout(250);
  check("Rohmeldung erscheint nach „Technische Details“", await technical.isVisible());
} else {
  check("Rohmeldung liefert keinen Zusatznutzen und entfällt", true);
}

const metadata = await page.locator("dl").first().innerText();
check("Metadatenblock führt „Letzter Versuch“", /Letzter Versuch/.test(metadata));
check(
  "Metadatenblock nennt bei Fehlschlag kein „Transkription abgeschlossen“",
  !/Transkription abgeschlossen/.test(metadata),
);

const button = alert.getByRole("button").first();
check("Detailseite bietet „Transkription erneut starten“", /erneut starten/.test(await button.innerText()));

if (KLICK) {
  await button.click();
  await button.click({ force: true }).catch(() => {}); // Doppelklick muss folgenlos bleiben
  await page.waitForTimeout(150);
  check(
    "Schaltfläche sperrt sofort und meldet „Wird gestartet“",
    (await button.isDisabled()) && /Wird gestartet/.test(await button.innerText()),
  );
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("In Arbeit")),
      undefined,
      { timeout: 60000 },
    )
    .catch(() => {});
  check("Verlauf wechselt auf „In Arbeit“", /In Arbeit/.test(await button.innerText()));
}

console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} Prüfungen bestanden.`,
);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
