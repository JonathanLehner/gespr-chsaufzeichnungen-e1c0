import { spokenForm } from "./aligner-text";
import { wordWeight } from "./syllables";
import type { TranscriptSegment, TranscriptWord } from "./types";

/**
 * Akustische Zwangsausrichtung („forced alignment“) der Wörter.
 *
 * Text, Sätze und Sprecher stammen unverändert vom Transkriptionsdienst.
 * Hier entstehen nur die Zeiten: Ein akustisches Modell (MMS_FA, ein
 * mehrsprachiges wav2vec2-CTC-Modell) liefert für jeden 20-ms-Rahmen der
 * Aufnahme die Wahrscheinlichkeit jedes Buchstabens. Der bekannte Text wird
 * per Viterbi-Suche so auf die Rahmen gelegt, dass die Gesamtwahrscheinlichkeit
 * maximal ist; der erste Rahmen des ersten Buchstabens eines Wortes ist sein
 * Anfang.
 *
 * Ausgerichtet wird fensterweise: Aufeinanderfolgende Sätze werden zu Fenstern
 * von höchstens `maxWindowMs` zusammengefasst und um `padMs` erweitert. Die
 * Satzgrenzen dafür kommen aus der bisherigen, pausenbasierten Ausrichtung
 * (`forced-alignment.ts`). Ein langes Gespräch bleibt so schnell, und ein
 * Fehler in einem Fenster bleibt dort.
 *
 * Dieses Modul ist reine Rechnung. Die Wahrscheinlichkeiten liefert der
 * Aufrufer (`transcriber/acoustic-aligner.ts` mit onnxruntime).
 */

/** Ausgabe des Modells für einen Ausschnitt: log-Wahrscheinlichkeiten [frames × vocab]. */
export type Emission = {
  logProbs: Float32Array;
  frames: number;
  vocab: number;
  /** Dauer eines Rahmens in ms (Abtastwerte / Rahmen / 16). */
  frameMs: number;
};

export type EmitFn = (fromMs: number, toMs: number) => Promise<Emission>;

export type CtcOptions = {
  /** Zugabe vor und nach dem Fenster. */
  padMs?: number;
  /** Längstes Fenster aus aufeinanderfolgenden Sätzen, ohne Zugabe. */
  maxWindowMs?: number;
  /** Wörter, deren Buchstaben im Mittel unwahrscheinlicher sind, gelten als nicht platziert. */
  minWordScore?: number;
  durationMs: number;
};

export type CtcResult = {
  segments: TranscriptSegment[];
  windows: number;
  /** Wörter mit gesprochener Form. */
  words: number;
  /** Davon akustisch platziert; der Rest ist zwischen den Nachbarn eingepasst. */
  placed: number;
};

/* ------------------------------------------------------------------ Viterbi */

export type TokenSpan = { first: number; last: number; score: number };

/**
 * CTC-Viterbi über die Rahmen `[0, frames)`: legt die Zeichenfolge `targets`
 * (ohne Leerzeichen) auf die Rahmen. Zwischen und um die Zeichen steht das
 * Leerzeichen-Symbol `blank`. Liefert je Zeichen den ersten und letzten Rahmen
 * und die mittlere Wahrscheinlichkeit seiner Rahmen, oder `null`, wenn der Text
 * nicht in den Ausschnitt passt.
 */
export function ctcViterbi(emission: Emission, targets: Int32Array, blank = 0): TokenSpan[] | null {
  const { logProbs, frames, vocab } = emission;
  const length = targets.length;
  if (length === 0) return [];
  const states = 2 * length + 1;
  let repeats = 0;
  for (let k = 1; k < length; k += 1) if (targets[k] === targets[k - 1]) repeats += 1;
  if (frames < length + repeats) return null;

  const symbol = (state: number) => (state % 2 === 0 ? blank : targets[(state - 1) >> 1]);
  const NEG = Number.NEGATIVE_INFINITY;
  let previous = new Float64Array(states).fill(NEG);
  let current = new Float64Array(states).fill(NEG);
  // 0: bleibt, 1: vom Zustand davor, 2: übersprungenes Leerzeichen.
  const back = new Uint8Array(frames * states);

  previous[0] = logProbs[blank];
  previous[1] = logProbs[targets[0]];
  for (let t = 1; t < frames; t += 1) {
    const row = t * vocab;
    // Zustände, die zum Zeitpunkt t noch das Ende erreichen können bzw. schon erreichbar sind.
    const lowest = Math.max(0, states - 2 * (frames - t));
    const highest = Math.min(states - 1, 2 * t + 1);
    current.fill(NEG);
    for (let s = lowest; s <= highest; s += 1) {
      let best = previous[s];
      let from = 0;
      if (s > 0 && previous[s - 1] > best) {
        best = previous[s - 1];
        from = 1;
      }
      if (s > 1 && s % 2 === 1 && targets[(s - 1) >> 1] !== targets[(s - 3) >> 1] && previous[s - 2] > best) {
        best = previous[s - 2];
        from = 2;
      }
      if (best === NEG) continue;
      current[s] = best + logProbs[row + symbol(s)];
      back[t * states + s] = from;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  let state = previous[states - 1] >= previous[states - 2] ? states - 1 : states - 2;
  if (previous[state] === NEG) return null;

  const spans: TokenSpan[] = Array.from({ length }, () => ({ first: -1, last: -1, score: 0 }));
  const sums = new Float64Array(length);
  for (let t = frames - 1; t >= 0; t -= 1) {
    if (state % 2 === 1) {
      const k = (state - 1) >> 1;
      const span = spans[k];
      if (span.last < 0) span.last = t;
      span.first = t;
      sums[k] += Math.exp(logProbs[t * vocab + targets[k]]);
    }
    if (t > 0) state -= back[t * states + state];
  }
  for (let k = 0; k < length; k += 1) {
    spans[k].score = sums[k] / (spans[k].last - spans[k].first + 1);
  }
  return spans;
}

/* ------------------------------------------------------------- Fenster */

type FlatWord = {
  segment: number;
  sentence: number;
  word: number;
  text: string;
  spoken: string;
  startMs: number | null;
  endMs: number | null;
};

type FlatSentence = { segment: number; sentence: number; startMs: number; endMs: number; words: FlatWord[] };

export type Window = { fromMs: number; toMs: number; sentences: number[] };

/** Fasst aufeinanderfolgende Sätze zu Fenstern zusammen. */
export function planWindows(
  sentences: { startMs: number; endMs: number }[],
  options: { padMs: number; maxWindowMs: number; durationMs: number },
): Window[] {
  const windows: Window[] = [];
  let current: { startMs: number; endMs: number; sentences: number[] } | null = null;
  sentences.forEach((sentence, index) => {
    const startMs = Math.min(sentence.startMs, sentence.endMs);
    const endMs = Math.max(sentence.startMs, sentence.endMs);
    if (
      current &&
      Math.max(current.endMs, endMs) - current.startMs <= options.maxWindowMs &&
      startMs <= current.endMs + options.padMs
    ) {
      current.endMs = Math.max(current.endMs, endMs);
      current.startMs = Math.min(current.startMs, startMs);
      current.sentences.push(index);
      return;
    }
    if (current) windows.push(toWindow(current));
    current = { startMs, endMs, sentences: [index] };
  });
  if (current) windows.push(toWindow(current));
  return windows;

  function toWindow(group: { startMs: number; endMs: number; sentences: number[] }): Window {
    return {
      fromMs: Math.max(0, Math.floor(group.startMs - options.padMs)),
      toMs: Math.min(options.durationMs, Math.ceil(group.endMs + options.padMs)),
      sentences: group.sentences,
    };
  }
}

/* ------------------------------------------------------------- Ausrichtung */

/**
 * Richtet alle Wörter neu aus. `alphabet` sind die Zeichen des Modells in der
 * Reihenfolge seiner Ausgabe, Index 0 ist das Leerzeichen-Symbol.
 */
export async function ctcAlign(
  segments: TranscriptSegment[],
  labels: readonly string[],
  emit: EmitFn,
  options: CtcOptions,
): Promise<CtcResult> {
  const padMs = options.padMs ?? 1200;
  const maxWindowMs = options.maxWindowMs ?? 20_000;
  const minWordScore = options.minWordScore ?? 0.02;
  const alphabet = new Set(labels.slice(1));
  const index = new Map(labels.map((label, position) => [label, position]));

  const sentences: FlatSentence[] = [];
  segments.forEach((segment, s) => {
    segment.sentences.forEach((sentence, t) => {
      const raw = sentence.words.length > 0
        ? sentence.words.map((word) => word.text)
        : sentence.text.split(/\s+/).filter(Boolean);
      const words = raw.map((text, w) => ({
        segment: s,
        sentence: t,
        word: w,
        text,
        spoken: spokenForm(text, alphabet, w === raw.length - 1),
        startMs: null,
        endMs: null,
      }));
      sentences.push({ segment: s, sentence: t, startMs: sentence.startMs, endMs: sentence.endMs, words });
    });
  });

  const windows = planWindows(sentences, { padMs, maxWindowMs, durationMs: options.durationMs });
  for (const window of windows) {
    const words = window.sentences.flatMap((position) => sentences[position].words).filter((word) => word.spoken);
    if (words.length === 0 || window.toMs - window.fromMs < 100) continue;
    const emission = await emit(window.fromMs, window.toMs);
    const targets: number[] = [];
    const owner: number[] = [];
    words.forEach((word, position) => {
      for (const char of word.spoken) {
        targets.push(index.get(char) ?? 0);
        owner.push(position);
      }
    });
    const spans = ctcViterbi(emission, Int32Array.from(targets));
    if (!spans) continue;

    const firstFrame = new Array<number>(words.length).fill(-1);
    const lastFrame = new Array<number>(words.length).fill(-1);
    const scoreSum = new Array<number>(words.length).fill(0);
    const scoreCount = new Array<number>(words.length).fill(0);
    spans.forEach((span, k) => {
      const position = owner[k];
      if (firstFrame[position] < 0) firstFrame[position] = span.first;
      lastFrame[position] = span.last;
      scoreSum[position] += span.score;
      scoreCount[position] += 1;
    });
    words.forEach((word, position) => {
      if (scoreSum[position] / Math.max(scoreCount[position], 1) < minWordScore) return;
      word.startMs = Math.round(window.fromMs + firstFrame[position] * emission.frameMs);
      word.endMs = Math.round(window.fromMs + (lastFrame[position] + 1) * emission.frameMs);
    });
  }

  const all = sentences.flatMap((sentence) => sentence.words);
  const spoken = all.filter((word) => word.spoken).length;
  const placed = all.filter((word) => word.startMs !== null).length;
  fillUnplaced(sentences);

  const aligned = segments.map((segment) => ({
    ...segment,
    sentences: segment.sentences.map((sentence) => ({ ...sentence, words: [...sentence.words] })),
  }));
  for (const sentence of sentences) {
    const target = aligned[sentence.segment].sentences[sentence.sentence];
    const words: TranscriptWord[] = sentence.words.map((word) => ({
      text: word.text,
      startMs: word.startMs ?? sentence.startMs,
      endMs: Math.max(word.endMs ?? sentence.endMs, word.startMs ?? sentence.startMs),
    }));
    target.words = words;
    if (words.length > 0) {
      target.startMs = words[0].startMs;
      target.endMs = Math.max(words[words.length - 1].endMs, target.startMs);
    }
  }
  for (const segment of aligned) {
    if (segment.sentences.length === 0) continue;
    segment.startMs = Math.min(...segment.sentences.map((sentence) => sentence.startMs));
    segment.endMs = Math.max(...segment.sentences.map((sentence) => sentence.endMs));
  }

  return { segments: aligned, windows: windows.length, words: spoken, placed };
}

/**
 * Wörter ohne akustische Zeit (nicht gesprochen, zu unsicher, Fenster ohne
 * Lösung) werden zwischen ihre platzierten Nachbarn im selben Satz gelegt, im
 * Verhältnis ihrer Silben. Fehlt ein Nachbar, gilt die Satzgrenze.
 */
function fillUnplaced(sentences: FlatSentence[]): void {
  for (const sentence of sentences) {
    const words = sentence.words;
    let position = 0;
    while (position < words.length) {
      if (words[position].startMs !== null) {
        position += 1;
        continue;
      }
      let end = position;
      while (end < words.length && words[end].startMs === null) end += 1;
      const before = position > 0 ? words[position - 1] : null;
      const after = end < words.length ? words[end] : null;
      let fromMs = before ? (before.endMs ?? before.startMs!) : sentence.startMs;
      let toMs = after ? after.startMs! : Math.max(sentence.endMs, fromMs);
      if (!before && after) fromMs = Math.min(fromMs, toMs);
      if (before && !after) toMs = Math.max(toMs, fromMs);
      const run = words.slice(position, end);
      const weights = run.map((word) => wordWeight(word.text));
      const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
      let running = 0;
      run.forEach((word, offset) => {
        const start = fromMs + ((toMs - fromMs) * running) / total;
        running += weights[offset];
        const stop = fromMs + ((toMs - fromMs) * running) / total;
        word.startMs = Math.round(start);
        word.endMs = Math.round(stop);
      });
      position = end;
    }
  }
}
