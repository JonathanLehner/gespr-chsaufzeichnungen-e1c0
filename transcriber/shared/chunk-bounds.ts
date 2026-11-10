/**
 * Abschnittsgrenzen einer Aufnahme. Reine Funktionen ohne Laufzeitabhängigkeiten.
 *
 * Die Flash-Modelle hören feste 60-s-Abschnitte. gemini-3.5-transcribe bekommt
 * längere Abschnitte (Grenze von Google: 30 min je Anfrage mit Wortzeiten und
 * Sprechern), die in einer Pause enden, damit kein Wort zerschnitten wird.
 */
import type { SpeechRegion } from "./forced-alignment";

export type ChunkBounds = { startMs: number; endMs: number };

/** Feste Abschnitte von `chunkMs`. */
export function fixedBounds(durationMs: number, chunkMs: number): ChunkBounds[] {
  const count = Math.max(1, Math.ceil(durationMs / chunkMs));
  return Array.from({ length: count }, (_, index) => ({
    startMs: index * chunkMs,
    endMs: Math.min((index + 1) * chunkMs, durationMs),
  }));
}

/**
 * Abschnitte von höchstens `maxMs`, geschnitten in der Mitte der längsten Pause
 * im letzten Drittel des erlaubten Fensters. Ohne erkannte Pause (oder ohne
 * Lautstärkeverlauf) wird bei `maxMs` geschnitten.
 */
export function boundsAtPauses(durationMs: number, maxMs: number, speech: readonly SpeechRegion[] | null): ChunkBounds[] {
  if (durationMs <= maxMs) return [{ startMs: 0, endMs: durationMs }];
  const pauses: SpeechRegion[] = [];
  if (speech && speech.length > 0) {
    if (speech[0].startMs > 0) pauses.push({ startMs: 0, endMs: speech[0].startMs });
    for (let index = 1; index < speech.length; index += 1) {
      pauses.push({ startMs: speech[index - 1].endMs, endMs: speech[index].startMs });
    }
  }
  const bounds: ChunkBounds[] = [];
  let start = 0;
  while (durationMs - start > maxMs) {
    const windowStart = start + Math.round(maxMs * (2 / 3));
    const windowEnd = start + maxMs;
    let best: { at: number; length: number } | null = null;
    for (const pause of pauses) {
      const from = Math.max(pause.startMs, windowStart);
      const to = Math.min(pause.endMs, windowEnd);
      if (to <= from) continue;
      if (!best || to - from > best.length) best = { at: Math.round((from + to) / 2), length: to - from };
    }
    const cut = best?.at ?? windowEnd;
    bounds.push({ startMs: start, endMs: cut });
    start = cut;
  }
  bounds.push({ startMs: start, endMs: durationMs });
  return bounds;
}
