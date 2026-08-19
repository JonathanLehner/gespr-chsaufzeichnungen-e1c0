/**
 * Abnahmehilfe für die Seite „Einstellungen“ und den Anzeigenamen.
 *
 * Geprüft wird, dass
 *  - die Seite über die Navigation erreichbar ist,
 *  - der aktuelle Name im Feld steht,
 *  - ein leerer oder zu kurzer Name abgewiesen wird,
 *  - ein geänderter Name gespeichert wird und sofort im Kopfbereich steht,
 *  - der Name auch an bereits vorhandenen Kommentaren mitgezogen wird,
 *  - die E-Mail-Adresse unveränderlich bleibt.
 *
 *   node scripts/check-einstellungen.mjs [basis-url]
 *
 * Der Lauf setzt den ursprünglichen Namen am Ende wieder ein.
 */
import { chromium } from "playwright";

const BASE = process.argv.find((arg) => arg.startsWith("http")) ?? "http://localhost:3010";
const USER = { email: "samir.weber@immotrustag.ch", password: "Immotrust2026!" };

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

const feld = () => page.getByLabel("Vor- und Nachname");
const speichern = () => page.getByRole("button", { name: "Namen speichern" });
// Auf die Meldung des Formulars eingrenzen: Next stellt zusätzlich einen
// Seitenansager mit role="alert" bereit.
const meldung = () => page.locator("form .notice").first();

async function speichereNamen(name) {
  // Nach dem Absenden steht die Meldung des vorigen Versuchs noch da. Gewartet
  // wird deshalb darauf, dass sie sich ändert, nicht nur darauf, dass es sie
  // gibt.
  const vorher = (await meldung().count()) > 0 ? (await meldung().innerText()).trim() : "";
  await feld().fill(name);
  await speichern().click();
  await page.waitForFunction(
    (alt) => {
      const knopf = document.querySelector("form button[type=submit][aria-busy]");
      if (knopf && knopf.getAttribute("aria-busy") === "true") return false;
      const notiz = document.querySelector("form .notice");
      return Boolean(notiz) && notiz.innerText.trim() !== alt;
    },
    vorher,
    { timeout: 20000 },
  );
  return (await meldung().innerText()).trim();
}

let ursprung = "";

try {
  await page.goto(`${BASE}/anmelden`, { waitUntil: "networkidle" });
  await page.getByLabel("E-Mail-Adresse").fill(USER.email);
  await page.getByLabel("Passwort").fill(USER.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("button", { name: "Abmelden" }).waitFor({ timeout: 60000 });

  // Navigation
  await page.getByRole("link", { name: "Einstellungen" }).first().click();
  await page.waitForURL("**/einstellungen", { timeout: 20000 });
  check("Einstellungen über die Navigation erreichbar", true);

  ursprung = await feld().inputValue();
  check("Aktueller Name steht im Feld", ursprung.length > 0, ursprung);

  const adresse = await page.getByText(USER.email, { exact: true }).count();
  check("E-Mail-Adresse wird angezeigt und nicht als Feld angeboten", adresse > 0);
  check(
    "Kein Eingabefeld für die E-Mail-Adresse",
    (await page.locator('input[name="email"]').count()) === 0,
  );

  // Zu kurzer Name
  const kurz = await speichereNamen("A");
  check("Zu kurzer Name wird abgewiesen", /mindestens/i.test(kurz), kurz);
  check("Name blieb dabei unverändert", (await headerName()) === ursprung, await headerName());

  // Gültige Änderung
  const neu = `Prüfname ${Date.now().toString().slice(-5)}`;
  const gespeichert = await speichereNamen(neu);
  check("Änderung wird bestätigt", /gespeichert/i.test(gespeichert), gespeichert);
  await page.reload({ waitUntil: "networkidle" });
  check("Neuer Name steht im Kopfbereich", (await headerName()) === neu, await headerName());
  check("Neuer Name steht im Feld", (await feld().inputValue()) === neu);

  // Mitgezogene Kopien: der Name an den eigenen Aufnahmen. Die Bestätigung
  // nennt die Zahl der angepassten Einträge; hat das Konto keine, entfällt sie
  // und es gibt in der Tabelle nichts zu prüfen.
  const angepasst = Number(/(\d+) bereits vorhandene/.exec(gespeichert)?.[1] ?? 0);
  await page.goto(`${BASE}/aufnahmen`, { waitUntil: "networkidle" });
  // Nur die Spalte „Hochgeladen von“ zeigt den Kontonamen. Die Spalte
  // „Anrufer“ daneben stammt aus dem Dateinamen und darf sich nicht ändern.
  const hochgeladenVon = page.locator('td:has-text("Hochgeladen von")');
  const namen = (await hochgeladenVon.allInnerTexts()).map((text) =>
    text.replace(/^Hochgeladen von\s*/i, "").trim(),
  );
  if (angepasst > 0) {
    check(
      "Name ist an den vorhandenen Einträgen angepasst",
      namen.includes(neu) && !namen.includes(ursprung),
      `${namen.filter((n) => n === neu).length} von ${namen.length} Zeilen`,
    );
  } else {
    check(
      "Ohne eigene Einträge bleiben fremde Namen unberührt",
      !namen.includes(neu) && !namen.includes(ursprung),
      `Uploader in der Liste: ${[...new Set(namen)].join(", ")}`,
    );
  }

  // Unveränderte Eingabe
  await page.goto(`${BASE}/einstellungen`, { waitUntil: "networkidle" });
  const nochmal = await speichereNamen(neu);
  check("Unveränderte Eingabe meldet keinen Fehler", /unverändert/i.test(nochmal), nochmal);
} finally {
  if (ursprung) {
    await page.goto(`${BASE}/einstellungen`, { waitUntil: "networkidle" });
    await speichereNamen(ursprung);
    console.log(`Ursprünglicher Name wiederhergestellt: ${ursprung}`);
  }
  await browser.close();
}

async function headerName() {
  return (await page.locator("header p.font-semibold").first().innerText()).trim();
}

const fehler = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - fehler.length}/${results.length} Prüfungen bestanden.`);
process.exit(fehler.length === 0 ? 0 : 1);
