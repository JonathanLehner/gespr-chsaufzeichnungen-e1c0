/**
 * Design-Prüfung: sucht Text, der aus seinem Behälter läuft, sowie waagrechte
 * Überläufe des Fensters, und legt zu jeder Seite einen Bildschirmabzug ab.
 * Geprüft wird bei 1440, 1180 und 390 px Breite.
 *
 * Die Passwörter gehören den Konten der Kundschaft und stehen bewusst nicht im
 * Repository:
 *
 *   AUDIT_PASSWORD=… node scripts/design-audit.mjs
 *   BASE=http://localhost:3010 AUDIT_PASSWORD=… ADMIN_PASSWORD=… node scripts/design-audit.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.BASE ?? "https://gespr-chsaufzeichnungen-e1c0.clawcorp.ai";
const USER = {
  email: process.env.AUDIT_EMAIL ?? "samir.weber@immotrustag.ch",
  password: process.env.AUDIT_PASSWORD,
};
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "jonathanslehner@gmail.com",
  password: process.env.ADMIN_PASSWORD,
};
if (!USER.password) {
  console.error("AUDIT_PASSWORD fehlt – ohne Anmeldung sind nur die öffentlichen Seiten prüfbar.");
  process.exit(1);
}
const OUT = join(tmpdir(), "gaz-design");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1180, height: 800 },
  { name: "mobil", width: 390, height: 844 },
];

/** Findet Elemente, deren Inhalt breiter ist als ihr Kasten. */
const OVERFLOW_PROBE = `(() => {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    out.push({ kind: "seite", info: doc.scrollWidth + " > " + doc.clientWidth });
  }
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\\s+/).slice(0, 5).join(".");
    return el.tagName.toLowerCase() + id + (cls ? "." + cls : "");
  };
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.overflowX !== "visible" && style.overflowX !== "clip") continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      // Nur melden, wenn kein Vorfahre scrollen darf.
      let p = el.parentElement, scrollable = false;
      while (p) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === "auto" || ps.overflowX === "scroll") { scrollable = true; break; }
        p = p.parentElement;
      }
      if (!scrollable) {
        out.push({
          kind: "element",
          info: describe(el) + " scrollWidth " + el.scrollWidth + " > clientWidth " + el.clientWidth,
          text: (el.innerText || "").replace(/\\s+/g, " ").slice(0, 70),
        });
      }
    }
  }
  // Text, der über die rechte Kante einer Karte hinausragt. Waagrecht
  // scrollbare Bereiche (breite Tabellen) sind so gewollt und bleiben aussen vor.
  const scrolls = (el) => {
    let p = el;
    while (p) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === "auto" || ps.overflowX === "scroll") return true;
      p = p.parentElement;
    }
    return false;
  };
  for (const card of document.querySelectorAll(".card, section, td, dd, li")) {
    const box = card.getBoundingClientRect();
    if (box.width === 0) continue;
    if (card.querySelector("[class*=overflow-x-auto], table")) continue;
    if (scrolls(card)) continue;
    for (const child of card.querySelectorAll("*")) {
      const cb = child.getBoundingClientRect();
      if (cb.width === 0) continue;
      if (cb.right > box.right + 2 || cb.left < box.left - 2) {
        out.push({
          kind: "ausbruch",
          info: describe(child) + " ragt aus " + describe(card) +
            " (" + Math.round(cb.right - box.right) + "px rechts)",
          text: (child.innerText || "").replace(/\\s+/g, " ").slice(0, 70),
        });
      }
    }
  }
  const seen = new Set();
  return out.filter((o) => { const k = o.kind + o.info; if (seen.has(k)) return false; seen.add(k); return true; });
})()`;

const browser = await chromium.launch();
const problems = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    locale: "de-CH",
    timezoneId: "Europe/Zurich",
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`!! Konsolenfehler ${vp.name}: ${message.text()}`);
  });
  // Abgebrochene Vorablade-Anfragen (_rsc) entstehen beim Weiterklicken und
  // sind kein Fehler; alles andere wird gemeldet.
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    if (reason.includes("ERR_ABORTED")) return;
    console.log(`!! Anfrage fehlgeschlagen ${vp.name}: ${request.url()} – ${reason}`);
  });

  // Auf schmalen Geräten liegt „Abmelden“ im aufklappbaren Menü; deshalb wird
  // der Anmeldeerfolg über die Zieladresse geprüft.
  async function signIn(who) {
    await page.goto(`${BASE}/anmelden`, { waitUntil: "networkidle" });
    await page.getByLabel("E-Mail-Adresse").fill(who.email);
    await page.getByLabel("Passwort").fill(who.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await page.waitForURL(/\/aufnahmen/, { timeout: 90000 });
    await page.waitForLoadState("networkidle");
  }

  async function signOut() {
    const menu = page.getByRole("button", { name: "Menü" });
    if (await menu.count()) await menu.first().click();
    await page.getByRole("button", { name: "Abmelden" }).click();
    await page.getByRole("heading", { name: "Anmelden" }).waitFor({ timeout: 60000 });
  }

  async function audit(label, url, prepare) {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    if (prepare) await prepare();
    await page.waitForTimeout(1200);
    const found = await page.evaluate(OVERFLOW_PROBE);
    for (const item of found) problems.push({ viewport: vp.name, label, ...item });
    await page.screenshot({ path: join(OUT, `${vp.name}-${label}.png`), fullPage: true });
    console.log(`${found.length ? "!!" : "ok"} ${vp.name} ${label} (${found.length})`);
    for (const item of found) console.log(`     ${item.kind}: ${item.info}${item.text ? ` — "${item.text}"` : ""}`);
  }

  await audit("start", "/");
  await audit("anmelden", "/anmelden");
  await audit("registrieren", "/registrieren");

  await signIn(USER);
  await audit("aufnahmen", "/aufnahmen");
  await audit("menue", "/aufnahmen", async () => {
    const menu = page.getByRole("button", { name: "Menü" });
    if (await menu.count()) await menu.first().click();
  });
  await audit("suche", "/aufnahmen?q=Hypothek");
  await audit("upload", "/upload");

  const href = await page
    .goto(`${BASE}/aufnahmen`, { waitUntil: "networkidle" })
    .then(() => page.locator('tbody tr td a[href^="/aufnahmen/"]').first().getAttribute("href"));
  if (href) await audit("detail", href, () => page.waitForTimeout(2500));

  if (ADMIN.password) {
    try {
      await signOut();
      await signIn(ADMIN);
      await audit("admin", "/admin");
    } catch {
      console.log(`-- ${vp.name} admin übersprungen (Anmeldung als Superuser fehlgeschlagen)`);
    }
  } else {
    console.log(`-- ${vp.name} admin übersprungen (ADMIN_PASSWORD nicht gesetzt)`);
  }

  await context.close();
}

await browser.close();

console.log(`\n===== ${problems.length} Befund(e) · Bilder in ${OUT} =====`);
const grouped = new Map();
for (const p of problems) {
  const key = `${p.kind} | ${p.info}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(`${p.viewport}/${p.label}`);
}
for (const [key, where] of grouped) console.log(`${key}\n    ${where.join(", ")}`);
