/**
 * Tabellen für docs/vergleich-modelle-2026-11-10.md aus den Ergebnissen von
 * scripts/vergleich-modelle.mts und scripts/pruefung-transcribe-einstellungen.mts.
 *
 *   node scripts/vergleich-modelle-bericht.mjs <modelle/results.json> <einstellungen/results.json> \
 *     <vocabulary.json> <callers-per-call.json> > tabellen.md
 *
 * Nur lesend, keine Datenbank, keine Anfragen.
 */
import { readFileSync } from "node:fs";

const [modelsFile, settingsFile, vocabFile, callersFile] = process.argv.slice(2);
if (!modelsFile || !settingsFile || !vocabFile || !callersFile) {
  console.error("Pfade zu beiden results.json, vocabulary.json und callers-per-call.json sind nötig.");
  process.exit(1);
}
const M = JSON.parse(readFileSync(modelsFile, "utf8"));
const S = JSON.parse(readFileSync(settingsFile, "utf8"));
// Personennamen im Vokabular (Anrufer) und Anrufer je Gespräch laut Dateiname.
const PEOPLE = JSON.parse(readFileSync(vocabFile, "utf8")).filter((t) => /^\p{Lu}\p{L}+ \p{Lu}\p{L}+$/u.test(t) && !/strasse|AG$/.test(t)).slice(-7);
const CALLER = JSON.parse(readFileSync(callersFile, "utf8"));

const CALLS = ["9911", "9295", "8876", "10425", "8369", "8028", "8116", "8355", "8486", "8334", "10980"];
const TEN = CALLS.slice(0, 10);
const DURATION_MIN = { 9911: 1.545, 9295: 1.536, 8876: 1.502, 10425: 1.51, 8369: 1.502, 8028: 4.548, 8116: 2.159, 8355: 1.681, 8486: 1.562, 8334: 1.775, 10980: 6.229 };
const VARIANTS = [
  ["L", "3.5-flash-lite minimal"],
  ["AL", "4-argon low"],
  ["AD", "4-argon Standard"],
  ["CL", "4-carbon low"],
  ["CD", "4-carbon Standard"],
  ["FL", "3.8-flash low"],
  ["FD", "3.8-flash Standard"],
];
// Spot-Check-Fenster (Sekunden, Gesprächszeit).
const WINDOWS = [["10425", 0, 30], ["8028", 60, 90], ["10980", 0, 30]];
// Volumen: Angabe des Kunden und gemessen in der Datenbank (10.11.2026).
const VOLUMES = [["600 Aufnahmen × 5 min (Angabe)", 3000], ["Bestand gemessen: 612 Aufnahmen, 1559 min", 1559]];

const pct = (x) => (x == null || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)} %`);
const usd = (x, d = 4) => (x == null ? "–" : `$${x.toFixed(d)}`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const ok = (r) => r && !r.error;
const out = [];
const p = (line = "") => out.push(line);

/* ------------------------------------------- beste gemini-3.5-transcribe-Variante */
const transcribeVariants = ["A", "B", "C", "D"].map((v) => {
  const rows = TEN.filter((c) => c !== "9911").map((c) => S[`${c}:${v}`]).filter(ok);
  const words = rows.reduce((n, r) => n + r.words, 0), ref = rows.reduce((n, r) => n + r.refWords, 0);
  return { v, n: rows.length, all: CALLS.every((c) => ok(S[`${c}:${v}`])), kept: ref ? words / ref : 0, median: median(rows.map((r) => r.kept)) };
});
const complete = transcribeVariants.filter((t) => t.all);
const best = (complete.length ? complete : transcribeVariants).sort((a, b) => b.kept - a.kept)[0];
const T = best.v;
p(`### gemini-3.5-transcribe: Varianten aus Auftrag 6af37fd2 (ohne 9911)`);
p();
p(`| Variante | Läufe | Wörter behalten, gesamt | Median |`);
p(`| --- | --- | --- | --- |`);
const tLabel = { A: "Opus, ohne Sprache", B: "Opus, de-DE", C: "Original, ohne Sprache", D: "Original, de-DE" };
for (const t of transcribeVariants) p(`| ${t.v} ${tLabel[t.v]} | ${t.n}/10${t.all ? "" : " (unvollständig)"} | ${pct(t.kept)} | ${pct(t.median)} |`);
p();
p(`Beste Variante: **${T} (${tLabel[T]})**.`);
p();

const ALL = [...VARIANTS, ["T", `3.5-transcribe ${T}`]];
const get = (call, v) => (v === "T" ? S[`${call}:${T}`] : M[`${call}:${v}`]);
const header = (first) => { p(`| ${first} | ${ALL.map(([, l]) => l).join(" | ")} |`); p(`| --- | ${ALL.map(() => "---").join(" | ")} |`); };

/* ----------------------------------------------------------------- Übersicht */
p(`### Übersicht (10 Vergleichsgespräche, ohne 10980)`);
p();
header("");
const agg = ALL.map(([v]) => {
  const rows = TEN.map((c) => get(c, v)).filter(ok);
  const noFr = rows.filter((r) => r.call !== "9911");
  const min = rows.reduce((n, r) => n + DURATION_MIN[r.call], 0);
  const u = rows.reduce((a, r) => ({ ai: a.ai + (r.usage.audioInput ?? 0), ti: a.ti + (r.usage.textInput ?? 0), o: a.o + (r.usage.output ?? 0), t: a.t + (r.usage.thinking ?? 0) }), { ai: 0, ti: 0, o: 0, t: 0 });
  const costs = v === "T" ? [{ label: "aktuell", usd: rows.reduce((n, r) => n + r.costUsd, 0) }] : (rows[0]?.costs ?? []).map((c, i) => ({ label: c.label, usd: rows.reduce((n, r) => n + r.costs[i].usd, 0) }));
  const ev = rows.reduce((a, r) => ({ j: a.j + (r.events?.invalidJson ?? 0), t: a.t + (r.events?.timeouts ?? 0), e: a.e + (r.events?.errors ?? 0), o: a.o + (r.events?.overProdTimeout ?? 0), g: a.g + (r.failedChunks ?? 0) }), { j: 0, t: 0, e: 0, o: 0, g: 0 });
  const errors = TEN.map((c) => get(c, v)).filter((r) => r && r.error).length;
  return {
    v, n: rows.length, min, u, costs, ev, errors,
    kept: noFr.reduce((n, r) => n + r.words, 0) / Math.max(1, noFr.reduce((n, r) => n + r.refWords, 0)),
    med: median(noFr.map((r) => r.kept)), worst: noFr.length ? Math.min(...noFr.map((r) => r.kept)) : null,
    wer: noFr.length ? noFr.reduce((n, r) => n + r.wer, 0) / noFr.length : null,
    runtime: rows.reduce((n, r) => n + r.totalMs, 0) / 1000 / Math.max(min, 1e-9),
  };
});
const row = (label, f) => p(`| ${label} | ${agg.map(f).join(" | ")} |`);
row("Läufe ok", (a) => `${a.n}/10`);
row("Wörter behalten gesamt (ohne 9911)", (a) => pct(a.kept));
row("je Gespräch Median / schlechtestes", (a) => `${pct(a.med)} / ${pct(a.worst)}`);
row("WER ggü. gespeichert, Mittel (ohne 9911)", (a) => (a.wer == null ? "–" : a.wer.toFixed(2)));
row("Tokens je Audiominute Audio / Text / Ausgabe / Denken", (a) => `${Math.round(a.u.ai / a.min)} / ${Math.round(a.u.ti / a.min)} / ${Math.round(a.u.o / a.min)} / ${Math.round(a.u.t / a.min)}`);
row("Kosten je Audiominute", (a) => a.costs.map((c) => `${usd(c.usd / a.min)}${a.costs.length > 1 ? ` (${c.label})` : ""}`).join("<br>"));
row("Laufzeit je Audiominute", (a) => `${a.runtime.toFixed(1)} s`);
row("ungültiges JSON / Zeitüberschr. / Fehler", (a) => `${a.ev.j} / ${a.ev.t} / ${a.ev.e + a.errors}`);
row("Anfragen über 120 s (Grenze im Dienst)", (a) => String(a.ev.o));
row("Abschnitte ohne Ergebnis", (a) => String(a.ev.g));
p();

/* ------------------------------------------------------------- Monatskosten */
p(`### Kosten hochgerechnet`);
p();
p(`| Modell | Preis | je Audiominute | ${VOLUMES.map(([l]) => l).join(" | ")} |`);
p(`| --- | --- | --- | ${VOLUMES.map(() => "---").join(" | ")} |`);
for (const a of agg) {
  const label = ALL.find(([v]) => v === a.v)[1];
  for (const c of a.costs) p(`| ${label} | ${c.label} | ${usd(c.usd / a.min)} | ${VOLUMES.map(([, m]) => usd((c.usd / a.min) * m, 2)).join(" | ")} |`);
}
p();

/* ---------------------------------------------------------- je Gespräch */
p(`### Wörter behalten je Gespräch (gegenüber gespeichertem gemini-2.5-flash-Transkript)`);
p();
header("Anruf (Wörter gespeichert)");
for (const c of CALLS) {
  const ref = ALL.map(([v]) => get(c, v)).find(ok)?.refWords ?? "?";
  p(`| ${c} (${ref}) | ${ALL.map(([v]) => { const r = get(c, v); return ok(r) ? `${pct(r.kept)} (${r.words})` : r?.error ? "Fehler" : "–"; }).join(" | ")} |`);
}
p();

p(`### Sprecher (Bezeichnungen wie gespeichert)`);
p();
p(`Bezeichnungen nach dem Zusammensetzen der 60-s-Abschnitte wie im Dienst (gleiche Bezeichnung = gleicher Sprecher). ⚠ = Name eines anderen Anrufers aus dem Vokabular.`);
p();
const leaked = (call, label) => PEOPLE.some((name) => !CALLER[call].includes(name.split(" ")[1]) && name.split(" ").some((part) => label.includes(part)));
const named = ALL.map(([v]) => {
  let labels = 0, withName = 0, wrong = 0, runs = 0;
  for (const c of CALLS) { const r = get(c, v); if (!ok(r) || v === "T") continue; runs += 1; for (const l of r.speakers) { labels += 1; if (!/^Sprecher(in)? \d+$/.test(l)) withName += 1; if (leaked(c, l)) wrong += 1; } }
  return { labels, withName, wrong, runs };
});
p(`| | ${ALL.map(([, l]) => l).join(" | ")} |`);
p(`| --- | ${ALL.map(() => "---").join(" | ")} |`);
p(`| Bezeichnungen je Gespräch, Mittel | ${named.map((n, i) => (ALL[i][0] === "T" ? "nur Nummern" : (n.labels / Math.max(1, n.runs)).toFixed(1))).join(" | ")} |`);
p(`| davon mit Namen | ${named.map((n, i) => (ALL[i][0] === "T" ? "–" : pct(n.withName / Math.max(1, n.labels)))).join(" | ")} |`);
p(`| fremder Anrufername als Sprecher | ${named.map((n, i) => (ALL[i][0] === "T" ? "–" : String(n.wrong))).join(" | ")} |`);
p();
header("Anruf (Anrufer)");
for (const c of CALLS) {
  p(`| ${c} (${CALLER[c].replace(/\s*\([^)]*\)/, "")}) | ${ALL.map(([v]) => { const r = get(c, v); if (!ok(r)) return "–"; if (v === "T") return `${r.speakers.join("+")} (nur Nummern)`; return `${r.speakers.length}: ${r.speakers.map((l) => (leaked(c, l) ? `⚠${l}` : l)).join(", ")}`; }).join(" | ")} |`);
}
p();

p(`### Namen und Begriffe`);
p();
p(`Immotrust: richtig geschrieben / Varianten; Labruzzo: richtig / Varianten; Strassen. Gespeichert = gemini-2.5-flash.`);
p();
const termCell = (t) => {
  if (!t) return "–";
  const parts = [`Immotrust ${t.immotrust.correct}${t.immotrust.variants.length ? ` (${t.immotrust.variants.join(", ")})` : ""}`];
  if (t.labruzzo.correct || t.labruzzo.variants.length) parts.push(`Labruzzo ${t.labruzzo.correct}${t.labruzzo.variants.length ? ` (${t.labruzzo.variants.join(", ")})` : ""}`);
  if (t.streets.length) parts.push(t.streets.join(", "));
  return parts.join("; ");
};
const tTerms = (r) => {
  if (!ok(r)) return null;
  const text = (r.segments ?? []).flatMap((s) => s.sentences.map((x) => x.text)).join(" ");
  const find = (re) => [...text.matchAll(re)].map((m) => m[0]);
  const immo = find(/\b(?:immo[\s-]?tr[ua]st|imotr[ua]s\w*|imm?o\s?tras\w*)(?:\s?AG)?\b/gi);
  const labr = find(/\b(?:la[\s-]?br[uo][sz]+[oi]\w*|schlabru\w*|labrut\w*)\b/gi);
  const streets = find(/\b[\p{Lu}][\p{L}-]*(?:strasse|straße|gasse|weg|platz|rain|halde|ring|allee)\b/gu);
  const good = (x) => /^Immotrust(\sAG)?$/.test(x);
  return { immotrust: { correct: immo.filter(good).length, variants: [...new Set(immo.filter((x) => !good(x)))] }, labruzzo: { correct: labr.filter((x) => x === "Labruzzo").length, variants: [...new Set(labr.filter((x) => x !== "Labruzzo"))] }, streets: [...new Set(streets)] };
};
p(`| Anruf | gespeichert | ${ALL.map(([, l]) => l).join(" | ")} |`);
p(`| --- | --- | ${ALL.map(() => "---").join(" | ")} |`);
for (const c of CALLS) {
  const refT = ALL.map(([v]) => get(c, v)).find((r) => ok(r) && r.refTerms)?.refTerms;
  p(`| ${c} | ${termCell(refT)} | ${ALL.map(([v]) => { const r = get(c, v); return v === "T" ? termCell(tTerms(r)) : termCell(ok(r) ? r.terms : null); }).join(" | ")} |`);
}
p();

/* ------------------------------------------------------------------- Zeiten */
p(`### Satzzeiten des Modells vor dem Forced Alignment (alle 11 Gespräche)`);
p();
p(`| | ${VARIANTS.map(([, l]) => l).join(" | ")} |`);
p(`| --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
const tim = VARIANTS.map(([v]) => {
  const rows = CALLS.map((c) => M[`${c}:${v}`]).filter(ok);
  const sum = (k) => rows.reduce((n, r) => n + r.timing[k], 0);
  return { n: sum("sentences"), out: sum("outside"), back: sum("backwards"), inv: sum("invalid"), inS: sum("inSpeech"), med: median(rows.map((r) => r.timing.deltaToAlignmentMs.median).filter((x) => x != null)), p90: median(rows.map((r) => r.timing.deltaToAlignmentMs.p90).filter((x) => x != null)) };
});
const trow = (label, f) => p(`| ${label} | ${tim.map(f).join(" | ")} |`);
trow("Sätze", (t) => String(t.n));
trow("ausserhalb des Abschnitts", (t) => `${t.out} (${pct(t.out / t.n)})`);
trow("rückwärts/überlappend", (t) => `${t.back} (${pct(t.back / t.n)})`);
trow("Ende ≤ Beginn", (t) => String(t.inv));
trow("Satzanfang in erkannter Sprache (±0,3 s)", (t) => pct(t.inS / t.n));
trow("Abstand zur Ausrichtung, Median je Gespräch (Median / P90)", (t) => `${((t.med ?? 0) / 1000).toFixed(1)} s / ${((t.p90 ?? 0) / 1000).toFixed(1)} s`);
p();
p(`gemini-3.5-transcribe liefert eigene Wortzeiten (siehe Prüfung vom 10.11.2026); kein Forced Alignment.`);
p();

/* ---------------------------------------------------------------- Ereignisse */
p(`### Ungültige Antworten, Zeitüberschreitungen, Fehler (Einzelereignisse)`);
p();
let any = false;
for (const [v, l] of VARIANTS) for (const c of CALLS) {
  const r = M[`${c}:${v}`];
  if (r?.error) { any = true; p(`- ${l}, ${c}: Lauf abgebrochen: ${r.error.slice(0, 160)}`); }
  for (const e of r?.events?.list ?? []) { any = true; p(`- ${l}, ${c}, Abschnitt ${e.chunk + 1}, Anlauf ${e.attempt}: ${e.kind}${e.status ? ` ${e.status}` : ""}, ${(e.ms / 1000).toFixed(0)} s: ${e.message.replace(/\s+/g, " ").slice(0, 140)}`); }
}
for (const c of CALLS) { const r = S[`${c}:${T}`]; if (r?.error) { any = true; p(`- 3.5-transcribe ${T}, ${c}: ${r.error.slice(0, 160)}`); } }
if (!any) p(`Keine.`);
p();

/* -------------------------------------------------------- 10980 erste Minute */
p(`### Anruf 10980, erste Minute`);
p();
for (const [v, l] of ALL) {
  const r = get("10980", v);
  p(`**${l}**${ok(r) ? ` (${r.words} Wörter gesamt, ${pct(r.kept)})` : ""}`);
  p();
  p(`> ${ok(r) ? r.firstMinute : "kein Ergebnis"}`);
  p();
}

/* -------------------------------------------------------------- Spot-Check */
p(`### Abhör-Fenster (Text je Modell, Sätze mit Beginn im Fenster, Modellzeiten)`);
p();
for (const [c, from, to] of WINDOWS) {
  p(`#### ${c}, ${from}–${to} s`);
  p();
  for (const [v, l] of ALL) {
    const r = get(c, v);
    const text = ok(r) ? (r.segments ?? []).flatMap((s) => s.sentences.filter((x) => x.startMs >= from * 1000 - 1500 && x.startMs < to * 1000).map((x) => ({ t: x.startMs, s: `[${s.speakerLabel}] ${x.text}` }))).sort((a, b) => a.t - b.t).map((x) => x.s).join(" ") : "kein Ergebnis";
    p(`- **${l}**: ${text}`);
  }
  p();
}

process.stdout.write(out.join("\n") + "\n");
