/**
 * Ende-zu-Ende-Prüfung des direkten Wegs für gemini-3.5-transcribe gegen eine
 * Wegwerf-Datenbank und die echte Gemini API (kostet rund $0.005 je
 * Audiominute): Der Dienst schneidet die Aufnahme in Pausen, lädt die
 * Abschnitte über die Files API hoch, transkribiert über die Interactions-API
 * mit Wortzeiten und Sprechern und speichert das Transkript mit
 * `timing: "modell"`, Tokens und Kosten. Ein bestehendes Transkript wandert
 * samt Text in die Historie.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27999/direkt_check?directConnection=true" \
 *   GEMINI_API_KEY=... AUDIO_URL=https://…/api/dateien/<schlüssel> \
 *     npx tsx scripts/check-gemini-direkt.mts
 *
 * AUDIO_URL: eine WAV-Aufnahme mit Sprache, mindestens 5 Minuten für zwei Abschnitte.
 * Die Datenbank wird geleert: nie gegen Produktion ausführen.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MongoClient } from "mongodb";

const uri = process.env.TEST_MONGODB_URI;
if (!uri || /mongodb\+srv|mongodb\.net/.test(uri)) {
  console.error("TEST_MONGODB_URI fehlt oder zeigt nicht auf eine lokale Wegwerf-Datenbank.");
  process.exit(1);
}
const audioUrl = process.env.AUDIO_URL;
if (!process.env.GEMINI_API_KEY || !audioUrl) {
  console.error("GEMINI_API_KEY und AUDIO_URL müssen gesetzt sein.");
  process.exit(1);
}

type Doc = { _id: string; [field: string]: unknown };
const client = await new MongoClient(uri).connect();
const db = client.db();
for (const name of ["jobs", "recordings", "transcript_parts", "transcript_history_parts", "transcript_index", "transcriber_workers", "transcriber_limiter", "settings", "transcription_runs"]) {
  await db.collection(name).deleteMany({});
}
const id = "rec_direkt";
await db.collection<Doc>("recordings").insertOne({
  _id: id, audioUrl, mimeType: "audio/wav", durationMs: null,
  transcriptionStatus: "abgeschlossen", transcriptionFinishedAt: "2026-10-01T10:00:00.000Z",
  callerFirstName: "Valerio", callerLastName: "Labruzzo (IT)",
});
await db.collection<Doc>("transcript_parts").insertOne({
  _id: `${id}:0`, recordingId: id, partIndex: 0, partCount: 1,
  segments: [{ speaker: "S1", speakerLabel: "Sprecher 1", startMs: 0, endMs: 1000, sentences: [{ text: "Alter Text.", startMs: 0, endMs: 1000, words: [] }] }],
});
await db.collection<Doc>("jobs").insertOne({
  _id: id, recordingId: id, status: "wartend", background: true, kind: "transkription", model: "gemini-3.5-transcribe",
  attempts: 0, lockedAt: null, nextAttemptAt: null, type: "transkription", createdAt: new Date().toISOString(),
});
await db.collection<Doc>("transcriber_limiter").insertOne({
  _id: "gemini", leases: [], recent: [], controlVersion: 0,
  settings: { maxConcurrent: 1, minGapMs: 4000, jobsPerInstance: 1, updatedAt: new Date().toISOString(), updatedBy: "test" },
});

const child = spawn(process.execPath, ["--import", "tsx", "worker.ts"], {
  cwd: join(import.meta.dirname, "..", "transcriber"),
  env: { ...process.env, MONGODB_URI: uri, CLAWCORP_API_KEY: process.env.CLAWCORP_API_KEY || "nicht-benutzt" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data) => process.stdout.write(`[dienst] ${data}`));
child.stderr.on("data", (data) => process.stdout.write(`[dienst] ${data}`));

const deadline = Date.now() + 8 * 60 * 1000;
let job: Doc | null = null;
while (Date.now() < deadline) {
  job = await db.collection<Doc>("jobs").findOne({ _id: id });
  if (job && ["abgeschlossen", "fehlgeschlagen", "ohne_sprache"].includes(job.status as string)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));

const errors: string[] = [];
const recording = await db.collection<Doc>("recordings").findOne({ _id: id });
const meta = recording?.transcript as { model?: string; timing?: string; usage?: { audioInput: number; requests: number }; costUsd?: number; audioMs?: number } | undefined;
if (job?.status !== "abgeschlossen") errors.push(`Auftrag: ${job?.status} ${job?.lastError ?? ""}`);
if (meta?.model !== "gemini-3.5-transcribe") errors.push(`Modell: ${meta?.model}`);
if (meta?.timing !== "modell") errors.push(`Zeiten: ${meta?.timing}`);
if (!meta?.usage || meta.usage.audioInput <= 0 || !(meta.costUsd! > 0)) errors.push("Tokens oder Kosten fehlen.");
const parts = await db.collection<Doc>("transcript_parts").find({ recordingId: id }).sort({ partIndex: 1 }).toArray();
const segments = parts.flatMap((part) => part.segments as { speakerLabel: string; sentences: { words: { text: string; startMs: number; endMs: number }[] }[] }[]);
const words = segments.flatMap((segment) => segment.sentences.flatMap((sentence) => sentence.words));
const audioMs = meta?.audioMs ?? 0;
let backwards = 0;
for (let index = 1; index < words.length; index += 1) if (words[index].startMs < words[index - 1].startMs) backwards += 1;
const outside = words.filter((word) => word.startMs < 0 || word.endMs > audioMs + 500).length;
const implausible = words.filter((word) => word.endMs <= word.startMs || word.endMs - word.startMs > 3000).length;
if (words.length < 20) errors.push(`Nur ${words.length} Wörter.`);
if (backwards > 0) errors.push(`${backwards} Wörter beginnen vor ihrem Vorgänger.`);
if (outside > 0) errors.push(`${outside} Wörter ausserhalb der Aufnahme.`);
const speakers = [...new Set(segments.map((segment) => segment.speakerLabel))];
const archived = await db.collection<Doc>("transcript_history_parts").countDocuments({ recordingId: id });
if (archived !== 1) errors.push(`Abgelöster Text nicht aufbewahrt (${archived}).`);
const history = recording?.transcriptHistory as unknown[] | undefined;
if (history?.length !== 1) errors.push(`Historie: ${history?.length ?? 0} Einträge.`);

console.log(
  `Wörter ${words.length}, Sprecher ${speakers.join(", ")}, Abschnitte ${recording?.transcriptionChunks}, ` +
    `Anfragen ${meta?.usage?.requests}, Kosten $${meta?.costUsd?.toFixed(5)}, ` +
    `Dauer ≤0 oder >3 s: ${implausible}, rückwärts ${backwards}, ausserhalb ${outside}`,
);
await client.close();
if (errors.length > 0) {
  console.error("FEHL:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("OK");
process.exit(0);
