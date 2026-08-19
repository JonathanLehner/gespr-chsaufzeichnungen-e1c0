import Hypher from "hypher";
import german from "hyphenation.de";

/**
 * Silbenzahl eines Wortes – das Mass, an dem sich seine Sprechdauer bemisst.
 *
 * Für die Ausrichtung des Transkripts an der Aufnahme wird jedem Wort ein
 * Gewicht zugeteilt; die gemessene Sprechzeit wird anschliessend im Verhältnis
 * dieser Gewichte verteilt. Buchstabenzahl taugt dafür nicht: „Schwester“ hat
 * neun Buchstaben und zwei Silben, „ideal“ fünf Buchstaben und drei Silben.
 * Gesprochen wird in Silben, nicht in Buchstaben.
 *
 * Gezählt wird auf zwei Wegen und das grössere Ergebnis genommen:
 *  - Liangs Trennalgorithmus mit den deutschen Mustern (Paket `hypher`). Er
 *    zerlegt auch Zusammensetzungen sauber („Lie-gen-schaft“).
 *  - Vokalgruppen. Der Trennalgorithmus lässt an Wortanfang und -ende je zwei
 *    Buchstaben stehen und trennt deshalb kurze Wörter gar nicht; die
 *    Vokalgruppen fangen diese Fälle ab.
 * Deutsche Diphthonge („ei“, „au“, „eu“, „ie“) bilden je eine Vokalgruppe und
 * damit richtigerweise eine Silbe.
 */
const hypher = new Hypher(german);

const VOWEL_GROUPS = /[aeiouyäöü]+/gi;
const LETTERS = /[^0-9a-zà-öø-ÿ]+/gi;

/** Ziffern werden ausgesprochen: „388“ sind sieben Silben, also rund zwei je Ziffer. */
const SYLLABLES_PER_DIGIT = 2;

function countVowelGroups(word: string): number {
  return word.match(VOWEL_GROUPS)?.length ?? 0;
}

export function syllableCount(word: string): number {
  const digits = (word.match(/[0-9]/g) ?? []).length;
  const letters = word.toLowerCase().replace(LETTERS, " ").replace(/[0-9]/g, " ").trim();

  let syllables = digits * SYLLABLES_PER_DIGIT;
  for (const part of letters.split(/\s+/)) {
    if (!part) continue;
    syllables += Math.max(hypher.hyphenate(part).length, countVowelGroups(part), 1);
  }
  return Math.max(syllables, 1);
}

/**
 * Gewicht eines Wortes in der Zeitverteilung.
 *
 * Neben den Silben trägt jedes Wort einen festen Anteil: Wortanfänge kosten
 * Zeit, die nicht in der Silbenzahl steckt – ein einsilbiges „Ja“ dauert
 * spürbar länger als eine einzelne Silbe mitten in einem langen Wort. Lange
 * Konsonantenhäufungen („Herbst“, „schrumpft“) verlängern zusätzlich, deshalb
 * geht die Buchstabenzahl schwach mit ein.
 */
export function wordWeight(word: string): number {
  const letters = word.replace(LETTERS, "").length;
  return 0.55 + syllableCount(word) + letters * 0.03;
}
