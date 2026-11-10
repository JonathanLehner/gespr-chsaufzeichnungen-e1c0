/**
 * Ende-zu-Ende-Prüfung des Transkriptionsdienstes gegen eine Wegwerf-Datenbank
 * und einen nachgebildeten Transkriptionsdienst:
 *  - Störungen (504, Kostenlimit-502) beenden keinen Auftrag; er bleibt
 *    „wartend“ mit nächstem Versuch und wird ohne Lücke abgeschlossen.
 *  - Fehlende und nicht dekodierbare Audiodateien enden endgültig mit einer
 *    Meldung, die die Ursache nennt.
 *  - Ein nach altem Verfahren endgültig beendeter Auftrag kommt zurück.
 *  - Zwei Dienst-Instanzen (wie Staging und Produktion) halten zusammen die
 *    Grenze von zwei gleichzeitigen Anfragen und den Mindestabstand ein, und
 *    nach einer Störung ruht die Spur mindestens 30 s.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27999/retry_check?directConnection=true" \
 *     npx tsx scripts/check-transcriber-retry.mts
 *
 * Dauer rund vier Minuten (die erste Wiederholung ist nach etwa zwei Minuten
 * fällig). Die Datenbank wird geleert: nie gegen Produktion ausführen.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

const uri = process.env.TEST_MONGODB_URI;
if (!uri) {
  console.error("TEST_MONGODB_URI fehlt (Wegwerf-Datenbank, nie die Produktionsdatenbank).");
  process.exit(1);
}

const GAP_MS = 1500;
const dir = mkdtempSync(join(tmpdir(), "retry-check-"));
const wav = join(dir, "ok.wav");
// Drei Minuten Ton: drei Abschnitte je Aufnahme.
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=180", "-ar", "8000", "-ac", "1", wav]);
const wavBytes = readFileSync(wav);

/* -------------------------------------------- nachgebildeter Dienst und Dateiablage */

const starts: number[] = [];
let inFlight = 0;
let maxInFlight = 0;
let served = 0;
/** Die ersten Anfragen scheitern: 504, dann das Kostenlimit als 502. */
const FAILURES = [
  { status: 504, body: { error: "Gateway Timeout" } },
  { status: 502, body: { error: "Your project has exceeded its monthly spending limit (billing account)" } },
  { status: 504, body: { error: "Gateway Timeout" } },
];
const failureTimes: number[] = [];

const server = createServer((req, res) => {
  if (req.url?.startsWith("/audio/")) {
    const name = req.url.slice("/audio/".length);
    if (name === "ok.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return void res.end(wavBytes);
    }
    if (name === "kaputt.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return void res.end(Buffer.from("das ist keine audiodatei ".repeat(400)));
    }
    res.writeHead(404);
    return void res.end("Datei nicht gefunden.");
  }
  // POST /gemini
  req.resume();
  req.on("end", () => {
    const n = served++;
    starts.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      const failure = FAILURES[n];
      if (failure) {
        failureTimes.push(Date.now());
        res.writeHead(failure.status, { "content-type": "application/json" });
        return void res.end(JSON.stringify(failure.body));
      }
      const transcript = {
        speakers: [{ id: "S1", label: "Sprecher 1" }],
        segments: [{ speaker: "S1", sentences: [{ text: "Guten Tag, hier spricht der Test.", startMs: 1000, endMs: 4000 }] }],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: JSON.stringify(transcript) }));
    }, 400 + Math.random() * 600);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

/* -------------------------------------------- Testdaten */

const client = await new MongoClient(uri).connect();
const db = client.db();
for (const name of ["jobs", "recordings", "transcript_parts", "transcript_index", "transcriber_workers", "transcriber_limiter"]) {
  await db.collection(name).deleteMany({});
}
const now = Date.now();
const fixtures = [
  { id: "rec_ok1", file: "ok.wav" },
  { id: "rec_ok2", file: "ok.wav" },
  { id: "rec_alt", file: "ok.wav", legacy: true },
  { id: "rec_fehlt", file: "fehlt.wav" },
  { id: "rec_kaputt", file: "kaputt.wav" },
];
for (const [index, f] of fixtures.entries()) {
  const createdAt = new Date(now - (fixtures.length - index) * 1000).toISOString();
  await db.collection<{ _id: string; [field: string]: unknown }>("recordings").insertOne({
    _id: f.id,
    audioUrl: `${base}/audio/${f.file}`,
    mimeType: "audio/wav",
    durationMs: 180_000,
    transcriptionStatus: f.legacy ? "fehlgeschlagen" : "wartend",
  });
  await db.collection<{ _id: string; [field: string]: unknown }>("jobs").insertOne({
    _id: f.id,
    recordingId: f.id,
    type: "transkription",
    createdAt,
    lockedAt: null,
    ...(f.legacy
      ? { status: "fehlgeschlagen", attempts: 3, nextAttemptAt: null, lastError: "/gemini: Zeitüberschreitung nach 120 s." }
      : { status: "wartend", attempts: 0, nextAttemptAt: null, lastError: null }),
  });
}

/* -------------------------------------------- zwei Instanzen starten */

const workers: ChildProcess[] = [];
for (const name of ["staging", "produktion"]) {
  const child = spawn(process.execPath, ["--import", "tsx", "worker.ts"], {
    cwd: join(import.meta.dirname, "..", "transcriber"),
    env: {
      ...process.env,
      MONGODB_URI: uri,
      CLAWCORP_API_KEY: "test",
      TRANSCRIBER_GEMINI_URL: `${base}/gemini`,
      TRANSCRIBER_GEMINI_GAP_MS: String(GAP_MS),
      TRANSCRIBER_GEMINI_CONCURRENCY: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  workers.push(child);
}

type Job = { _id: string; status: string; nextAttemptAt?: string | null; lastError?: string | null; attempts?: number; permanent?: boolean };
const jobs = db.collection<Job>("jobs");
let sawWaitingWithRetry = false;
const deadline = Date.now() + 8 * 60 * 1000;
let final: Job[] = [];
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  final = await jobs.find({}).toArray();
  if (final.some((job) => job.status === "wartend" && job.nextAttemptAt && job.lastError && job._id.startsWith("rec_ok"))) {
    sawWaitingWithRetry = true;
  }
  if (final.every((job) => job.status === "abgeschlossen" || job.status === "fehlgeschlagen")) break;
}

for (const child of workers) child.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 1500));
server.close();

/* -------------------------------------------- Auswertung */

const errors: string[] = [];
const byId = new Map(final.map((job) => [job._id, job]));
const recordings = new Map(
  (await db.collection<{ _id: string; transcriptionStatus: string; transcriptionGaps?: unknown; transcriptionError?: string }>("recordings").find({}).toArray()).map((r) => [r._id, r]),
);
for (const id of ["rec_ok1", "rec_ok2", "rec_alt"]) {
  const job = byId.get(id);
  if (job?.status !== "abgeschlossen") errors.push(`${id}: Status ${job?.status} statt abgeschlossen`);
  if (recordings.get(id)?.transcriptionGaps) errors.push(`${id}: Transkript mit Lücke gespeichert`);
}
if (!sawWaitingWithRetry) errors.push("Kein Auftrag wurde nach einer Störung als wartend mit nächstem Versuch geführt.");
const missing = byId.get("rec_fehlt");
if (missing?.status !== "fehlgeschlagen" || !missing.permanent || !/nicht mehr vorhanden \(HTTP 404\)/.test(missing.lastError ?? "")) {
  errors.push(`rec_fehlt: ${missing?.status} – ${missing?.lastError}`);
}
const broken = byId.get("rec_kaputt");
if (broken?.status !== "fehlgeschlagen" || !broken.permanent || !/lässt sich nicht dekodieren/.test(broken.lastError ?? "")) {
  errors.push(`rec_kaputt: ${broken?.status} – ${broken?.lastError}`);
}
if (maxInFlight > 2) errors.push(`Gleichzeitig ${maxInFlight} Anfragen, erlaubt sind 2.`);
const sorted = [...starts].sort((a, b) => a - b);
const gaps = sorted.slice(1).map((at, i) => at - sorted[i]);
const minGap = Math.min(...gaps);
if (minGap < GAP_MS - 150) errors.push(`Kleinster Abstand zwischen zwei Anfragen ${minGap} ms, verlangt ${GAP_MS} ms.`);
const firstFailure = failureTimes[0];
const afterFirst = sorted.find((at) => at > firstFailure);
if (firstFailure && afterFirst && afterFirst - firstFailure < 29_000) {
  errors.push(`Nach der ersten Störung kam die nächste Anfrage schon nach ${afterFirst - firstFailure} ms.`);
}

console.log(
  `Anfragen ${served}, höchstens ${maxInFlight} gleichzeitig, kleinster Abstand ${minGap} ms, ` +
    `Pause nach erster Störung ${afterFirst && firstFailure ? afterFirst - firstFailure : "–"} ms`,
);
for (const job of final) console.log(`  ${job._id}: ${job.status}, ${job.attempts} Versuche, ${job.lastError ?? "–"}`);
await client.close();
if (errors.length > 0) {
  console.error("FEHL:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("OK");
process.exit(0);
