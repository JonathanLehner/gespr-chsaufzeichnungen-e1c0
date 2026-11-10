/**
 * Nachkorrektur von Namen und Begriffen aus dem Vokabular für
 * gemini-3.5-transcribe. Google nimmt `custom_vocabulary` nicht zusammen mit
 * Wortzeiten und Sprechern an; deshalb wird die Schreibweise nach der Antwort
 * angeglichen („La Brusso“ → „Labruzzo“, „Immo Trust“ → „Immotrust“).
 *
 * Die Zeiten bleiben unverändert: Ein ersetztes Wort behält Beginn und Ende,
 * zwei zusammengezogene Wörter erhalten den Beginn des ersten und das Ende des
 * zweiten. Reine Funktion ohne Laufzeitabhängigkeiten.
 */
import type { WordAnnotation } from "./word-timestamps";

/**
 * Lautnahe Vergleichsform: klein, ohne Umlaute, ß/tz/z → s, ck → k, ph → f,
 * th → t, y → i, doppelte Buchstaben einfach.
 */
export function foldForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/ck/g, "k")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/tz/g, "z")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Erlaubte Abweichung in der Vergleichsform: kurze Wörter nur bei gleicher Lautform. */
function tolerance(length: number): number {
  if (length >= 8) return 2;
  if (length >= 6) return 1;
  return 0;
}

type Target = { text: string; folded: string };

/** Einzelne Wörter des Vokabulars mit mindestens vier Buchstaben („Immotrust AG“ → „Immotrust“). */
export function vocabularyTargets(terms: readonly string[]): Target[] {
  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const term of terms) {
    for (const token of term.split(/[\s/]+/)) {
      const text = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if ([...text].filter((char) => /\p{L}/u.test(char)).length < 4) continue;
      const folded = foldForMatch(text);
      if (folded.length < 4 || seen.has(text)) continue;
      seen.add(text);
      targets.push({ text, folded });
    }
  }
  return targets;
}

const LEADING = /^[^\p{L}\p{N}]+/u;
const TRAILING = /[^\p{L}\p{N}]+$/u;
const core = (text: string) => text.replace(LEADING, "").replace(TRAILING, "");

function bestTarget(candidate: string, targets: readonly Target[]): Target | null {
  const folded = foldForMatch(candidate);
  if (folded.length < 4) return null;
  let best: { target: Target; score: number } | null = null;
  for (const target of targets) {
    if (target.folded[0] !== folded[0]) continue;
    if (Math.abs(target.folded.length - folded.length) > 2) continue;
    // Gebeugte Formen und Zusammensetzungen („Grundbuchs“, „Zürichs“) bleiben.
    if (folded !== target.folded && (folded.startsWith(target.folded) || target.folded.startsWith(folded))) continue;
    const score = distance(folded, target.folded);
    if (score > tolerance(Math.min(folded.length, target.folded.length))) continue;
    if (!best || score < best.score) best = { target, score };
  }
  return best?.target ?? null;
}

/**
 * Gleicht die Wörter an das Vokabular an. Geprüft werden einzelne Wörter mit
 * grossem Anfangsbuchstaben (Namen, Orte, Strassen) und Paare desselben
 * Sprechers, die zusammen einen Begriff ergeben. Gibt die Wörter und die Zahl
 * der Korrekturen zurück.
 */
export function correctVocabulary(
  words: readonly WordAnnotation[],
  terms: readonly string[],
): { words: WordAnnotation[]; corrections: number } {
  const targets = vocabularyTargets(terms);
  if (targets.length === 0) return { words: [...words], corrections: 0 };
  const result: WordAnnotation[] = [];
  let corrections = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const text = word.text ?? "";
    const next = words[index + 1];
    // Zwei Wörter ohne Satzzeichen dazwischen, derselbe Sprecher: „Immo Trust“.
    if (next && next.speaker === word.speaker && !TRAILING.test(text) && /^\p{Lu}/u.test(core(text))) {
      const joined = core(text) + core(next.text ?? "");
      const target = bestTarget(joined, targets);
      if (target && bestTarget(core(text), targets) === null) {
        const trailing = (next.text ?? "").match(TRAILING)?.[0] ?? "";
        const leading = text.match(LEADING)?.[0] ?? "";
        result.push({ ...word, text: leading + target.text + trailing, end_offset: next.end_offset });
        corrections += 1;
        index += 1;
        continue;
      }
    }
    const bare = core(text);
    if (/^\p{Lu}/u.test(bare)) {
      const target = bestTarget(bare, targets);
      if (target && target.text !== bare) {
        result.push({ ...word, text: text.replace(bare, target.text) });
        corrections += 1;
        continue;
      }
    }
    result.push(word);
  }
  return { words: result, corrections };
}
