/**
 * Ende-zu-Ende-Prüfung der Modellwahl und der nachrangigen Neu-Transkription
 * gegen eine Wegwerf-Datenbank und einen nachgebildeten Transkriptionsdienst:
 *  - Ein neuer Upload wird vor wartenden Neu-Transkriptionen übernommen.
 *  - Während der Neu-Transkription bleibt die Aufnahme „abgeschlossen“ mit
 *    ihrem bisherigen Transkript; danach trägt sie Modell, Tokens, Kosten und
 *    die abgelöste Fassung in der Historie.
 *  - Das Modell je Auftrag, minimales Denken und das Vokabular gehen in die Anfrage.
 *  - „Neu ausrichten“ stellt keine Anfrage und vermerkt `retimedAt`.
 *  - Jeder Lauf landet in `transcription_runs`.
 *  - Neue Uploads laufen mit dem Standardmodell gemini-3.5-flash-lite, die
 *    Anfrage bindet die Antwort an `responseSchema`.
 *  - Eine Antwort ohne gültiges JSON wird einmal wiederholt (keine Lücke) und
 *    in `transcription_runs.invalidReplies` gezählt.
 *  - Der abgelöste Text bleibt in `transcript_history_parts`.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27999/neu_check?directConnection=true" \
 *     npx tsx scripts/check-neu-transkription.mts
 *
 * Die Datenbank wird geleert: nie gegen Produktion ausführen.
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

const uri = process.env.TEST_MONGODB_URI;
if (!uri || /mongodb\+srv|mongodb\.net/.test(uri)) {
  console.error("TEST_MONGODB_URI fehlt oder zeigt nicht auf eine lokale Wegwerf-Datenbank.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "neu-check-"));
const wav = join(dir, "ok.wav");
// 90 s Ton in Stössen (wie Sprache mit Pausen): zwei Abschnitte, ausrichtbar.
execFileSync("ffmpeg", [
  "-loglevel", "error", "-f", "lavfi",
  "-i", "aevalsrc=0.6*sin(220*2*PI*t)*gt(mod(t\\,1.5)\\,0.5):s=16000:d=90", "-ac", "1", wav,
]);
const wavBytes = readFileSync(wav);

const requests: { model: string; prompt: string; thinking: unknown; schema: boolean; at: number }[] = [];
const server = createServer((req, res) => {
  if (req.url?.startsWith("/audio/")) {
    res.writeHead(200, { "content-type": "audio/wav" });
    return void res.end(wavBytes);
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push({
      model: parsed.model,
      prompt: parsed.contents[0].parts[0].text,
      thinking: parsed.generationConfig?.thinkingConfig,
      schema: !!parsed.generationConfig?.responseSchema,
      at: Date.now(),
    });
    // Die erste Antwort ist abgeschnittenes JSON: Der Abschnitt muss einmal wiederholt werden.
    const invalid = requests.length === 1;
    const transcript = {
      speakers: [{ id: "S1", label: "Sprecher 1" }, { id: "S2", label: "Sprecher 2" }],
      segments: [
        { speaker: "S1", sentences: [{ text: "Grüezi, hier ist Immotrust.", startMs: 500, endMs: 2000 }] },
        { speaker: "S2", sentences: [{ text: "Guten Tag.", startMs: 3000, endMs: 4000 }] },
      ],
    };
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text: invalid ? JSON.stringify(transcript).slice(0, 60) : JSON.stringify(transcript),
          response: {
            usageMetadata: {
              promptTokenCount: 2400,
              candidatesTokenCount: 800,
              promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1500 }, { modality: "TEXT", tokenCount: 900 }],
            },
            modelVersion: parsed.model,
          },
        }),
      );
    }, 1500);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const client = await new MongoClient(uri).connect();
const db = client.db();
for (const name of ["jobs", "recordings", "transcript_parts", "transcript_history_parts", "transcript_index", "transcriber_workers", "transcriber_limiter", "settings", "transcription_runs"]) {
  await db.collection(name).deleteMany({});
}
type Doc = { _id: string; [field: string]: unknown };
const now = Date.now();
const oldSegments = [
  { speaker: "S1", speakerLabel: "Sprecher 1", startMs: 0, endMs: 3000, sentences: [{ text: "Alter Text.", startMs: 0, endMs: 3000, words: [{ text: "Alter", startMs: 0, endMs: 1500 }, { text: "Text.", startMs: 1500, endMs: 3000 }] }] },
];
const completed = (id: string) => ({
  _id: id, audioUrl: `${base}/audio/ok.wav`, mimeType: "audio/wav", durationMs: 90_000,
  transcriptionStatus: "abgeschlossen", transcriptionFinishedAt: "2026-10-01T10:00:00.000Z",
  callerFirstName: "Valerio", callerLastName: "Labruzzo (IT)",
});
await db.collection<Doc>("recordings").insertMany([
  completed("rec_neu_transkribieren"),
  completed("rec_neu_ausrichten"),
  { _id: "rec_upload", audioUrl: `${base}/audio/ok.wav`, mimeType: "audio/wav", durationMs: 90_000, transcriptionStatus: "wartend", callerFirstName: "Samir", callerLastName: "Weber" },
]);
for (const id of ["rec_neu_transkribieren", "rec_neu_ausrichten"]) {
  await db.collection<Doc>("transcript_parts").insertOne({ _id: `${id}:0`, recordingId: id, partIndex: 0, partCount: 1, segments: oldSegments });
}
const background = { status: "wartend", background: true, attempts: 0, lockedAt: null, nextAttemptAt: null, type: "transkription" };
await db.collection<Doc>("jobs").insertMany([
  // Ältere Neu-Transkriptionen: ohne Vorrang würden sie vor dem Upload drankommen.
  { _id: "rec_neu_transkribieren", recordingId: "rec_neu_transkribieren", ...background, kind: "transkription", model: "gemini-3.5-flash-lite", createdAt: new Date(now - 60_000).toISOString() },
  { _id: "rec_neu_ausrichten", recordingId: "rec_neu_ausrichten", ...background, kind: "neu_ausrichten", model: null, createdAt: new Date(now - 50_000).toISOString() },
  { _id: "rec_upload", recordingId: "rec_upload", status: "wartend", attempts: 0, lockedAt: null, nextAttemptAt: null, type: "transkription", createdAt: new Date(now).toISOString() },
]);
// Ein Platz je Instanz: Neu-Transkriptionen dürfen dann laufen, aber erst nach dem Upload.
await db.collection<Doc>("transcriber_limiter").insertOne({
  _id: "gemini", leases: [], recent: [], controlVersion: 0,
  settings: { maxConcurrent: 2, minGapMs: 0, jobsPerInstance: 1, updatedAt: new Date().toISOString(), updatedBy: "test" },
});

const child = spawn(process.execPath, ["--import", "tsx", "worker.ts"], {
  cwd: join(import.meta.dirname, "..", "transcriber"),
  env: { ...process.env, MONGODB_URI: uri, CLAWCORP_API_KEY: "test", TRANSCRIBER_GEMINI_URL: `${base}/gemini`, TRANSCRIBER_GEMINI_GAP_MS: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (d) => process.stdout.write(`[dienst] ${d}`));
child.stderr?.on("data", (d) => process.stdout.write(`[dienst] ${d}`));

const errors: string[] = [];
const recordings = db.collection<Doc>("recordings");
const jobs = db.collection<Doc>("jobs");
const deadline = Date.now() + 3 * 60 * 1000;
const startOrder: string[] = [];
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const job of await jobs.find({ status: { $ne: "wartend" } }).toArray()) {
    if (!startOrder.includes(job._id)) startOrder.push(job._id);
  }
  const running = await recordings.findOne({ _id: "rec_neu_transkribieren" });
  if (running?.transcriptionStatus !== "abgeschlossen") {
    errors.push(`Während der Neu-Transkription stand die Aufnahme auf ${running?.transcriptionStatus}.`);
    break;
  }
  const open = await jobs.countDocuments({ status: { $in: ["wartend", "in_arbeit"] } });
  if (open === 0) break;
}
child.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 1500));
server.close();

const byId = new Map((await jobs.find({}).toArray()).map((job) => [job._id, job]));
for (const [id, job] of byId) if (job.status !== "abgeschlossen") errors.push(`${id}: ${job.status} – ${job.lastError}`);
if (startOrder[0] !== "rec_upload") errors.push(`Zuerst übernommen: ${startOrder.join(", ")} (erwartet rec_upload).`);

const redone = await recordings.findOne({ _id: "rec_neu_transkribieren" });
const meta = redone?.transcript as { model?: string; timing?: string; usage?: { audioInput: number; output: number }; costUsd?: number } | undefined;
if (meta?.model !== "gemini-3.5-flash-lite") errors.push(`Modell im Transkript: ${meta?.model}`);
if (meta?.timing !== "schaetzung") errors.push(`Zeitstempel-Methode: ${meta?.timing}`);
if (!meta?.usage || meta.usage.audioInput !== 3000 || meta.usage.output !== 1600) errors.push(`Tokens: ${JSON.stringify(meta?.usage)}`);
if (!meta?.costUsd || meta.costUsd <= 0) errors.push(`Kosten: ${meta?.costUsd}`);
const history = redone?.transcriptHistory as { model: string; backfilled?: boolean }[] | undefined;
if (history?.length !== 1 || history[0].model !== "gemini-2.5-flash" || !history[0].backfilled) {
  errors.push(`Historie: ${JSON.stringify(history)}`);
}
const parts = await db.collection<Doc>("transcript_parts").findOne({ recordingId: "rec_neu_transkribieren" });
if (JSON.stringify(parts?.segments).includes("Alter Text")) errors.push("Das neue Transkript wurde nicht gespeichert.");

const lite = requests.filter((request) => request.model === "gemini-3.5-flash-lite");
if (lite.length !== 5) errors.push(`${lite.length} Anfragen mit gemini-3.5-flash-lite statt 5 (4 Abschnitte, 1 Wiederholung).`);
if (!requests.every((request) => request.schema)) errors.push("responseSchema fehlt in der Anfrage.");
if (lite.some((request) => (request.thinking as { thinkingLevel?: string })?.thinkingLevel !== "minimal")) errors.push("Denken nicht auf minimal.");
if (!requests.every((request) => request.prompt.includes("Immotrust AG") && request.prompt.includes("Valerio Labruzzo"))) {
  errors.push("Vokabular fehlt im Prompt.");
}
if (requests.some((request) => request.model === "gemini-2.5-flash")) errors.push("Anfrage mit dem abgelösten gemini-2.5-flash.");
if (requests.length !== 5) errors.push(`${requests.length} Anfragen statt 5 (Neu-Ausrichten fragt nie an).`);
const uploaded = await recordings.findOne({ _id: "rec_upload" });
if ((uploaded?.transcript as { model?: string } | undefined)?.model !== "gemini-3.5-flash-lite") {
  errors.push(`Upload mit ${(uploaded?.transcript as { model?: string } | undefined)?.model} statt dem Standard gemini-3.5-flash-lite.`);
}
if (uploaded?.transcriptionGaps) errors.push("Ungültige Antwort wurde als Lücke gespeichert.");
const archived = await db.collection<Doc>("transcript_history_parts").find({ recordingId: "rec_neu_transkribieren" }).toArray();
if (archived.length !== 1 || !JSON.stringify(archived[0].segments).includes("Alter Text.")) {
  errors.push(`Abgelöster Text nicht aufbewahrt (${archived.length} Teile).`);
}

const retimed = await recordings.findOne({ _id: "rec_neu_ausrichten" });
if (!(retimed?.transcript as { retimedAt?: string } | undefined)?.retimedAt) errors.push("Neu-Ausrichtung ohne retimedAt.");
if (retimed?.transcriptionStatus !== "abgeschlossen") errors.push(`Neu-Ausrichtung: Status ${retimed?.transcriptionStatus}`);

const runs = await db.collection<Doc>("transcription_runs").find({}).toArray();
if (runs.length !== 2) errors.push(`${runs.length} Läufe in transcription_runs statt 2.`);
const invalidCount = runs.reduce((sum, run) => sum + ((run.invalidReplies as number | undefined) ?? 0), 0);
if (invalidCount !== 1) errors.push(`${invalidCount} ungültige Antworten gezählt statt 1.`);

const worker = await db.collection<Doc>("transcriber_workers").findOne({});
if (!(worker?.features as string[] | undefined)?.includes("nachrangig")) errors.push("Dienst meldet seine Fähigkeiten nicht.");

console.log(`Reihenfolge: ${startOrder.join(" → ")}; Anfragen: ${requests.map((request) => request.model).join(", ")}`);
await client.close();
if (errors.length > 0) {
  console.error("FEHL:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("OK");
process.exit(0);
