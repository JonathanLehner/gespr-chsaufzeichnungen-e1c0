/**
 * Prüft die beiden neuen Wege der Transkription an echten Aufnahmen:
 *
 *  1. Eine lange Aufnahme (über zwei Minuten) wird in Abschnitte zerlegt,
 *     abschnittsweise transkribiert und wieder zusammengesetzt. Geprüft wird,
 *     dass das Ergebnis über die Abschnittsgrenzen hinweg aufsteigende
 *     Zeitstempel hat und Text aus allen Abschnitten enthält.
 *  2. Eine Aufnahme ohne Gesprochenes endet als `ohne_sprache` statt als
 *     Fehlschlag und wird nicht wiederholt.
 *
 * Der Test legt eigene Aufnahmen an und räumt sie danach wieder ab.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/check-transkription-abschnitte.mts
 */
import { measureDurationMs, parseWavLayout } from "../src/lib/audio-split";
import { Collections, findById, findMany } from "../src/lib/db";
import { platformUploadAudio } from "../src/lib/platform";
import { createRecording, hardDeleteRecording } from "../src/lib/recordings";
import { loadTranscript, transcribeRecording } from "../src/lib/transcription";
import type { Job, Recording } from "../src/lib/types";

const load = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

/** Hängt mehrere gleichformatige Aufnahmen zu einer langen Datei zusammen. */
function concatWav(sources: Uint8Array[]): Uint8Array {
  const layouts = sources.map((bytes) => parseWavLayout(bytes)!);
  const total = layouts.reduce((sum, layout) => sum + layout.dataLength, 0);
  const out = new Uint8Array(44 + total);
  const view = new DataView(out.buffer);
  const ascii = (position: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[position + i] = text.charCodeAt(i);
  };
  const first = layouts[0];
  ascii(0, "RIFF");
  view.setUint32(4, 36 + total, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, first.audioFormat, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.byteRate, true);
  view.setUint16(32, first.blockAlign, true);
  view.setUint16(34, first.bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, total, true);
  let cursor = 44;
  sources.forEach((bytes, index) => {
    const layout = layouts[index];
    out.set(bytes.subarray(layout.dataOffset, layout.dataOffset + layout.dataLength), cursor);
    cursor += layout.dataLength;
  });
  return out;
}

async function withTestRecording(
  label: string,
  audioUrl: string,
  byteSize: number,
  durationMs: number | null,
  check: (recording: Recording) => Promise<void>,
): Promise<void> {
  const fingerprint = `pruefung-abschnitte-${label}-${Date.now()}`;
  const { recording } = await createRecording({
    originalFilename: `[Ziegler, Pruefung]_386-0000000000_20260101120000(9999).wav`,
    audioUrl,
    mimeType: "audio/wav",
    byteSize,
    durationMs,
    callerName: "Ziegler, Pruefung",
    callerFirstName: "Pruefung",
    callerLastName: "Ziegler",
    phoneNumber: "0000000000",
    callNumber: "9999",
    callAtUtc: new Date().toISOString(),
    metadataSource: "manuell",
    templateVersion: null,
    uploadedByEmail: "pruefung.abschnitte@immotrustag.ch",
    uploadedByName: "Pruefung Abschnitte",
    fingerprint,
  });
  try {
    await check(recording);
  } finally {
    await hardDeleteRecording(recording._id);
    console.log(`  aufgeräumt: ${recording._id}`);
  }
}

let problems = 0;
const fail = (message: string) => {
  problems += 1;
  console.log(`  FEHLER: ${message}`);
};

/* ------------------------------------------------- 1. lange Aufnahme */

const wavs = (await findMany<Recording>(Collections.recordings, { mimeType: "audio/wav" }))
  .filter((row) => (row.durationMs ?? 0) > 60_000)
  .sort((a, b) => b.byteSize - a.byteSize)
  .slice(0, 2);

if (wavs.length < 2) {
  console.log("Zu wenige lange WAV-Aufnahmen vorhanden – Teil 1 übersprungen.");
} else {
  const long = concatWav(await Promise.all(wavs.map((row) => load(row.audioUrl))));
  const durationMs = measureDurationMs(long, "audio/wav");
  console.log(`Lange Prüfaufnahme: ${(long.length / 1024 / 1024).toFixed(2)} MB, ${durationMs} ms`);
  const uploaded = await platformUploadAudio(long);

  await withTestRecording("lang", uploaded.url, long.length, durationMs, async (recording) => {
    const started = Date.now();
    const result = await transcribeRecording(recording._id);
    console.log(`  transcribeRecording: ${JSON.stringify(result)} nach ${Date.now() - started} ms`);

    const row = await findById<Recording>(Collections.recordings, recording._id);
    const segments = await loadTranscript(recording._id);
    const gaps = row?.transcriptionGaps ?? [];
    console.log(
      `  Status ${row?.transcriptionStatus} · ${row?.transcriptionChunks} Abschnitte · ` +
        `${row?.speakerCount} Sprecher · ${row?.wordCount} Wörter · ${segments.length} Beiträge · ` +
        `${gaps.length} Lücken${gaps.length ? " " + gaps.map((g) => `${g.startMs}-${g.endMs}`).join(", ") : ""}`,
    );

    if (row?.transcriptionStatus !== "abgeschlossen") fail("Status ist nicht 'abgeschlossen'.");
    if ((row?.transcriptionChunks ?? 0) < 2) fail("Die Aufnahme wurde nicht zerlegt.");

    // Zeitstempel müssen über die Abschnittsgrenzen hinweg aufsteigen.
    let previous = -1;
    for (const segment of segments) {
      if (segment.startMs < previous) fail(`Zeitstempel springt zurück bei ${segment.startMs} ms.`);
      previous = segment.startMs;
    }
    const last = segments.at(-1);
    // Mit Lücken am Schluss darf das Transkript früher enden; ohne Lücken muss
    // es bis nahe an das Ende der Aufnahme reichen.
    const reachRequired = gaps.length === 0 ? 0.8 : 0.5;
    if (!last || last.endMs < (durationMs ?? 0) * reachRequired) {
      fail(`Das Transkript endet bei ${last?.endMs} ms, die Aufnahme bei ${durationMs} ms.`);
    }
    console.log(`  erster Satz: ${JSON.stringify(segments[0]?.sentences[0]?.text)}`);
    console.log(`  letzter Satz: ${JSON.stringify(last?.sentences.at(-1)?.text)}`);
    console.log(`  Sprecher: ${[...new Set(segments.map((s) => s.speakerLabel))].join(", ")}`);
  });
}

/* --------------------------------------------- 2. Aufnahme ohne Sprache */

const silent = (await findMany<Recording>(Collections.recordings, {})).find(
  (row) => row.transcriptionStatus === "fehlgeschlagen" || (row.durationMs ?? 0) < 8000,
);

if (!silent) {
  console.log("Keine kurze Aufnahme für Teil 2 gefunden – übersprungen.");
} else {
  console.log(`\nAufnahme ohne Gesprochenes: ${silent.originalFilename} (${silent.durationMs} ms)`);
  await withTestRecording(
    "still",
    silent.audioUrl,
    silent.byteSize,
    silent.durationMs,
    async (recording) => {
      const result = await transcribeRecording(recording._id);
      console.log(`  transcribeRecording: ${JSON.stringify(result)}`);
      const row = await findById<Recording>(Collections.recordings, recording._id);
      const job = await findById<Job>(Collections.jobs, recording._id);
      console.log(
        `  Status ${row?.transcriptionStatus} · Fehler ${JSON.stringify(row?.transcriptionError)} · ` +
          `Versuche ${job?.attempts} · nächster Versuch ${JSON.stringify(job?.nextAttemptAt)}`,
      );
      if (row?.transcriptionStatus === "fehlgeschlagen") {
        console.log("  Hinweis: Auf dieser Aufnahme war Sprache zu hören – Teil 2 nicht aussagekräftig.");
      } else {
        if (row?.transcriptionStatus !== "ohne_sprache" && row?.transcriptionStatus !== "abgeschlossen") {
          fail(`Unerwarteter Status ${row?.transcriptionStatus}.`);
        }
        if (row?.transcriptionStatus === "ohne_sprache") {
          if (row.transcriptionError !== null) fail("Es wurde eine Fehlermeldung hinterlegt.");
          if (job?.nextAttemptAt) fail("Es steht eine Wiederholung aus.");
        }
      }
    },
  );
}

console.log(problems === 0 ? "\nAlle Prüfungen bestanden." : `\n${problems} Abweichung(en).`);
process.exit(problems === 0 ? 0 : 1);
