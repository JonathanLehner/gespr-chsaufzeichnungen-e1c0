/**
 * Prüft, dass kein Absatz mit einem einzelnen Wort in der letzten Zeile endet.
 *
 *   BASE=https://… node scripts/check-umbruch.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3010";
const CASES = [
  { path: "/", width: 1440, selector: "main p, main li" },
  { path: "/", width: 390, selector: "main p, main li" },
  { path: "/bestaetigen?token=ungueltig", width: 1440, selector: "main p" },
  { path: "/bestaetigen?token=ungueltig", width: 390, selector: "main p" },
];

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? "chrome" });
let failures = 0;
for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: c.width, height: 900 } });
  await page.goto(BASE + c.path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const orphans = await page.$$eval(c.selector, (els) =>
    els.flatMap((el) => {
      // Wortpositionen über Ranges ermitteln und nach Zeilen gruppieren.
      const words = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const m of n.data.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const rect = r.getClientRects()[0];
          if (rect) words.push({ w: m[0], top: Math.round(rect.top) });
        }
      }
      const tops = [...new Set(words.map((w) => w.top))];
      if (tops.length < 2) return [];
      const last = words.filter((w) => w.top === tops.at(-1));
      // Lange technische Kennungen (der Beispiel-Dateiname) passen nur allein in
      // eine Zeile; sie zählen nicht als einzelnes Wort.
      return last.length === 1 && last[0].w.length <= 30 ? [`${last[0].w} (${el.textContent.trim().slice(0, 50)}…)`] : [];
    }),
  );
  console.log(`${c.path} @${c.width}px: ${orphans.length ? "EINZELWORT " + orphans.join(" | ") : "ok"}`);
  failures += orphans.length;
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
