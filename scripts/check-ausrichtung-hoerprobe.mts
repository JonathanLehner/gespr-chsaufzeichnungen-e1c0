/**
 * Gegenprobe zur Ausrichtung: Schneidet einzelne Sätze genau an den
 * ausgerichteten Zeiten aus der Aufnahme und lässt nur diesen Ausschnitt
 * transkribieren. Stimmt die Ausrichtung, steht im Ausschnitt derselbe Text.
 *
 * Das ist die einzige Prüfung, die nicht auf denselben Annahmen beruht wie die
 * Ausrichtung selbst: Sie hört nach, statt nachzurechnen.
 *
 * Aufruf: npx tsx --env-file=.env.local --conditions=react-server scripts/check-ausrichtung-hoerprobe.mts [aufnahmeId]
 */
import { Collections, findById, findMany } from "../src/lib/db";
import { energyEnvelope } from "../src/lib/audio-envelope";
import { alignToEnvelope } from "../src/lib/forced-alignment";
import { parseWavLayout } from "../src/lib/audio-split";
import { platformGemini, platformUploadAudio } from "../src/lib/platform";
import { loadTranscript } from "../src/lib/transcription";
import type { Recording } from "../src/lib/types";

const PROBES = 8;
/** Zugabe an beiden Enden, damit ein Wort am Rand nicht angeschnitten klingt. */
const MARGIN_MS = 250;

function wavCut(bytes: Uint8Array, fromMs: number, toMs: number): Uint8Array {
  const layout = parseWavLayout(bytes);
  if (!layout) throw new Error("WAV-Kopf nicht lesbar.");
  const at = (ms: number) =>
    Math.min(
      Math.max(Math.floor(((ms / 1000) * layout.byteRate) / layout.blockAlign) * layout.blockAlign, 0),
      layout.dataLength,
    );
  const body = bytes.subarray(layout.dataOffset + at(fromMs), layout.dataOffset + at(toMs));
  const out = new Uint8Array(44 + body.length);
  const view = new DataView(out.buffer);
  const write = (position: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) out[position + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + body.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, layout.audioFormat, true);
  view.setUint16(22, layout.channels, true);
  view.setUint32(24, layout.sampleRate, true);
  view.setUint32(28, layout.byteRate, true);
  view.setUint16(32, layout.blockAlign, true);
  view.setUint16(34, layout.bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, body.length, true);
  out.set(body, 44);
  return out;
}

const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);

/** Anteil der erwarteten Wörter, die im gehörten Ausschnitt vorkommen. */
function overlap(expected: string, heard: string): number {
  const wanted = tokens(expected);
  if (wanted.length === 0) return 1;
  const pool = new Set(tokens(heard));
  return wanted.filter((token) => pool.has(token)).length / wanted.length;
}

const id = process.argv[2];
const recording = id
  ? await findById<Recording>(Collections.recordings, id)
  : (await findMany<Recording>(Collections.recordings, { mimeType: "audio/wav" }))
      .filter((row) => row.transcriptionStatus === "abgeschlossen")
      .sort((a, b) => (b.wordCount ?? 0) - (a.wordCount ?? 0))[0];
if (!recording) throw new Error("Keine passende Aufnahme gefunden.");

const segments = await loadTranscript(recording._id);
const bytes = new Uint8Array(await (await fetch(recording.audioUrl)).arrayBuffer());
const envelope = energyEnvelope(bytes, recording.mimeType);
if (!envelope) throw new Error("Kein Lautstärkeverlauf.");

const aligned = alignToEnvelope(segments, envelope, { gaps: recording.transcriptionGaps ?? [] });
if (!aligned) throw new Error("Keine Ausrichtung möglich.");

type Probe = { text: string; startMs: number; endMs: number; label: string };
const collect = (source: typeof segments, label: string): Probe[] =>
  source
    .flatMap((segment) => segment.sentences)
    .map((sentence) => ({ text: sentence.text, startMs: sentence.startMs, endMs: sentence.endMs, label }));

const alignedSentences = collect(aligned.segments, "ausgerichtet");
const originalSentences = collect(segments, "Dienst");

// Längere Sätze prüfen sich zuverlässiger als „Ja.“; gewählt werden die
// wortreichsten, gleichmässig über das Gespräch verteilt.
const order = alignedSentences
  .map((probe, index) => ({ index, length: probe.text.length }))
  .sort((a, b) => b.length - a.length)
  .slice(0, PROBES * 2)
  .sort((a, b) => a.index - b.index)
  .filter((_, position) => position % 2 === 0)
  .slice(0, PROBES)
  .map((entry) => entry.index);

console.log(`Aufnahme ${recording._id} (${recording.durationMs} ms), ${order.length} Hörproben\n`);

let alignedScore = 0;
let originalScore = 0;

/** Der Dienst bleibt gelegentlich bei einer Anfrage hängen; dann neu ablegen und erneut fragen. */
async function listen(cut: Uint8Array): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploaded = await platformUploadAudio(cut, { timeoutMs: 60_000 });
      const answer = await platformGemini(
        {
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    "Transkribiere diesen kurzen Ausschnitt eines deutschsprachigen Telefongesprächs " +
                    "wortgetreu auf Deutsch. Antworte nur mit dem gesprochenen Text, ohne Zeitangaben " +
                    "und ohne Erklärung. Ist nichts zu hören, antworte mit einem Bindestrich.",
                },
                { fileData: { fileUri: uploaded.url, mimeType: recording!.mimeType } },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        },
        { timeoutMs: 120_000 },
      );
      return (answer.text ?? "").trim();
    } catch (error) {
      last = error;
    }
  }
  console.log(`   (keine Antwort: ${last instanceof Error ? last.message : String(last)})`);
  return "";
}

for (const index of order) {
  for (const probe of [alignedSentences[index], originalSentences[index]]) {
    const from = Math.max(0, probe.startMs - MARGIN_MS);
    const to = Math.min(envelope.durationMs, probe.endMs + MARGIN_MS);
    const heard = await listen(wavCut(bytes, from, to));
    const score = overlap(probe.text, heard);
    if (probe.label === "ausgerichtet") alignedScore += score;
    else originalScore += score;
    console.log(
      `${probe.label.padEnd(12)} ${String(from).padStart(6)}–${String(to).padEnd(6)} ` +
        `Deckung ${(score * 100).toFixed(0).padStart(3)} %`,
    );
    if (probe.label === "ausgerichtet") console.log(`   erwartet: ${probe.text}`);
    console.log(`   gehört  : ${heard.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  console.log();
}

const count = order.length;
console.log(`Mittlere Deckung ausgerichtet: ${((alignedScore / count) * 100).toFixed(0)} %`);
console.log(`Mittlere Deckung Dienstzeiten: ${((originalScore / count) * 100).toFixed(0)} %`);
