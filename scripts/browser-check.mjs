/**
 * Prüft die gebaute Anwendung in einem echten Browser.
 * Voraussetzung: `npm run build` und `npm run start -- -p 3010` laufen.
 *
 *   node scripts/browser-check.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3010";
const OUT = join(tmpdir(), "gaz-check");
mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];
const failedRequests = [];
const rscOnStatic = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

function toneWav(seconds = 3, sampleRate = 16000) {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(2500 * Math.sin((2 * Math.PI * 420 * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();

let staticPhase = true;
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(`${page.url()} :: ${message.text()}`);
});
page.on("requestfailed", (request) => {
  failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`);
});
page.on("request", (request) => {
  if (staticPhase && request.url().includes("_rsc=")) rscOnStatic.push(request.url());
});

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

/**
 * Navigiert und wartet, bis die Seite interaktiv ist. Ohne diese Wartezeit
 * treffen Eingaben gelegentlich auf noch nicht hydrierte Formulare; deren
 * Ereignishandler fehlen dann und der Klick bleibt wirkungslos.
 */
async function visit(path, options = {}) {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: "load", ...options });
  await page.waitForTimeout(600);
  return response;
}

/**
 * Wartet, bis `check()` zutrifft. Server Actions und Datenbankschreibvorgänge
 * brauchen gegen eine entfernte Umgebung deutlich länger als lokal; feste
 * Wartezeiten würden dort zu falschen Fehlschlägen führen.
 */
async function waitFor(check, { timeout = 25000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(interval);
  }
}

/* 1 – Öffentliche Seiten */
await visit("/", { waitUntil: "networkidle" });
record("Startseite lädt", (await page.locator("h1").first().innerText()).includes("Verkaufsgespräch"));
await shot("01-start");
for (const path of ["/anmelden", "/registrieren", "/passwort-vergessen"]) {
  const response = await visit(path);
  record(`Direktaufruf ${path}`, response?.status() === 200, `Status ${response?.status()}`);
}
record("Keine _rsc-Anfragen auf statischen Seiten", rscOnStatic.length === 0, rscOnStatic.join(", "));
staticPhase = false;

/* 2 – Registrierung mit nicht zugelassener Adresse */
await visit(`/registrieren`);
await page.fill("#name", "Test Person");
await page.fill("#email", "test.person@gmail.com");
await page.fill("#password", "Immotrust2026!");
await page.fill("#passwordRepeat", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForSelector('.notice[role="alert"]');
const denied = await page.locator('.notice[role="alert"]').innerText();
record("Fremde Domain abgewiesen", denied.includes("nicht zugelassen"), denied.slice(0, 90));
await shot("02-registrierung-abgewiesen");

/* 3 – Registrierung, Bestätigung, Anmeldung */
record(
  "Eingegebener Name bleibt nach einem Fehler erhalten",
  (await page.inputValue("#name")) === "Test Person",
  await page.inputValue("#name"),
);
const testEmail = `pia.roth+${Date.now()}@immotrustag.ch`;
await page.fill("#email", testEmail);
await page.fill("#password", "Immotrust2026!");
await page.fill("#passwordRepeat", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForSelector("text=Link jetzt öffnen");
record("Registrierung erzeugt Bestätigungslink", true);
await shot("03-registrierung-ok");

await visit(`/anmelden`);
await page.fill("#email", testEmail);
await page.fill("#password", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForSelector('.notice[role="alert"]');
const notVerified = await page.locator('.notice[role="alert"]').innerText();
record(
  "Anmeldung ohne Bestätigung blockiert",
  notVerified.includes("nicht bestätigt"),
  notVerified.slice(0, 80),
);

await visit(`/registrieren`);
await page.fill("#name", "Pia Roth");
await page.fill("#email", testEmail);
await page.fill("#password", "Immotrust2026!");
await page.fill("#passwordRepeat", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForSelector("text=Link jetzt öffnen");
await page.click("text=Link jetzt öffnen");
await page.waitForURL(/bestaetigen/);
const confirmed = await page.locator('.notice[role="alert"]').innerText();
record("E-Mail-Bestätigung erfolgreich", confirmed.includes("bestätigt"), confirmed.slice(0, 80));
await shot("04-bestaetigt");

await visit(`/bestaetigen?token=abgelaufen123`);
const invalidToken = await page.locator('.notice[role="alert"]').innerText();
record("Ungültiger Bestätigungslink erklärt", invalidToken.includes("ungültig"), invalidToken.slice(0, 80));

await visit(`/anmelden`);
await page.fill("#email", testEmail);
await page.fill("#password", "Falsch123456");
await page.click('button[type="submit"]');
await page.waitForSelector('.notice[role="alert"]');
const wrongPassword = await page.locator('.notice[role="alert"]').innerText();
record("Falsches Passwort gemeldet", wrongPassword.includes("nicht korrekt"), wrongPassword.slice(0, 80));

/* 4 – Passwort zurücksetzen: der Link darf im Browser nie erscheinen */

/** Fordert einen Reset an und liefert Meldung sowie alle sichtbaren Token-Links. */
async function requestReset(email) {
  await visit(`/passwort-vergessen`);
  await page.fill("#email", email);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.notice[role="alert"]');
  await page.waitForTimeout(500);
  const notice = (await page.locator('.notice[role="alert"]').innerText())
    .replace(/\s+/g, " ")
    .trim();
  const links = await page.$$eval("a[href*='token=']", (nodes) =>
    nodes.map((node) => node.getAttribute("href")),
  );
  const inBody = /passwort-neu\?token=|token=[A-Za-z0-9_-]{16,}/.test(await page.content());
  return { notice, links, inBody };
}

const knownReset = await requestReset(testEmail);
record(
  "Reset-Link wird nie angezeigt (bestehendes Konto)",
  knownReset.links.length === 0 && !knownReset.inBody,
  knownReset.notice.slice(0, 90),
);
const unknownReset = await requestReset(`unbekannt.${Date.now()}@immotrustag.ch`);
record(
  "Reset-Link wird nie angezeigt (unbekannte Adresse)",
  unknownReset.links.length === 0 && !unknownReset.inBody,
  unknownReset.notice.slice(0, 90),
);
record(
  "Antwort verrät nicht, ob ein Konto besteht",
  knownReset.notice === unknownReset.notice,
  knownReset.notice === unknownReset.notice ? "identische Meldung" : unknownReset.notice.slice(0, 90),
);

await visit(`/passwort-neu?token=abgelaufen`);
await page.fill("#password", "NeuesPasswort2026");
await page.fill("#passwordRepeat", "NeuesPasswort2026");
await page.click('button[type="submit"]');
await page.waitForSelector('.notice[role="alert"]');
const badReset = await page.locator('.notice[role="alert"]').innerText();
record("Abgelaufener Reset-Link erklärt", badReset.includes("ungültig") || badReset.includes("abgelaufen"), badReset.slice(0, 80));

/* 5 – Anmeldung als Mitarbeitende */
await visit(`/anmelden`);
await page.fill("#email", testEmail);
await page.fill("#password", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForURL(/aufnahmen/);
record("Anmeldung nach Reset-Anfrage weiterhin möglich", true);

/* 6 – Kein Admin-Zugriff für normale Konten */
await visit(`/admin`);
record(
  "Admin-Dashboard für Mitarbeitende gesperrt",
  (await page.locator("h1").first().innerText()).includes("Kein Zugriff"),
);
await shot("05-admin-gesperrt");

/* 7 – Übersicht, Suche, Filter, Sortierung */
await visit(`/aufnahmen`);
const rowCount = await page.locator("tbody tr").count();
record("Aufnahmenübersicht zeigt Zeilen", rowCount > 0, `${rowCount} Zeilen`);
await shot("06-uebersicht");

// Ausgangsbestand für den Abschlussvergleich: Der Testlauf darf ausser seinen
// eigenen Aufnahmen nichts entfernen.
await visit(`/aufnahmen?pageSize=100`);
const stockBefore = await page.locator("tbody tr").count();

await page.fill("#q", "Nebenkosten");
await page.click('button:has-text("Anwenden")');
await page.waitForURL(/q=Nebenkosten/);
const markCount = await page.locator("mark").count();
record("Volltextsuche mit hervorgehobenem Ausschnitt", markCount > 0, `${markCount} Hervorhebungen`);
await shot("07-suche");

/* 7b – Tabellenspalten */
await visit(`/aufnahmen`);
const headers = await page.locator("thead th").allInnerTexts();
const expectedHeaders = [
  "Anrufer",
  "Telefonnummer",
  "Anrufnr.",
  "Gesprächszeitpunkt (CET)",
  "Hochgeladen von",
  "Bewertung",
  "Transkription",
  "Löschmarkierung",
];
const normalizedHeaders = headers.map((title) => title.toLocaleLowerCase("de-CH"));
const missingHeaders = expectedHeaders.filter(
  (title) => !normalizedHeaders.includes(title.toLocaleLowerCase("de-CH")),
);
record("Tabelle zeigt alle geforderten Spalten", missingHeaders.length === 0, missingHeaders.join(", "));

/* 7c – Filter */
const allRows = await page.locator("tbody tr").count();
await page.selectOption("#uploader", { label: "Lena Brunner" });
await page.selectOption("#status", "abgeschlossen");
await page.selectOption("#loeschstatus", "ohne_markiert");
await page.fill("#von", "2026-06-01");
await page.fill("#bis", "2026-06-30");
await page.fill('input[aria-label="Bewertung von"]', "5");
await page.fill('input[aria-label="Bewertung bis"]', "10");
await page.click('button:has-text("Anwenden")');
await page.waitForURL(/uploader=/);
const filteredRows = await page.locator("tbody tr").count();
const uploaderCells = await page.locator("tbody tr td:nth-child(6)").allInnerTexts();
const statusCells = await page.locator("tbody tr td:nth-child(8)").allInnerTexts();
record(
  "Filter nach Autor, Status, Datum, Bewertung und Löschstatus",
  filteredRows > 0 &&
    filteredRows < allRows &&
    uploaderCells.every((cell) => cell.includes("Lena Brunner")) &&
    statusCells.every((cell) => cell.includes("Abgeschlossen")),
  `${filteredRows} von ${allRows} Zeilen`,
);
record(
  "Filter lassen sich zurücksetzen",
  (await page.locator('a:has-text("Zurücksetzen")').count()) > 0,
);
await shot("07b-filter");

/* 7d – Sortierung */
await visit(`/aufnahmen?sort=name_az`);
const namesAz = (await page.locator("tbody tr td:nth-child(2)").allInnerTexts()).map((cell) =>
  cell.trim(),
);
const sortedAz = [...namesAz].sort((a, b) => a.localeCompare(b, "de-CH"));
record(
  "Sortierung nach Anrufername",
  JSON.stringify(namesAz) === JSON.stringify(sortedAz),
  namesAz.join(" | "),
);
await visit(`/aufnahmen?sort=bewertung_hoch`);
const scores = (await page.locator("tbody tr td:nth-child(7)").allInnerTexts()).map((cell) => {
  const match = /(\d+(?:[.,]\d)?)/.exec(cell);
  return match ? Number(match[1].replace(",", ".")) : -1;
});
record(
  "Sortierung nach Bewertung absteigend",
  scores.every((value, index) => index === 0 || scores[index - 1] >= value),
  scores.join(", "),
);

/* 7e – Serverseitige Seitennavigation */
await visit(`/aufnahmen?pageSize=5`);
const firstPageRows = await page.locator("tbody tr").count();
const hasPager = (await page.locator('nav[aria-label="Seitennavigation"]').count()) > 0;
if (hasPager) {
  const firstPageFirstCell = (await page.locator("tbody tr td").first().innerText()).trim();
  await page.click('nav[aria-label="Seitennavigation"] a:has-text("Weiter")');
  await page.waitForURL(/page=2/);
  const secondPageFirstCell = (await page.locator("tbody tr td").first().innerText()).trim();
  record(
    "Serverseitige Seitennavigation",
    firstPageFirstCell !== secondPageFirstCell,
    `Seite 1: ${firstPageRows} Zeilen, Seite 2 beginnt anders`,
  );
} else {
  record("Serverseitige Seitennavigation", false, "keine Seitennavigation gefunden");
}
await shot("07c-seiten");

await visit(`/aufnahmen?q=Nebenkosten`);
const hitLink = page.locator('a[href*="?t="]').first();
const hasHit = (await hitLink.count()) > 0;
if (hasHit) {
  const href = await hitLink.getAttribute("href");
  await hitLink.click();
  await page.waitForURL(/aufnahmen\/rec_/);
  record("Transkripttreffer springt an Zeitposition", /t=\d+/.test(href ?? ""), href ?? "");
} else {
  record("Transkripttreffer springt an Zeitposition", false, "kein Treffer-Link gefunden");
}

/* 8 – Detailansicht */
await page.waitForSelector("canvas", { timeout: 30000 });
record("Wellenform gerendert", (await page.locator("canvas").count()) > 0);
await page.waitForTimeout(1500);
await page.click('button:has-text("Abspielen")');
await page.waitForTimeout(2500);
const isPaused = await page.evaluate(() => {
  const audio = document.querySelector("audio");
  return audio ? audio.paused : true;
});
record("Wiedergabe startet", !isPaused);
const positionText = await page.locator('[aria-label="Wiedergabeposition"]').innerText();
const [playedPart] = positionText.split("/");
record(
  "Zeitanzeige läuft mit",
  /\d+:\d\d/.test(positionText) && playedPart.trim() !== "0:00",
  positionText.replace(/\s+/g, " "),
);
await page.click('button:has-text("Pause")');

await page.selectOption('select[aria-label="Wiedergabegeschwindigkeit"]', "1.5");
const rate = await page.evaluate(() => document.querySelector("audio")?.playbackRate);
record("Wiedergabegeschwindigkeit umgestellt", rate === 1.5, `rate ${rate}`);

await page.evaluate(() => {
  const slider = document.querySelector('input[aria-label="Lautstärke"]');
  if (!slider) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(slider, "0.4");
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
const volume = await page.evaluate(() => document.querySelector("audio")?.volume ?? -1);
record("Lautstärke regelbar", Math.abs(volume - 0.4) < 0.05, `volume ${volume}`);

await page.click('button[aria-label="10 Sekunden vor"]');
await page.waitForTimeout(400);
const scrubbed = await page.evaluate(() => document.querySelector("audio")?.currentTime ?? 0);
record("Scrubbing über die Bedienelemente", scrubbed > 0, `${scrubbed.toFixed(1)} s`);

const sentence = page.locator('[id^="satz-"]').nth(4);
await sentence.locator("span[role='button']").first().click();
await page.waitForTimeout(800);
const seeked = await page.evaluate(() => document.querySelector("audio")?.currentTime ?? 0);
record("Klick auf Wort springt im Audio", seeked > 0, `${seeked.toFixed(1)} s`);

/* 8b – Synchron mitlaufendes Transkript */
await page.click('button:has-text("Abspielen")');
await page.waitForTimeout(3000);
const highlighted = await page.evaluate(() => {
  const active = document.querySelector('[id^="satz-"].bg-petrol-soft');
  return active ? active.id : null;
});
record("Aktuell gesprochene Passage hervorgehoben", Boolean(highlighted), highlighted ?? "keine");
const speakerBadges = await page.locator('[id^="satz-"] .badge').allInnerTexts();
record(
  "Transkript nach Sprecher gegliedert",
  new Set(speakerBadges).size >= 2,
  [...new Set(speakerBadges)].join(", "),
);
await page.click('button:has-text("Pause")');

/* 8c – Metadaten der Aufnahme */
const metaTerms = await page.locator("dt").allInnerTexts();
const expectedTerms = [
  "Anrufer",
  "Telefonnummer",
  "Anrufnummer",
  "Gesprächszeitpunkt (CET)",
  "Originaldateiname",
  "Metadatenquelle",
  "Hochgeladen von",
  "Upload-Zeitpunkt",
  "Transkription",
];
const missingTerms = expectedTerms.filter((term) => !metaTerms.includes(term));
record("Alle Metadaten sowie Upload- und Transkriptionsstatus sichtbar", missingTerms.length === 0, missingTerms.join(", "));
await shot("08-detail");

await page.fill('input[aria-label="Im Transkript suchen"]', "Wohnung");
await page.waitForTimeout(400);
const matchInfo = await page.locator("text=/Treffer \\d+ von \\d+|Kein Treffer/").first().innerText();
record("Suche im Transkript", matchInfo.length > 0, matchInfo);
await page.click('button[aria-label="Nächster Treffer"]');
await page.waitForTimeout(500);

/* 9 – Kommentar und Bewertung */
const commentText = `Automatische Prüfung ${new Date().toISOString()}`;
await page.fill("#kommentar", commentText);
await page.click('button:has-text("Kommentar speichern")');
await page.waitForSelector(`text=${commentText.slice(0, 30)}`, { timeout: 15000 });
record("Kommentar gespeichert", true);

await page.click('button[aria-pressed="false"]:has-text("7")');
await page.waitForSelector("text=/Bewertung gespeichert|Bewertung wurde aktualisiert/", { timeout: 15000 });
record("Bewertung gespeichert", true);
await shot("09-kommentar-bewertung");

/* 10 – Löschmarkierung durch Mitarbeitende */
await page.click('button:has-text("Zur Löschung markieren")');
await page.fill('input[id^="grund-"]', "Prüfung durch die Qualitätssicherung");
await page.click('button:has-text("Markierung setzen")');
await page.waitForSelector("text=zur Löschung markiert", { timeout: 15000 });
record("Löschmarkierung gesetzt ohne Datenverlust", (await page.locator("canvas").count()) > 0);
await page.click('button:has-text("Markierung aufheben")');
await page.waitForTimeout(2000);

/* 11 – Sammelupload */
const okName = "[Ziegler, Nina]_386-0441234567_20260710094512(1150).wav";
const badName = "Aufnahme-ohne-Muster.wav";
const okPath = join(OUT, okName);
const badPath = join(OUT, badName);
writeFileSync(okPath, toneWav(3));
writeFileSync(badPath, toneWav(2));
const txtPath = join(OUT, "notiz.txt");
writeFileSync(txtPath, "keine Audiodatei");

await visit(`/upload`);
await page.setInputFiles('input[type="file"]', [okPath, badPath, txtPath]);
await page.waitForSelector("text=Bereit", { timeout: 30000 });
const parsedRow = await page.locator("tbody tr", { hasText: "Ziegler" }).innerText();
record("Metadaten aus Dateiname erkannt", parsedRow.includes("Nina Ziegler") && parsedRow.includes("10.07.2026"), parsedRow.replace(/\s+/g, " ").slice(0, 120));
record(
  "Nicht lesbarer Dateiname markiert",
  (await page.locator("text=Dateiname nicht lesbar").count()) > 0,
);
record(
  "Falscher Dateityp abgewiesen",
  (await page.locator("text=Nicht unterstütztes Dateiformat").count()) > 0,
);
await shot("10-upload-liste");

await page.locator("tbody tr", { hasText: "Aufnahme-ohne-Muster" }).locator('button:has-text("Daten erfassen")').click();
await page.waitForSelector('[role="dialog"]');
await page.fill("#vorname", "Rolf");
await page.fill("#nachname", "Zimmermann");
await page.fill("#telefon", "386-0449998877");
await page.fill("#anrufnummer", "1151");
await page.fill("#zeitpunkt", "2026-07-11T15:20");
await page.click('button:has-text("Übernehmen")');
await page.waitForTimeout(500);
record(
  "Korrektur-Modal ergänzt Metadaten",
  (await page.locator("tbody tr", { hasText: "Rolf Zimmermann" }).count()) > 0,
);
await shot("11-upload-korrektur");

/* 11b – Drag-and-drop */
const dropName = "[Kunz, Silvan]_386-0447771122_20260712081500(1152).wav";
const dropPath = join(OUT, dropName);
writeFileSync(dropPath, toneWav(2));
const dropBase64 = readFileSync(dropPath).toString("base64");
await page.evaluate(
  async ({ name, base64 }) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], name, { type: "audio/wav" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const zone = document.querySelector('input[type="file"]').parentElement;
    zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  },
  { name: dropName, base64: dropBase64 },
);
await page.waitForSelector("tbody tr:has-text('Silvan Kunz')", { timeout: 30000 });
record("Drag-and-drop übernimmt Dateien", true, dropName);

const uploadCount = await page.locator("tbody tr").count();
record("Mehrfachauswahl in der Dateiliste", uploadCount >= 4, `${uploadCount} Dateien in der Liste`);

await page.click('button:has-text("hochladen")');
await page.waitForSelector("text=Hochgeladen", { timeout: 120000 });
await page.locator('button:has-text("Upload läuft")').waitFor({ state: "detached", timeout: 120000 });
await page.waitForTimeout(3000);
const uploaded = await page.locator("text=Hochgeladen").count();
record("Upload mit Ergebnisstatus je Datei", uploaded >= 1, `${uploaded} erfolgreich`);
await shot("12-upload-fertig");

/* 11c – Bereits vorhandene Datei wird vor dem Absenden erkannt */
await page.click('button:has-text("Liste leeren")');
await page.setInputFiles('input[type="file"]', [okPath]);
await page.waitForSelector("tbody tr", { timeout: 30000 });
await page.waitForTimeout(1200);
const duplicateNotice = await page.locator("text=bereits hochgeladen").count();
record("Bereits vorhandene Datei erkannt", duplicateNotice > 0, `${duplicateNotice} Hinweis(e)`);
await shot("12b-upload-duplikat");

/* 11d – Verarbeitungszustand ohne Transkript */
await visit(`/aufnahmen?q=Ziegler`);
await page.locator("tbody tr", { hasText: "Ziegler" }).first().locator('a:has-text("Öffnen")').click();
await page.waitForURL(/aufnahmen\/rec_/);
const transcriptState = await page
  .locator('section[role="status"], section[role="alert"], section:has(> h2:text("Transkript"))')
  .first()
  .innerText()
  .catch(() => "");
record(
  "Verarbeitungszustand sichtbar, solange kein Transkript vorliegt",
  /Transkription läuft|Warteschlange|fehlgeschlagen|Transkript/i.test(transcriptState),
  transcriptState.replace(/\s+/g, " ").slice(0, 110),
);
await shot("12c-verarbeitung");

/* 12 – Abmelden */
await page.click('button:has-text("Abmelden")');
await page.waitForURL(/anmelden/);
record("Abmelden funktioniert", true);

/* 13 – Superuser */
await page.fill("#email", "jonathanslehner@gmail.com");
await page.fill("#password", "Immotrust2026!");
await page.click('button[type="submit"]');
await page.waitForURL(/aufnahmen/);
await visit(`/admin`);
record("Admin-Dashboard für Superuser sichtbar", (await page.locator("h1").innerText()).includes("Admin-Dashboard"));
await shot("13-admin");

await page.fill("#testname", "[Weber, Samir]_386-0447523770_20260601130748(1135)");
record(
  "Standardvorlage erkennt das Beispiel",
  await waitFor(async () => (await page.locator("text=liest den Testdateinamen korrekt").count()) > 0),
);
await page.fill("#vorlage", "[{Nachname}, {Vorname}]_{Telefonnummer}");
const templateError = await page
  .locator(".notice-error", { hasText: "DatumZeit" })
  .first()
  .waitFor({ state: "visible", timeout: 20000 })
  .then(() => true)
  .catch(() => false);
record(
  "Ungültige Vorlage wird gemeldet",
  templateError,
  templateError ? await page.locator(".notice-error").first().innerText() : "keine Meldung",
);
await shot("14-admin-vorlage");

/* 13b – Platzhalter einfügen und eigene Vorlage speichern */
await page.fill("#vorlage", "");
for (const token of ["{Nachname}", "{Vorname}", "{DatumZeit}", "{Telefonnummer}", "{Anrufnummer}"]) {
  await page.click(`button:has-text("${token}")`);
  if (token !== "{Anrufnummer}") {
    await page.locator("#vorlage").press("End");
    await page.locator("#vorlage").pressSequentially("_");
  }
}
await page.waitForTimeout(900);
const customTemplate = await page.inputValue("#vorlage");
record(
  "Platzhalter über Schaltflächen einfügbar",
  customTemplate === "{Nachname}_{Vorname}_{DatumZeit}_{Telefonnummer}_{Anrufnummer}",
  customTemplate,
);
await page.fill("#testname", "Kunz_Silvan_20260712081500_386-0447771122_1152");
record(
  "Eigene Vorlage in der Vorschau geprüft",
  await waitFor(async () => (await page.locator("text=liest den Testdateinamen korrekt").count()) > 0),
  customTemplate,
);
await page.click('button:has-text("Vorlage speichern")');
await page.waitForSelector("text=/Vorlage gespeichert \\(Version \\d+\\)/", { timeout: 30000 });
const savedNotice = await page.locator("text=/Vorlage gespeichert \\(Version \\d+\\)/").first().innerText();
record("Neue Vorlage gespeichert und versioniert", true, savedNotice.slice(0, 90));
await page.click('button:has-text("Standardvorlage wiederherstellen")');
const DEFAULT_TEMPLATE = "[{Nachname}, {Vorname}]_{Telefonnummer}_{DatumZeit}({Anrufnummer})";
record(
  "Standardvorlage wiederherstellbar",
  await waitFor(async () => (await page.inputValue("#vorlage")) === DEFAULT_TEMPLATE),
  await page.inputValue("#vorlage"),
);

const jobRows = await page.locator("table tbody tr").count();
record("Auftragsübersicht gefüllt", jobRows > 0, `${jobRows} Zeilen`);
const jobSections = (await page.locator("h3").allInnerTexts()).map((title) =>
  title.toLocaleLowerCase("de-CH"),
);
record(
  "Aufträge nach laufend, fehlgeschlagen und abgeschlossen gegliedert",
  jobSections.some((title) => title.includes("laufend")) &&
    jobSections.some((title) => title.includes("fehlgeschlagen")) &&
    jobSections.some((title) => title.includes("abgeschlossen")),
  jobSections.join(" | "),
);

/* 13c – Transkription manuell erneut starten */
const retryButton = page.locator('button:has-text("Erneut starten")').first();
if ((await retryButton.count()) > 0) {
  await retryButton.click();
  await page.waitForSelector("text=/neu gestartet/", { timeout: 60000 });
  const retryMessage = await page.locator("text=/neu gestartet/").first().innerText();
  record("Transkription manuell erneut startbar", true, retryMessage.slice(0, 90));
} else {
  record("Transkription manuell erneut startbar", false, "keine Schaltfläche gefunden");
}
await shot("14b-admin-auftraege");

/* 14 – Endgültiges Löschen der Testaufnahmen */
const TEST_NAMES = ["Ziegler", "Zimmermann", "Kunz"];
let confirmationChecked = false;
let removedAll = true;

for (const name of TEST_NAMES) {
  await visit(`/aufnahmen?q=${name}`);
  const testRow = page.locator("tbody tr", { hasText: name }).first();
  if ((await testRow.count()) === 0) continue;
  // Eine Testaufnahme aus einem abgebrochenen Lauf kann bereits markiert sein.
  const markButton = testRow.locator('button:has-text("Zur Löschung markieren")');
  if ((await markButton.count()) > 0) {
    await markButton.click();
    await page.fill('input[id^="grund-"]', "Testaufnahme der automatischen Prüfung");
    await page.click('button:has-text("Markierung setzen")');
    await page.waitForTimeout(2500);
  }

  const flaggedSection = page.locator("section", {
    has: page.locator('h2:has-text("Zur Löschung markierte Aufnahmen")'),
  });
  const flaggedRow = flaggedSection.locator("tbody tr", { hasText: name }).first();
  // Die Markierung erscheint im Admin erst, wenn der Schreibvorgang durch ist.
  const flaggedVisible = await waitFor(async () => {
    await visit(`/admin`);
    return (await flaggedRow.count()) > 0;
  });
  if (!flaggedVisible) {
    record(`Löschmarkierung im Admin sichtbar (${name})`, false, "Zeile nicht gefunden");
    removedAll = false;
    continue;
  }
  if (!confirmationChecked) {
    record("Zur Löschung markierte Aufnahmen im Admin gelistet", true, name);
  }
  await flaggedRow.locator('button:has-text("Endgültig löschen")').click();
  await page.waitForSelector('[role="dialog"]');
  if (!confirmationChecked) {
    const disabled = await page
      .locator('[role="dialog"] button:has-text("Endgültig löschen")')
      .isDisabled();
    record("Löschdialog verlangt Bestätigungstext", disabled);
    confirmationChecked = true;
  }
  await page.fill('[role="dialog"] input', "LÖSCHEN");
  await page.click('[role="dialog"] button:has-text("Endgültig löschen")');
  const gone = await waitFor(async () => {
    await visit(`/aufnahmen?q=${name}`);
    return (await page.locator("tbody tr", { hasText: name }).count()) === 0;
  });
  if (!gone) removedAll = false;
}
record("Endgültiges Löschen entfernt die Aufnahmen", removedAll, TEST_NAMES.join(", "));

/* 15 – Demobestand vollständig und unverändert */
await visit(`/aufnahmen?pageSize=100`);
const finalRows = await page.locator("tbody tr").count();
record(
  "Bestand nach der Prüfung unverändert",
  finalRows === stockBefore,
  `${finalRows} von zuvor ${stockBefore} Aufnahmen`,
);
await visit(`/aufnahmen?loeschstatus=nur_markiert`);
record(
  "Bestehende Löschmarkierung weiterhin vorhanden",
  (await page.locator("tbody tr", { hasText: "Lena Brunner" }).count()) > 0,
);
await shot("15-nach-loeschung");

/* Abschluss */
console.log("\nKonsolenfehler:", consoleErrors.length);
consoleErrors.slice(0, 10).forEach((entry) => console.log("  ", entry));
// Abgebrochene Anfragen entstehen, wenn der Test während eines laufenden
// Prefetch weiternavigiert. Nur echte Fehler sind relevant.
const hardFailures = failedRequests.filter((entry) => !entry.includes("ERR_ABORTED"));
console.log(
  `Fehlgeschlagene Anfragen: ${hardFailures.length} (zusätzlich ${failedRequests.length - hardFailures.length} durch Navigation abgebrochen)`,
);
hardFailures.slice(0, 10).forEach((entry) => console.log("  ", entry));
record("Keine fehlgeschlagenen Netzwerkanfragen", hardFailures.length === 0, hardFailures.slice(0, 3).join(" | "));
record("Keine Konsolenfehler", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden.`);
console.log("Screenshots:", OUT);

await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
