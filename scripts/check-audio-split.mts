/**
 * Prüft das verlustfreie Zerlegen langer Aufnahmen (`src/lib/audio-split.ts`).
 *
 * Aus zwei vorhandenen Aufnahmen wird eine lange Datei zusammengesetzt, geteilt
 * und nachgerechnet: Die Abschnitte müssen lückenlos aneinander anschliessen,
 * ihre eigenen Kopfdaten müssen die angegebene Dauer bestätigen, und die
 * Datenteile müssen zusammen wieder das Original ergeben.
 *
 * Aufruf: npx tsx scripts/check-audio-split.mts
 */
import { Collections, findMany } from "../src/lib/db";
import { measureDurationMs, parseWavLayout, splitAudio } from "../src/lib/audio-split";
import type { Recording } from "../src/lib/types";

const CHUNK_TARGET_MS = 90_000;

const recordings = (await findMany<Recording>(Collections.recordings, { mimeType: "audio/wav" }))
  .sort((a, b) => b.byteSize - a.byteSize)
  .slice(0, 2);

if (recordings.length < 2) {
  console.log("Zu wenige WAV-Aufnahmen für den Test.");
  process.exit(0);
}

const load = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const sources = await Promise.all(recordings.map((row) => load(row.audioUrl)));
const layouts = sources.map((bytes) => parseWavLayout(bytes));
if (layouts.some((layout) => layout === null)) throw new Error("WAV-Kopf nicht lesbar.");

// Beide Aufnahmen haben dasselbe Format (8 kHz, mono, 16 bit) und lassen sich
// deshalb einfach hintereinanderhängen.
const total = layouts.reduce((sum, layout) => sum + layout!.dataLength, 0);
const body = new Uint8Array(total);
let cursor = 0;
sources.forEach((bytes, index) => {
  const layout = layouts[index]!;
  body.set(bytes.subarray(layout.dataOffset, layout.dataOffset + layout.dataLength), cursor);
  cursor += layout.dataLength;
});

// Der Kopf wird neu geschrieben statt kopiert: Die Aufnahmen der Telefonanlage
// tragen einen 18 Byte langen fmt-Block, ihr Kopf ist also 46 und nicht 44
// Bytes lang.
const source = layouts[0]!;
const long = new Uint8Array(44 + body.length);
const view = new DataView(long.buffer);
const ascii = (position: number, text: string) => {
  for (let index = 0; index < text.length; index += 1) long[position + index] = text.charCodeAt(index);
};
ascii(0, "RIFF");
view.setUint32(4, 36 + body.length, true);
ascii(8, "WAVE");
ascii(12, "fmt ");
view.setUint32(16, 16, true);
view.setUint16(20, source.audioFormat, true);
view.setUint16(22, source.channels, true);
view.setUint32(24, source.sampleRate, true);
view.setUint32(28, source.byteRate, true);
view.setUint16(32, source.blockAlign, true);
view.setUint16(34, source.bitsPerSample, true);
ascii(36, "data");
view.setUint32(40, body.length, true);
long.set(body, 44);

const durationMs = measureDurationMs(long, "audio/wav");
console.log(`Prüfdatei: ${(long.length / 1024 / 1024).toFixed(2)} MB, ${durationMs} ms`);

const chunks = splitAudio(long, "audio/wav", CHUNK_TARGET_MS);
if (!chunks) throw new Error("Die Datei liess sich nicht zerlegen.");

let expectedStart = 0;
let dataBytes = 0;
let problems = 0;
for (const [index, chunk] of chunks.entries()) {
  const bytes = chunk.toBytes();
  const own = measureDurationMs(bytes, "audio/wav") ?? -1;
  const gapless = chunk.startMs === expectedStart;
  const consistent = Math.abs(own - (chunk.endMs - chunk.startMs)) <= 1;
  const short = chunk.endMs - chunk.startMs <= CHUNK_TARGET_MS;
  if (!gapless || !consistent || !short) problems += 1;
  console.log(
    `  #${index} ${chunk.startMs}–${chunk.endMs} ms · ${(bytes.length / 1024).toFixed(0)} KB · eigener Kopf ${own} ms` +
      `${gapless ? "" : " · LÜCKE"}${consistent ? "" : " · KOPF WEICHT AB"}${short ? "" : " · ZU LANG"}`,
  );
  expectedStart = chunk.endMs;
  dataBytes += bytes.length - 44;
}

if (dataBytes !== body.length) {
  problems += 1;
  console.log(`  Datenteile ${dataBytes} Bytes, Original ${body.length} Bytes – ABWEICHUNG`);
}
if (Math.abs(expectedStart - (durationMs ?? 0)) > 1) {
  problems += 1;
  console.log(`  Abschnitte enden bei ${expectedStart} ms, Datei bei ${durationMs} ms – ABWEICHUNG`);
}

console.log(
  problems === 0
    ? `\n${chunks.length} Abschnitte, lückenlos und verlustfrei.`
    : `\n${problems} Abweichung(en) gefunden.`,
);
process.exit(problems === 0 ? 0 : 1);
