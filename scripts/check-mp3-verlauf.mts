/**
 * Prüft den Lautstärkeverlauf von MP3-Dateien (`src/lib/audio-envelope.ts`).
 *
 * MP3 wird nicht decodiert – die Laufzeitumgebung lässt keinen Decoder zu –,
 * sondern über das Feld `global_gain` der Seiteninformation ausgelesen. Ob das
 * stimmt, lässt sich nur gegen ein bekanntes Signal prüfen: Eine vorhandene
 * WAV-Aufnahme wird nach MP3 codiert, und der aus dem MP3 gelesene Verlauf muss
 * dieselben Sprechabschnitte ergeben wie der aus dem WAV berechnete.
 *
 * Zusätzlich läuft ein künstliches Signal mit bekannter Abfolge aus Ton und
 * Stille durch, damit der Test auch ohne Bestand aussagekräftig bleibt.
 *
 * Aufruf: npx tsx --env-file=.env.local --conditions=react-server scripts/check-mp3-verlauf.mts
 */
import * as lame from "@breezystack/lamejs";
import { Collections, findMany } from "../src/lib/db";
import { parseWavLayout } from "../src/lib/audio-split";
import { energyEnvelope } from "../src/lib/audio-envelope";
import { detectSpeech, type SpeechRegion } from "../src/lib/forced-alignment";
import type { Recording } from "../src/lib/types";

const Mp3Encoder = (lame as unknown as { Mp3Encoder: new (...args: number[]) => {
  encodeBuffer(samples: Int16Array): Uint8Array;
  flush(): Uint8Array;
} }).Mp3Encoder;

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

function encodeMp3(samples: Int16Array, sampleRate: number, kbps = 64): Uint8Array {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const block = 1152;
  for (let at = 0; at < samples.length; at += block) {
    const chunk = encoder.encodeBuffer(samples.subarray(at, Math.min(at + block, samples.length)));
    if (chunk.length > 0) parts.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(tail);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Anteil der Zeit, in der beide Einteilungen dasselbe sagen. */
function agreement(a: SpeechRegion[], b: SpeechRegion[], durationMs: number, stepMs = 20): number {
  const covers = (regions: SpeechRegion[], ms: number) =>
    regions.some((region) => ms >= region.startMs && ms < region.endMs);
  let same = 0;
  let total = 0;
  for (let ms = 0; ms < durationMs; ms += stepMs) {
    if (covers(a, ms) === covers(b, ms)) same += 1;
    total += 1;
  }
  return total > 0 ? same / total : 0;
}

/* 1 – Künstliches Signal: je eine Sekunde Ton und Stille im Wechsel. */
{
  const rate = 16_000;
  const seconds = 8;
  const samples = new Int16Array(rate * seconds);
  for (let index = 0; index < samples.length; index += 1) {
    const loud = Math.floor(index / rate) % 2 === 0;
    samples[index] = loud ? Math.round(9000 * Math.sin((2 * Math.PI * 300 * index) / rate)) : 0;
  }
  const envelope = energyEnvelope(encodeMp3(samples, rate), "audio/mpeg");
  record("Verlauf aus MP3 lesbar", envelope !== null, envelope ? `${envelope.rms.length} Rahmen` : "null");

  if (envelope) {
    const regions = detectSpeech(envelope);
    const expected: SpeechRegion[] = [0, 2, 4, 6].map((second) => ({
      startMs: second * 1000,
      endMs: (second + 1) * 1000,
    }));
    const share = agreement(regions, expected, seconds * 1000);
    record(
      "Ton und Stille richtig getrennt",
      regions.length === 4 && share > 0.9,
      `${regions.length} Abschnitte (erwartet 4), ${(share * 100).toFixed(0)} % Übereinstimmung: ` +
        regions.map((region) => `${region.startMs}–${region.endMs}`).join(" "),
    );
  }
}

/* 2 – Echte Aufnahmen: derselbe Ton einmal als WAV, einmal als MP3.
   Geprüft werden die kürzeste, eine mittlere und die längste Aufnahme, damit
   sowohl wenige als auch sehr viele Granulate durchlaufen. */
{
  const wavs = (await findMany<Recording>(Collections.recordings, { mimeType: "audio/wav" })).sort(
    (a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0),
  );
  const chosen = [wavs[0], wavs[Math.floor(wavs.length / 2)], wavs[wavs.length - 1]].filter(
    (row, index, list) => row && list.indexOf(row) === index,
  );

  if (chosen.length === 0) {
    record("Echte Aufnahmen geprüft", false, "keine WAV-Aufnahme im Bestand");
  }

  const shares: number[] = [];
  for (const recording of chosen) {
    const bytes = new Uint8Array(await (await fetch(recording.audioUrl)).arrayBuffer());
    const layout = parseWavLayout(bytes);
    if (!layout || layout.bitsPerSample !== 16 || layout.channels !== 1) {
      record(`${recording._id} geprüft`, false, "Aufnahme ist nicht 16-bit mono");
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.floor(layout.dataLength / layout.blockAlign);
    const samples = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = view.getInt16(layout.dataOffset + index * layout.blockAlign, true);
    }

    const fromWav = energyEnvelope(bytes, "audio/wav")!;
    const fromMp3 = energyEnvelope(encodeMp3(samples, layout.sampleRate), "audio/mpeg");
    if (!fromMp3) {
      record(`${recording._id}: Verlauf aus MP3 lesbar`, false, "null");
      continue;
    }

    const wavRegions = detectSpeech(fromWav);
    const mp3Regions = detectSpeech(fromMp3);
    const share = agreement(wavRegions, mp3Regions, fromWav.durationMs);
    shares.push(share);
    const speechWav = wavRegions.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
    const speechMp3 = mp3Regions.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
    record(
      `${recording._id}: Sprechabschnitte aus MP3 decken sich mit denen aus WAV`,
      share > 0.75,
      `${(share * 100).toFixed(0)} % der Zeit gleich · ${fromWav.durationMs} ms · ` +
        `${wavRegions.length}/${mp3Regions.length} Abschnitte · ${speechWav}/${speechMp3} ms Sprache`,
    );
  }

  if (shares.length > 0) {
    const mittel = shares.reduce((sum, share) => sum + share, 0) / shares.length;
    record("Übereinstimmung im Mittel über 85 %", mittel > 0.85, `${(mittel * 100).toFixed(0)} %`);
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length === 0 ? 0 : 1);
