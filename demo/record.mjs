/**
 * Demoaufzeichnung der Live-Anwendung "Gesprächsaufzeichnungen – Immotrust AG".
 *
 * Der Ablauf entspricht exakt dem zuvor im Browser verifizierten Pfad:
 * öffentliche Startseite, Registrierungsschutz, Anmeldung als Mitarbeitender,
 * Aufnahmenübersicht mit Filtern, Sortierung und Seitennavigation, globale
 * Suche mit Transkripttreffer, Aufnahmedetail mit Waveform-Player und
 * synchronisiertem Transkript, Kommentar, Bewertung, Löschmarkierung,
 * Sammelupload inklusive Korrektur-Modal sowie das Admin-Dashboard.
 *
 * Ausführen:
 *   CLAWCORP_VIDEO_DIR=<Zielordner> node demo/record.mjs
 *
 * Ergebnis: <Zielordner>/<zufall>.webm und <Zielordner>/scenes.json
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = "https://gespr-chsaufzeichnungen-e1c0.clawcorp.ai";

const videoDir = process.env.CLAWCORP_VIDEO_DIR;
if (!videoDir) {
  console.error("CLAWCORP_VIDEO_DIR ist nicht gesetzt. Beispiel:\n" + '  CLAWCORP_VIDEO_DIR="C:\\\\Temp\\\\videos" node demo/record.mjs');
  process.exit(1);
}
mkdirSync(videoDir, { recursive: true });

const USER = { email: "samir.weber@immotrustag.ch", password: "Immotrust2026!" };
const ADMIN = { email: "jonathanslehner@gmail.com", password: "Immotrust2026!" };

// --------------------------------------------------------------- Testdateien
// Pro Lauf eindeutige Dateinamen, damit der Sammelupload nie auf bereits
// vorhandene Dateien läuft.
const STAMP = new Date();
const pad = (n) => String(n).padStart(2, "0");
const RUN = `${STAMP.getFullYear()}${pad(STAMP.getMonth() + 1)}${pad(STAMP.getDate())}${pad(STAMP.getHours())}${pad(STAMP.getMinutes())}${pad(STAMP.getSeconds())}`;

function toneWav(seconds = 3, rate = 16000, freq = 420) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(2500 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Minimale MPEG-1 Layer III Rahmen – genügt für den MP3-Annahmepfad. */
const silentMp3 = (frames = 40) =>
  Buffer.concat(Array.from({ length: frames }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));

const work = path.join(os.tmpdir(), `clawcorp-demo-${RUN}`);
mkdirSync(work, { recursive: true });
const FILE_WAV = path.join(work, `[Steiner, Nadine]_386-0447700112_${RUN}(1201).wav`);
const FILE_MP3 = path.join(work, `[Hofer, Daniel]_412-0443311998_${RUN}(1202).mp3`);
const FILE_UNREADABLE = path.join(work, `Gespraech-ohne-Namensmuster-${RUN}.wav`);
const FILE_UNSUPPORTED = path.join(work, `notiz-${RUN}.txt`);
writeFileSync(FILE_WAV, toneWav(3));
writeFileSync(FILE_MP3, silentMp3());
writeFileSync(FILE_UNREADABLE, toneWav(2, 16000, 330));
writeFileSync(FILE_UNSUPPORTED, "keine Audiodatei");

// -------------------------------------------------------------------- Setup
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  locale: "de-CH",
  timezoneId: "Europe/Zurich",
});
const page = await context.newPage();
const t0 = Date.now();
await page.goto(BASE, { waitUntil: "networkidle" });

// ------------------------------------------------------------------- Szenen
const scenes = [];
let cursor = 0;
const elapsed = () => (Date.now() - t0) / 1000;
const round = (v) => Math.round(v * 100) / 100;

/** Klammert einen sichtbaren Abschnitt inklusive Lesepause als eigene Szene. */
async function scene(id, label, body) {
  const start = cursor;
  await body();
  const end = elapsed();
  scenes.push({ id, label, start: round(start), end: round(end) });
  cursor = end;
  console.log(`· ${id} (${round(start)}s – ${round(end)}s) ${label}`);
}

const beat = (ms = 1100) => page.waitForTimeout(ms);

/** Weiches Scrollen, damit der Blick des Zuschauers folgen kann. */
async function smoothScrollTo(y, duration = 1300) {
  await page.evaluate(
    async ([to, dur]) => {
      const from = window.scrollY;
      const distance = Math.max(0, to) - from;
      const started = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          const p = Math.min(1, (now - started) / dur);
          window.scrollTo(0, from + distance * (0.5 - Math.cos(Math.PI * p) / 2));
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    [Math.max(0, y), duration],
  );
  await beat(500);
}

/** Scrollt weich zu einem Element, das über einen Locator bestimmt wird. */
async function smoothScrollToElement(locator, duration = 1300, offset = 90) {
  const target = locator.first();
  await target.waitFor({ state: "attached", timeout: 30000 });
  const box = await target.boundingBox();
  if (!box) return;
  const current = await page.evaluate(() => window.scrollY);
  await smoothScrollTo(current + box.y - offset, duration);
}

const heading = (level, text) => page.getByRole("heading", { name: text, level });
const scrollTop = () => smoothScrollTo(0, 900);
const scrollBottom = () => page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })).then(() => beat(1200));

/** Hält die Wiedergabe an, falls sie gerade läuft. */
async function ensurePaused() {
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.count()) await pause.first().click();
}

async function typeInto(locator, text, delay = 55) {
  await locator.click();
  await locator.pressSequentially(text, { delay });
}

async function signIn({ email, password }) {
  await page.getByLabel("E-Mail-Adresse").click();
  await page.getByLabel("E-Mail-Adresse").pressSequentially(email, { delay: 35 });
  await beat(500);
  await page.getByLabel("Passwort").click();
  await page.getByLabel("Passwort").pressSequentially(password, { delay: 45 });
  await beat(900);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("button", { name: "Abmelden" }).waitFor({ timeout: 90000 });
  await page.waitForLoadState("networkidle");
}

// ============================================================ 1 · Startseite
await scene("startseite", "Öffentliche Startseite der Immotrust AG", async () => {
  await beat(2400);
  await smoothScrollTo(900, 1600);
  await beat(1500);
});

await scene("leistungen", "Leistungsübersicht der Anwendung", async () => {
  await smoothScrollTo(1700, 1600);
  await beat(2000);
  await scrollTop();
});

// ================================================ 2 · Registrierung & Zugang
await scene("registrierung", "Deutsches Registrierungsformular", async () => {
  await page.getByRole("link", { name: "Konto erstellen" }).first().click();
  await page.getByRole("heading", { name: "Konto erstellen" }).waitFor();
  await beat(1500);
  await typeInto(page.getByLabel("Vor- und Nachname"), "Nadine Steiner");
  await beat(400);
  await typeInto(page.getByLabel("E-Mail-Adresse"), "nadine.steiner@gmail.com");
  await beat(400);
  await typeInto(page.getByLabel("Passwort", { exact: true }), "Immotrust2026!", 35);
  await typeInto(page.getByLabel("Passwort wiederholen"), "Immotrust2026!", 35);
  await beat(1000);
});

await scene("zugangsschutz", "Nur verifizierte immotrustag.ch-Adressen zugelassen", async () => {
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 30000 });
  await beat(3200);
});

// ==================================================== 3 · Anmeldung Nutzerin
await scene("anmeldung", "Anmeldung als Mitarbeitender Samir Weber", async () => {
  await page.getByRole("link", { name: "Zur Anmeldung" }).click();
  await page.getByRole("heading", { name: "Anmelden" }).waitFor();
  await beat(1200);
  await signIn(USER);
  await beat(1800);
});

// ================================================== 4 · Aufnahmenübersicht
await scene("aufnahmenuebersicht", "Tabellarische Aufnahmenübersicht mit allen Metadaten", async () => {
  await page.goto(BASE + "/aufnahmen", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Aufnahmen" }).waitFor();
  await beat(2200);
  await smoothScrollToElement(page.locator("table"), 1200);
  await beat(2400);
});

await scene("filter", "Filter nach Transkriptionsstatus und Upload-Autor", async () => {
  await scrollTop();
  await page.getByLabel("Transkription").selectOption("abgeschlossen");
  await beat(900);
  await page.getByLabel("Upload-Autor").selectOption({ label: "Marco Fischer" });
  await beat(1200);
  await page.getByRole("button", { name: "Anwenden" }).click();
  await page.waitForLoadState("networkidle");
  await beat(2600);
});

await scene("sortierung", "Sortierung nach Bewertung und serverseitige Seitengrösse", async () => {
  await page.goto(BASE + "/aufnahmen", { waitUntil: "networkidle" });
  await beat(800);
  await page.getByLabel("Sortierung").selectOption("bewertung_hoch");
  await beat(800);
  await page.getByLabel("Pro Seite").selectOption("5");
  await beat(900);
  await page.getByRole("button", { name: "Anwenden" }).click();
  await page.waitForLoadState("networkidle");
  await beat(2200);
});

await scene("seitennavigation", "Serverseitige Seitennavigation über alle Aufnahmen", async () => {
  await scrollBottom();
  await beat(1400);
  await page.getByRole("link", { name: "Weiter" }).click();
  await page.waitForLoadState("networkidle");
  await beat(1200);
  await scrollBottom();
  await beat(2000);
});

// ================================================ 5 · Globale Suche
await scene("globale-suche", "Globale Suche über Metadaten und Transkriptinhalte", async () => {
  await page.goto(BASE + "/aufnahmen", { waitUntil: "networkidle" });
  await scrollTop();
  await typeInto(page.getByLabel("Suche in Metadaten und Transkripten"), "Hypothek", 90);
  await beat(1100);
  await page.getByRole("button", { name: "Anwenden" }).click();
  await page.waitForLoadState("networkidle");
  await beat(1200);
  await smoothScrollToElement(page.locator("table"), 1100);
  await beat(3000);
});

// =============================================== 6 · Aufnahmedetail
await scene("treffer-oeffnen", "Transkripttreffer springt direkt an die Audioposition", async () => {
  await page.getByRole("link", { name: "0:42" }).click();
  await page.getByRole("button", { name: "Abspielen" }).waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
  await beat(3200);
});

await scene("waveform-player", "Waveform-Player auf Basis von WaveSurfer.js", async () => {
  // Ein Klick auf den Zeitstempel eines Satzes setzt die Position und startet
  // die Wiedergabe – der Umschaltknopf heisst danach "Pause".
  await page.getByRole("button", { name: "0:07", exact: true }).click();
  await beat(5200);
});

await scene("transkript-synchron", "Transkript nach Sprecher und Satz, synchron hervorgehoben", async () => {
  await beat(6500);
});

await scene("player-steuerung", "Sprung, Wiedergabegeschwindigkeit und Lautstärke", async () => {
  // Der Knopf trägt ein aria-label, der zugängliche Name lautet daher nicht "+10 s".
  await page.getByRole("button", { name: "10 Sekunden vor" }).click();
  await beat(1800);
  await page.locator("select").first().selectOption("1.25");
  await beat(2600);
  await page.getByLabel("Lautstärke").fill("0.6");
  await beat(1600);
  await ensurePaused();
  await beat(1400);
});

await scene("wort-sprung", "Klick auf einen Satz springt an den Zeitstempel", async () => {
  await page.getByRole("button", { name: "0:23", exact: true }).click();
  await beat(3000);
  await ensurePaused();
  await beat(900);
});

await scene("transkript-suche", "Suche im geöffneten Transkript mit Treffer-Navigation", async () => {
  // Das Feld ist mit dem Begriff der globalen Suche vorbelegt und wird zuerst geleert.
  await page.getByLabel("Im Transkript suchen").fill("");
  await beat(700);
  await typeInto(page.getByLabel("Im Transkript suchen"), "Eigenkapital", 80);
  await beat(2200);
  await page.getByRole("button", { name: "Nächster Treffer" }).click();
  await beat(1600);
  await page.getByRole("button", { name: "Nächster Treffer" }).click();
  await beat(2200);
});

await scene("metadaten", "Alle Aufnahme-Metadaten samt Upload- und Transkriptionsstatus", async () => {
  await smoothScrollToElement(heading(2, "Metadaten"), 1200);
  await beat(3200);
});

await scene("bewertung", "Persönliche Bewertung von 1 bis 10 mit Autor und Zeitpunkt", async () => {
  await smoothScrollToElement(heading(2, "Bewertung"), 1200);
  await page.getByRole("button", { name: "9", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await beat(3000);
});

await scene("kommentare", "Kommentarbereich mit Text, Autor und Zeitpunkt", async () => {
  await smoothScrollToElement(page.getByRole("heading", { name: /^Kommentare/ }), 1200);
  await beat(900);
  await typeInto(page.getByLabel("Neuer Kommentar"), "Finanzierungsteil sehr sauber erklärt – als Referenzgespräch für neue Mitarbeitende geeignet.", 22);
  await beat(1000);
  await page.getByRole("button", { name: "Kommentar speichern" }).click();
  await page.waitForLoadState("networkidle");
  await beat(3000);
});

await scene("loeschmarkierung", "Nutzer markiert eine Aufnahme zur Löschung – ohne Datenverlust", async () => {
  await scrollTop();
  await beat(800);
  const unmark = page.getByRole("button", { name: "Markierung aufheben" });
  if (await unmark.count()) {
    await unmark.first().click();
    await page.waitForLoadState("networkidle");
    await beat(1500);
  }
  await page.getByRole("button", { name: "Zur Löschung markieren" }).first().click();
  await beat(1500);
  await typeInto(page.getByLabel("Begründung (optional)"), "Doppelte Aufzeichnung des Beratungsgesprächs", 30);
  await beat(1200);
  await page.getByRole("button", { name: "Markierung setzen" }).click();
  await page.waitForLoadState("networkidle");
  await beat(3000);
});

// ================================================== 7 · Sammelupload
await scene("sammelupload", "Sammelupload mit aktiver Dateinamensvorlage", async () => {
  await page.getByRole("link", { name: "Sammelupload" }).click();
  await page.getByRole("heading", { name: "Sammelupload" }).waitFor();
  await page.waitForLoadState("networkidle");
  await beat(3000);
});

await scene("dateiauswahl", "Mehrfachauswahl: Metadaten werden aus dem Dateinamen gelesen", async () => {
  await page.setInputFiles("input[type=file]", [FILE_WAV, FILE_UNREADABLE, FILE_UNSUPPORTED]);
  await page.locator("tbody tr").first().waitFor({ timeout: 90000 });
  await beat(1200);
  await smoothScrollToElement(page.locator("table"), 1200);
  await beat(3400);
});

await scene("drag-and-drop", "Drag-and-drop einer MP3-Datei auf die Ablagefläche", async () => {
  const payload = readFileSync(FILE_MP3).toString("base64");
  await page.evaluate(
    ([name, data, mime]) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const zone = document.querySelector("input[type=file]").parentElement;
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    },
    [path.basename(FILE_MP3), payload, "audio/mpeg"],
  );
  await page.locator("tbody tr", { hasText: "Daniel Hofer" }).waitFor({ timeout: 90000 });
  await beat(3200);
});

await scene("dateipruefung", "Nicht unterstützter Dateityp und unlesbarer Dateiname markiert", async () => {
  await beat(2600);
  await page.locator("tbody tr", { hasText: path.basename(FILE_UNSUPPORTED) }).getByRole("button", { name: "Entfernen" }).click();
  await beat(2200);
});

await scene("korrektur-modal", "Korrektur-Modal für manuell erfasste Metadaten", async () => {
  await page.locator("tbody tr", { hasText: "Gespraech-ohne-Namensmuster" }).getByRole("button", { name: "Daten erfassen" }).click();
  await page.getByRole("dialog").waitFor();
  await beat(2000);
  await typeInto(page.getByLabel("Vorname"), "Rolf", 70);
  await typeInto(page.getByLabel("Nachname"), "Zimmermann", 70);
  await typeInto(page.getByLabel("Telefonnummer"), "386-0449998877", 45);
  await typeInto(page.getByLabel("Anrufnummer"), "1203", 70);
  await page.getByLabel("Gesprächszeitpunkt (CET)").fill("2026-08-17T11:40");
  await beat(1800);
  await page.getByRole("button", { name: "Übernehmen" }).click();
  await beat(2600);
});

await scene("upload-fortschritt", "Individueller Fortschritt und Ergebnisstatus je Datei", async () => {
  await page.getByRole("button", { name: /Dateien hochladen$/ }).click();
  await beat(4000);
  await page
    .locator("tbody tr", { hasText: "Daniel Hofer" })
    .getByText("Hochgeladen", { exact: false })
    .first()
    .waitFor({ timeout: 120000 });
  await beat(3400);
});

// ================================================== 8 · Admin-Dashboard
await scene("rollenwechsel", "Abmeldung und Anmeldung als Superuser", async () => {
  await scrollTop();
  await page.getByRole("button", { name: "Abmelden" }).click();
  await page.getByRole("heading", { name: "Anmelden" }).waitFor({ timeout: 60000 });
  await beat(1600);
  await signIn(ADMIN);
  await beat(1800);
});

await scene("admin-vorlage", "Editor für die Dateinamensvorlage mit Platzhaltern", async () => {
  await page.getByRole("link", { name: "Admin-Dashboard" }).click();
  await page.getByRole("heading", { name: "Admin-Dashboard" }).waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
  await beat(2800);
  await smoothScrollToElement(heading(2, "Dateinamensvorlage"), 1200);
  await beat(2000);
});

await scene("vorlage-test", "Testfeld mit Parse-Vorschau der Standardvorlage", async () => {
  await page.getByLabel("Testdateiname").fill("");
  await typeInto(page.getByLabel("Testdateiname"), "[Weber, Samir]_386-0447523770_20260601130748(1135).wav", 18);
  await beat(4200);
});

await scene("vorlage-validierung", "Validierungsfehler vor dem Speichern einer neuen Vorlage", async () => {
  await page.getByLabel("Vorlage").fill("{Nachname}_{Unbekannt}");
  await beat(5000);
  await page.getByRole("button", { name: "Standardvorlage wiederherstellen" }).click();
  await page.waitForLoadState("networkidle");
  await beat(3000);
});

await scene("admin-auftraege", "Übersicht laufender, abgeschlossener und fehlgeschlagener Aufträge", async () => {
  await smoothScrollToElement(heading(2, "Upload- und Transkriptionsaufträge"), 1400);
  await beat(3000);
  await smoothScrollToElement(page.getByRole("heading", { name: /^Fehlgeschlagen/, level: 3 }), 1300);
  await beat(3000);
});

await scene("admin-neustart", "Manueller Neustart einer fehlgeschlagenen Transkription", async () => {
  await page.getByRole("button", { name: "Erneut starten" }).first().click();
  await page.waitForLoadState("networkidle");
  await beat(3600);
});

await scene("admin-loeschliste", "Liste der von Nutzern zur Löschung markierten Aufnahmen", async () => {
  await smoothScrollToElement(page.getByRole("heading", { name: /^Zur Löschung markierte Aufnahmen/, level: 2 }), 1400);
  await beat(4000);
});

await scene("neue-aufnahmen", "Die soeben hochgeladenen Aufnahmen in der Übersicht", async () => {
  await page.getByRole("link", { name: "Aufnahmen", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await beat(1400);
  await smoothScrollToElement(page.locator("table"), 1200);
  await beat(3200);
});

await scene("abschluss", "Durchsuchbares Archiv der vollständig transkribierten Gespräche", async () => {
  await scrollTop();
  await page.getByLabel("Transkription").selectOption("abgeschlossen");
  await beat(900);
  await page.getByRole("button", { name: "Anwenden" }).click();
  await page.waitForLoadState("networkidle");
  await beat(1200);
  await smoothScrollToElement(page.locator("table"), 1200);
  await beat(4000);
});

// ------------------------------------------------------------------ Abschluss
await context.close();
await browser.close();

writeFileSync(path.join(videoDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf8");
console.log(`\n${scenes.length} Szenen · ${round(cursor)} s · geschrieben nach ${path.join(videoDir, "scenes.json")}`);
