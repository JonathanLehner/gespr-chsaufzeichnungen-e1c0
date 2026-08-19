import "server-only";
import type { AudioMime } from "./audio";
import { energyEnvelope, type Envelope } from "./audio-envelope";
import { wordWeight } from "./syllables";
import type { TranscriptSegment, TranscriptSentence, TranscriptWord } from "./types";

/**
 * Ausrichtung des Transkripts an der Aufnahme.
 *
 * Das Sprachmodell liefert brauchbaren Text, aber unbrauchbare Zeiten: An den
 * vorhandenen Aufnahmen gemessen liegt ein Satzanfang im Mittel 0,7 Sekunden
 * neben dem tatsächlichen Sprechbeginn, im schlechtesten Fall über fünf
 * Sekunden. Die Zeiten sind zudem auf 1/72 Sekunde gerastert – ein Hinweis
 * darauf, dass sie geschätzt und nicht gemessen sind. Für eine Markierung des
 * laufenden Wortes ist das um Grössenordnungen zu ungenau.
 *
 * Die Zeiten werden deshalb hier neu bestimmt und die des Dienstes verworfen.
 * Verwendet wird nur, was er zuverlässig liefert: die Wortfolge und die
 * Aufteilung in Sätze und Sprecher.
 *
 * Verfahren – eine Zwangsausrichtung („forced alignment“) ohne akustisches
 * Modell, in drei Schritten:
 *
 *  1. Aus dem Lautstärkeverlauf der Datei werden die Sprechabschnitte
 *     bestimmt (`detectSpeech`). Die Schwelle richtet sich nach dem
 *     Grundrauschen der jeweiligen Aufnahme, nicht nach einem festen Pegel.
 *  2. Alle Sprechabschnitte zusammen ergeben die Sprechzeit. Auf ihr – und nur
 *     auf ihr – wird der Text verteilt: Jeder Satz erhält einen Anteil im
 *     Verhältnis seiner Silben. Pausen zählen dabei nicht mit, weshalb die
 *     Markierung in einer Sprechpause stehen bleibt, statt weiterzulaufen.
 *  3. Die Satzgrenzen werden nicht einfach proportional gesetzt, sondern per
 *     dynamischer Programmierung auf die Grenzen der Sprechabschnitte gezogen
 *     (`alignSentences`). Zwischen zwei Sätzen liegt fast immer eine Pause;
 *     an jeder solchen Grenze richtet sich die Ausrichtung neu aus, und ein
 *     örtlicher Fehler pflanzt sich nicht durch das ganze Gespräch fort.
 *
 * Innerhalb eines Satzes werden die Wörter nach demselben Prinzip auf dessen
 * Sprechzeit verteilt. Genauer als eine Silbe wird es damit nicht – dafür
 * bräuchte es ein Aussprachemodell –, aber die Markierung steht auf dem
 * gehörten Wort statt Sekunden daneben.
 */

/* ------------------------------------------------------------ Sprecherkennung */

export type SpeechRegion = { startMs: number; endMs: number };

export type SpeechOptions = {
  /** Kürzere Lücken zwischen zwei Abschnitten gelten als Teil des Sprechens. */
  bridgeMs?: number;
  /** Kürzere Abschnitte gelten als Störgeräusch. */
  minRegionMs?: number;
  /** Zugabe an beiden Enden, damit leise Laute am Wortrand nicht abgeschnitten werden. */
  paddingMs?: number;
};

function percentile(sorted: Float32Array, quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))))];
}

/**
 * Trennt Sprechen von Pause.
 *
 * Die Schwelle liegt knapp über dem Grundrauschen: Sie ist das Grössere aus dem
 * 2,5-fachen des 15. Perzentils und einem kleinen Anteil des Abstands zwischen
 * Grundrauschen und lauten Stellen. Eine feste Schwelle taugt nicht, weil
 * Telefonaufnahmen sehr unterschiedliche Pegel haben; ein reiner Anteil des
 * Maximums taugt ebenfalls nicht, weil eine sehr leise Aufnahme sonst
 * vollständig als Sprache gilt.
 */
export function detectSpeech(envelope: Envelope, options: SpeechOptions = {}): SpeechRegion[] {
  const bridgeMs = options.bridgeMs ?? 150;
  const minRegionMs = options.minRegionMs ?? 100;
  const paddingMs = options.paddingMs ?? 60;
  const { rms, frameMs } = envelope;
  if (rms.length === 0) return [];

  const sorted = Float32Array.from(rms).sort();
  const noise = percentile(sorted, 0.15);
  const loud = percentile(sorted, 0.95);
  const threshold = Math.max(noise * 2.5, noise + (loud - noise) * 0.06);
  if (!(threshold > 0)) return [];

  const regions: { from: number; to: number }[] = [];
  let start = -1;
  for (let frame = 0; frame <= rms.length; frame += 1) {
    if (frame < rms.length && rms[frame] > threshold) {
      if (start < 0) start = frame;
      continue;
    }
    if (start < 0) continue;
    const previous = regions[regions.length - 1];
    if (previous && (start - previous.to) * frameMs <= bridgeMs) previous.to = frame;
    else regions.push({ from: start, to: frame });
    start = -1;
  }

  const limit = rms.length * frameMs;
  const padded = regions
    .filter((region) => (region.to - region.from) * frameMs >= minRegionMs)
    .map((region) => ({
      startMs: Math.max(0, region.from * frameMs - paddingMs),
      endMs: Math.min(limit, region.to * frameMs + paddingMs),
    }));

  // Die Zugabe kann benachbarte Abschnitte überlappen lassen; sie werden dann
  // zusammengefasst, damit die Sprechzeit nicht doppelt gezählt wird.
  const merged: SpeechRegion[] = [];
  for (const region of padded) {
    const previous = merged[merged.length - 1];
    if (previous && region.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, region.endMs);
    else merged.push({ ...region });
  }
  return merged;
}

/** Schneidet die angegebenen Zeitbereiche aus den Sprechabschnitten heraus. */
export function subtractRanges(regions: SpeechRegion[], ranges: SpeechRegion[]): SpeechRegion[] {
  if (ranges.length === 0) return regions;
  let remaining = regions;
  for (const range of ranges) {
    const next: SpeechRegion[] = [];
    for (const region of remaining) {
      if (region.endMs <= range.startMs || region.startMs >= range.endMs) {
        next.push(region);
        continue;
      }
      if (region.startMs < range.startMs) next.push({ startMs: region.startMs, endMs: range.startMs });
      if (region.endMs > range.endMs) next.push({ startMs: range.endMs, endMs: region.endMs });
    }
    remaining = next;
  }
  return remaining;
}

/* ------------------------------------------------------------- Zeitrechnung */

/**
 * Rechnet zwischen Uhrzeit der Aufnahme und reiner Sprechzeit um.
 *
 * Die Sprechzeit ist die Aufnahme ohne ihre Pausen. Der Text wird auf ihr
 * verteilt; erst zum Schluss werden die Werte zurück auf die Uhrzeit gebracht.
 */
class SpeechClock {
  readonly total: number;
  /** Sprechzeit am Anfang jedes Abschnitts – zugleich die Menge der Satzgrenzen. */
  readonly boundaries: number[];

  constructor(private readonly regions: SpeechRegion[]) {
    this.boundaries = [0];
    let sum = 0;
    for (const region of regions) {
      sum += region.endMs - region.startMs;
      this.boundaries.push(sum);
    }
    this.total = sum;
  }

  /**
   * Uhrzeit zu einer Sprechzeit. `edge` entscheidet, welche Seite einer Pause
   * gemeint ist: Ein Satzende liegt am Schluss des vorangehenden Abschnitts,
   * der nächste Satzanfang am Beginn des folgenden.
   */
  wallOf(speechMs: number, edge: "start" | "end"): number {
    if (this.regions.length === 0) return 0;
    const value = Math.min(Math.max(speechMs, 0), this.total);

    let low = 0;
    let high = this.regions.length - 1;
    let index = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.boundaries[middle] <= value) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // Genau auf einer Grenze: Für ein Ende gilt der Abschnitt davor.
    if (edge === "end" && index > 0 && this.boundaries[index] === value) index -= 1;
    const region = this.regions[index];
    const offset = value - this.boundaries[index];
    return Math.round(Math.min(region.startMs + offset, region.endMs));
  }

  /** Nächstgelegene Abschnittsgrenzen innerhalb eines Fensters um `speechMs`. */
  boundariesNear(speechMs: number, windowMs: number, limit: number): number[] {
    const from = speechMs - windowMs;
    const to = speechMs + windowMs;
    const found: number[] = [];
    for (const boundary of this.boundaries) {
      if (boundary < from) continue;
      if (boundary > to) break;
      found.push(boundary);
    }
    if (found.length <= limit) return found;
    // Bei sehr vielen Kandidaten zählen die dem Schätzwert nächsten.
    return found
      .map((boundary) => ({ boundary, distance: Math.abs(boundary - speechMs) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => entry.boundary)
      .sort((a, b) => a - b);
  }
}

/* --------------------------------------------------- Ausrichtung der Sätze */

type Unit = { weight: number; turnEnd: boolean };

/** Kosten dafür, eine Satzgrenze mitten in einen Sprechabschnitt zu legen. */
const CUT_PENALTY = 0.4;
/** Dasselbe an einem Sprecherwechsel: Dort ist eine Pause die Regel. */
const TURN_CUT_PENALTY = 1.1;
/** Kosten je Sekunde Sprache, die keinem Satz zugeschlagen wird. */
const SKIP_COST_PER_SECOND = 0.6;
/** Suchfenster um den Schätzwert, als Vielfaches der erwarteten Dauer. */
const SEARCH_FACTOR = 2.5;
const MIN_SEARCH_MS = 3000;
const MAX_SEARCH_MS = 10_000;
const MAX_CANDIDATES = 32;
/**
 * Obergrenze der Sprechzeit je Gewichtseinheit.
 *
 * Sie entspricht rund 4,2 Silben je Sekunde – langsamer spricht auch niemand,
 * der sich Zeit lässt. Braucht eine Aufnahme rechnerisch mehr Zeit je Silbe,
 * enthält sie mehr Sprache, als im Transkript steht; der Überschuss wird dann
 * nicht in die Sätze hineingedehnt, sondern als Lücke ausgewiesen.
 */
const MAX_MS_PER_WEIGHT = 170;

/** Eine Ebene der Ausrichtung: entweder ein Satz oder eine übersprungene Stelle. */
type Slot = { sentence: number; expected: number; penalty: number };

export type SpeechSpan = { fromMs: number; toMs: number };

/**
 * Legt die Satzgrenzen auf der Sprechzeit fest.
 *
 * Gesucht sind aufsteigende Schnittpunkte, die drei Kosten zugleich klein
 * halten: die Abweichung der zugeteilten Dauer von der aus den Silben
 * erwarteten, die Zahl der Schnitte, die nicht auf eine Pause fallen, und die
 * Menge an Sprache, die keinem Satz zugeschlagen wird. Alle drei gegeneinander
 * abzuwägen ist der Grund für die dynamische Programmierung – ein gieriges
 * Anziehen an die jeweils nächste Pause wählt lokal die schönste Grenze und
 * schiebt den Fehler vor sich her.
 *
 * Der dritte Posten ist der wichtigste und der Grund, weshalb zwischen je zwei
 * Sätzen eine Ebene für eine Lücke liegt: Auf der Aufnahme steht regelmässig
 * Gesprochenes, das im Transkript fehlt – Rückversicherungen der Gegenseite,
 * gleichzeitiges Reden, Gemurmel. Ohne die Möglichkeit, solche Stellen
 * auszulassen, muss die Verteilung sie in die umliegenden Sätze hineindehnen,
 * und ab da läuft alles Folgende nach. Weil die Dauerabweichung quadratisch,
 * das Auslassen aber nur linear zu Buche schlägt, wird eine einzelne stark
 * überdehnte Stelle ausgelassen, während viele kleine Abweichungen getragen
 * werden – genau die gewünschte Abwägung.
 */
function alignSentences(units: Unit[], clock: SpeechClock): SpeechSpan[] {
  const count = units.length;
  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0);
  if (count === 0 || totalWeight <= 0 || clock.total <= 0) return [];

  // Sprechzeit je Gewichtseinheit. Deckt das Transkript die Aufnahme, ergibt
  // sich der Wert aus der Aufnahme selbst; deckt es sie nicht, begrenzt ihn die
  // langsamste noch glaubhafte Sprechgeschwindigkeit.
  const rate = Math.min(clock.total / totalWeight, MAX_MS_PER_WEIGHT);
  const surplus = Math.max(0, clock.total - rate * totalWeight) / (count + 1);

  const slots: Slot[] = [];
  for (let index = 0; index < count; index += 1) {
    slots.push({ sentence: -1, expected: surplus, penalty: 0 });
    slots.push({
      sentence: index,
      expected: Math.max(units[index].weight * rate, 60),
      penalty: units[index].turnEnd ? TURN_CUT_PENALTY : CUT_PENALTY,
    });
  }
  slots.push({ sentence: -1, expected: surplus, penalty: 0 });

  const estimate: number[] = [];
  let running = 0;
  for (const slot of slots) {
    running += slot.expected;
    estimate.push(Math.min(clock.total, running));
  }

  const isBoundary = new Set(clock.boundaries);
  const levels: number[][] = [];
  const backs: number[][] = [];
  let previousCuts = [0];
  let previousCost = [0];

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const window = Math.min(
      MAX_SEARCH_MS,
      Math.max(MIN_SEARCH_MS, Math.max(slot.expected, surplus) * SEARCH_FACTOR),
    );
    const latest = previousCuts[previousCuts.length - 1];
    const cuts =
      index === slots.length - 1
        ? [clock.total]
        : [
            ...new Set([
              ...clock.boundariesNear(estimate[index], window, MAX_CANDIDATES),
              Math.min(clock.total, Math.round(estimate[index])),
              // Sicherheitskandidat: mindestens ein Schnittpunkt liegt hinter
              // allen Schnittpunkten der Ebene davor, sonst bliebe die Ebene
              // ohne gültigen Übergang.
              Math.min(clock.total, Math.max(latest, Math.round(estimate[index]))),
            ]),
          ].sort((a, b) => a - b);

    const best = new Array<number>(cuts.length).fill(Number.POSITIVE_INFINITY);
    const back = new Array<number>(cuts.length).fill(-1);

    for (let target = 0; target < cuts.length; target += 1) {
      const to = cuts[target];
      const cut = isBoundary.has(to) ? 0 : slot.penalty;
      for (let source = 0; source < previousCuts.length; source += 1) {
        const from = previousCuts[source];
        if (!Number.isFinite(previousCost[source]) || to < from) continue;
        const span = to - from;
        const step =
          slot.sentence < 0
            ? (SKIP_COST_PER_SECOND * span) / 1000
            : ((span - slot.expected) / Math.max(slot.expected, 250)) ** 2 + cut;
        const total = previousCost[source] + step;
        if (total < best[target]) {
          best[target] = total;
          back[target] = source;
        }
      }
    }

    levels.push(cuts);
    backs.push(back);
    previousCuts = cuts;
    previousCost = best;
  }

  let position = 0;
  for (let index = 1; index < previousCost.length; index += 1) {
    if (previousCost[index] < previousCost[position]) position = index;
  }

  const cuts = new Array<number>(slots.length).fill(clock.total);
  for (let index = slots.length - 1; index >= 0 && position >= 0; index -= 1) {
    cuts[index] = levels[index][position];
    position = backs[index][position];
  }

  const spans = new Array<SpeechSpan>(count);
  for (let index = 0; index < slots.length; index += 1) {
    const sentence = slots[index].sentence;
    if (sentence >= 0) spans[sentence] = { fromMs: cuts[index - 1], toMs: cuts[index] };
  }
  return spans;
}

/* ---------------------------------------------------- Verteilung der Wörter */

function spreadWords(
  words: TranscriptWord[],
  fromSpeechMs: number,
  toSpeechMs: number,
  clock: SpeechClock,
): TranscriptWord[] {
  if (words.length === 0) return words;
  const weights = words.map((word) => wordWeight(word.text));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(toSpeechMs - fromSpeechMs, 0);

  const cuts: number[] = [fromSpeechMs];
  let running = 0;
  for (const weight of weights) {
    running += weight;
    cuts.push(fromSpeechMs + (span * running) / total);
  }

  return words.map((word, index) => {
    const startMs = clock.wallOf(cuts[index], "start");
    const endMs = clock.wallOf(cuts[index + 1], "end");
    return { text: word.text, startMs, endMs: Math.max(endMs, startMs) };
  });
}

/* ------------------------------------------------------------------ Fassade */

export type AlignmentResult = {
  segments: TranscriptSegment[];
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  regionCount: number;
};

export type AlignOptions = {
  /** Zeitbereiche ohne Text – sie gehören keinem Satz und bleiben unberücksichtigt. */
  gaps?: SpeechRegion[];
};

/**
 * Richtet ein fertiges Transkript an einem Lautstärkeverlauf aus und gibt es
 * mit neuen Zeiten zurück. `null` bedeutet: Die Aufnahme trägt zu wenig
 * verwertbare Sprache, die bisherigen Zeiten bleiben stehen.
 */
export function alignToEnvelope(
  segments: TranscriptSegment[],
  envelope: Envelope,
  options: AlignOptions = {},
): AlignmentResult | null {
  const flat: { segment: number; sentence: number; value: TranscriptSentence }[] = [];
  segments.forEach((segment, segmentIndex) => {
    segment.sentences.forEach((sentence, sentenceIndex) => {
      flat.push({ segment: segmentIndex, sentence: sentenceIndex, value: sentence });
    });
  });
  if (flat.length === 0) return null;

  const regions = subtractRanges(detectSpeech(envelope), options.gaps ?? []);
  const clock = new SpeechClock(regions);
  // Weniger Sprechzeit als eine Zehntelsekunde je Satz heisst: Der erkannte
  // Sprachanteil passt nicht zum Text. Eine Ausrichtung darauf wäre geraten.
  if (clock.total < flat.length * 100) return null;

  const units: Unit[] = flat.map((entry, index) => {
    const words = entry.value.words;
    const weight = words.length > 0
      ? words.reduce((sum, word) => sum + wordWeight(word.text), 0)
      : entry.value.text.split(/\s+/).filter(Boolean).reduce((sum, word) => sum + wordWeight(word), 0);
    return {
      weight: Math.max(weight, 0.5),
      turnEnd: flat[index + 1] !== undefined && flat[index + 1].segment !== entry.segment,
    };
  });

  const spans = alignSentences(units, clock);
  if (spans.length !== flat.length || spans.some((span) => span === undefined)) return null;

  const aligned = segments.map((segment) => ({ ...segment, sentences: [...segment.sentences] }));
  flat.forEach((entry, index) => {
    const { fromMs: from, toMs: to } = spans[index];
    const sentence = entry.value;
    const words =
      sentence.words.length > 0
        ? sentence.words
        : sentence.text.split(/\s+/).filter(Boolean).map((text) => ({ text, startMs: 0, endMs: 0 }));
    const spread = spreadWords(words, from, to, clock);
    aligned[entry.segment].sentences[entry.sentence] = {
      text: sentence.text,
      startMs: spread[0]?.startMs ?? clock.wallOf(from, "start"),
      endMs: spread[spread.length - 1]?.endMs ?? clock.wallOf(to, "end"),
      words: spread,
    };
  });

  for (const segment of aligned) {
    if (segment.sentences.length === 0) continue;
    segment.startMs = segment.sentences[0].startMs;
    segment.endMs = segment.sentences[segment.sentences.length - 1].endMs;
  }

  return { segments: aligned, speechMs: clock.total, regionCount: regions.length };
}

/** Wie `alignToEnvelope`, ermittelt den Lautstärkeverlauf aber selbst. */
export function alignTranscript(
  segments: TranscriptSegment[],
  bytes: Uint8Array,
  mime: AudioMime,
  options: AlignOptions = {},
): AlignmentResult | null {
  const envelope = energyEnvelope(bytes, mime);
  if (!envelope) return null;
  return alignToEnvelope(segments, envelope, options);
}
