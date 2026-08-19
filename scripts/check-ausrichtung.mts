/**
 * Prüft die Ausrichtung des Transkripts an der Aufnahme
 * (`src/lib/forced-alignment.ts`).
 *
 * Gemessen wird für jede Aufnahme mit Transkript, wie weit die Anfänge der
 * Sätze und der Wörter von der nächstgelegenen Sprechflanke entfernt liegen –
 * einmal mit den Zeiten des Transkriptionsdienstes, einmal mit den neu
 * ausgerichteten. Zusätzlich wird nachgerechnet, dass die Zeiten aufsteigend
 * bleiben und kein Wort in einer Sprechpause beginnt.
 *
 * Aufruf: npx tsx --env-file=.env.local --conditions=react-server scripts/check-ausrichtung.mts
 */
import { Collections, findMany } from "../src/lib/db";
import { energyEnvelope } from "../src/lib/audio-envelope";
import { alignToEnvelope, detectSpeech, type SpeechRegion } from "../src/lib/forced-alignment";
import { loadTranscript } from "../src/lib/transcription";
import type { Recording, TranscriptSegment } from "../src/lib/types";

function flatten(segments: TranscriptSegment[]) {
  const sentences = segments.flatMap((segment) => segment.sentences);
  return { sentences, words: sentences.flatMap((sentence) => sentence.words) };
}

/** Abstand zur nächstgelegenen Flanke eines Sprechabschnitts. */
function edgeDistance(ms: number, regions: SpeechRegion[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    best = Math.min(best, Math.abs(region.startMs - ms), Math.abs(region.endMs - ms));
  }
  return best;
}

function inSpeech(ms: number, regions: SpeechRegion[]): boolean {
  return regions.some((region) => ms >= region.startMs && ms <= region.endMs);
}

function stats(values: number[]) {
  if (values.length === 0) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: Math.round(sorted[sorted.length >> 1]),
    p90: Math.round(sorted[Math.floor(sorted.length * 0.9)]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

const recordings = (await findMany<Recording>(Collections.recordings, {}))
  .filter((recording) => recording.transcriptionStatus === "abgeschlossen")
  .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

let failures = 0;
const before: number[] = [];
const after: number[] = [];
const wordsAfter: number[] = [];

for (const recording of recordings) {
  const segments = await loadTranscript(recording._id);
  if (segments.length === 0) continue;

  const bytes = new Uint8Array(await (await fetch(recording.audioUrl)).arrayBuffer());
  const envelope = energyEnvelope(bytes, recording.mimeType);
  if (!envelope) {
    console.log(`${recording._id}: kein Lautstärkeverlauf (${recording.mimeType})`);
    failures += 1;
    continue;
  }

  const regions = detectSpeech(envelope);
  const started = Date.now();
  const result = alignToEnvelope(segments, envelope, {
    gaps: recording.transcriptionGaps ?? [],
  });
  const took = Date.now() - started;

  if (!result) {
    console.log(`${recording._id}: keine Ausrichtung möglich (${envelope.durationMs} ms)`);
    continue;
  }

  const oldFlat = flatten(segments);
  const newFlat = flatten(result.segments);

  const oldDistances = oldFlat.sentences.map((sentence) => edgeDistance(sentence.startMs, regions));
  const newDistances = newFlat.sentences.map((sentence) => edgeDistance(sentence.startMs, regions));
  before.push(...oldDistances);
  after.push(...newDistances);

  const wordDistances = newFlat.words.map((word) => edgeDistance(word.startMs, regions));
  wordsAfter.push(...wordDistances);

  // Nachrechnen: aufsteigend, innerhalb der Aufnahme, jedes Wort im Sprechen.
  const problems: string[] = [];
  let previous = -1;
  for (const word of newFlat.words) {
    if (word.startMs < previous) problems.push(`Wortzeit fällt zurück bei ${word.startMs} ms`);
    if (word.endMs < word.startMs) problems.push(`Wortende vor Wortanfang bei ${word.startMs} ms`);
    previous = word.startMs;
  }
  if (newFlat.words.length !== oldFlat.words.length) {
    problems.push(`Wortzahl geändert: ${oldFlat.words.length} → ${newFlat.words.length}`);
  }
  const last = newFlat.words[newFlat.words.length - 1];
  if (last && last.endMs > envelope.durationMs + 200) {
    problems.push(`letztes Wort endet nach der Aufnahme (${last.endMs} > ${envelope.durationMs})`);
  }
  const outside = newFlat.words.filter((word) => !inSpeech(word.startMs, regions)).length;
  const share = newFlat.words.length > 0 ? outside / newFlat.words.length : 0;
  if (share > 0.05) problems.push(`${outside} von ${newFlat.words.length} Wörtern beginnen in einer Pause`);

  const oldStat = stats(oldDistances);
  const newStat = stats(newDistances);
  console.log(
    `${recording._id} ${String(recording.durationMs).padStart(7)} ms · ` +
      `${oldFlat.sentences.length} Sätze, ${newFlat.words.length} Wörter · ` +
      `Sprache ${result.speechMs} ms in ${result.regionCount} Abschnitten · ${took} ms\n` +
      `   Satzanfang→Flanke  vorher  Median ${String(oldStat.median).padStart(5)}  p90 ${String(oldStat.p90).padStart(5)}  max ${oldStat.max}\n` +
      `                      nachher Median ${String(newStat.median).padStart(5)}  p90 ${String(newStat.p90).padStart(5)}  max ${newStat.max}\n` +
      `   Wörter in Pause begonnen: ${outside}/${newFlat.words.length}`,
  );
  for (const problem of problems) {
    console.log(`   FEHLER ${problem}`);
    failures += 1;
  }
}

const summaryBefore = stats(before);
const summaryAfter = stats(after);
const summaryWords = stats(wordsAfter);
console.log("\nÜber alle Aufnahmen");
console.log(`  Satzanfang→Flanke vorher : Median ${summaryBefore.median} ms, p90 ${summaryBefore.p90} ms, max ${summaryBefore.max} ms`);
console.log(`  Satzanfang→Flanke nachher: Median ${summaryAfter.median} ms, p90 ${summaryAfter.p90} ms, max ${summaryAfter.max} ms`);
console.log(`  Wortanfang→Flanke nachher: Median ${summaryWords.median} ms, p90 ${summaryWords.p90} ms, max ${summaryWords.max} ms`);

if (failures > 0) {
  console.log(`\n${failures} Beanstandungen.`);
  process.exit(1);
}
console.log("\nAlle Prüfungen bestanden.");
