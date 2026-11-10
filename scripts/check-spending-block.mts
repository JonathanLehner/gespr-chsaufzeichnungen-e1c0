/**
 * Prüft Sperre, Pause und Steuerung des Transkriptionsdienstes gegen eine
 * Wegwerf-Datenbank und einen nachgebildeten Transkriptionsdienst, mit zwei
 * Instanzen (wie Staging und Produktion):
 *  1. Das Kostenlimit („monthly spending limit“, 502) setzt die Sperre; danach
 *     geht keine Anfrage mehr hinaus, die Aufträge bleiben „wartend“ ohne
 *     gezählten Versuch und ohne geplanten nächsten Versuch.
 *  2. Die Freigabe (wie „Sperre aufheben“ im Dashboard) setzt die Arbeit fort.
 *  3. Der Monatswechsel (Sperre mit kurzem Ende) hebt die Sperre ohne Admin auf.
 *  4. Admin-Pause hält die Warteschlange an; „Nach vorne“ wird zuerst bearbeitet;
 *     gespeicherte Grenzen (1 gleichzeitig) gelten ohne Neustart.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27999/block_check?directConnection=true" \
 *     npx tsx scripts/check-spending-block.mts
 *
 * Dauer rund zwei Minuten. Die Datenbank wird geleert: nie gegen Produktion ausführen.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { spendingBlockUntil } from "../transcriber/shared/queue";

const uri = process.env.TEST_MONGODB_URI;
if (!uri) {
  console.error("TEST_MONGODB_URI fehlt (Wegwerf-Datenbank, nie die Produktionsdatenbank).");
  process.exit(1);
}

const errors: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "  ok  " : "  FEHL"} ${message}`);
  if (!ok) errors.push(message);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------- Monatsende (rein rechnerisch) */

check(spendingBlockUntil(Date.parse("2026-11-10T12:00:00Z")) === "2026-11-30T23:00:00.000Z", "Sperre bis 01.12. 00:00 Zürich");
check(spendingBlockUntil(Date.parse("2026-03-15T08:00:00Z")) === "2026-03-31T22:00:00.000Z", "Sperre bis 01.04. 00:00 Zürich (Sommerzeit)");
check(
  spendingBlockUntil(Date.parse("2026-12-01T05:00:00Z")) === "2026-12-01T06:00:00.000Z",
  "Am Monatsersten nur eine Stunde Sperre",
);

/* -------------------------------------------- nachgebildeter Dienst und Dateiablage */

const dir = mkdtempSync(join(tmpdir(), "block-check-"));
const wav = join(dir, "ok.wav");
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=110", "-ar", "8000", "-ac", "1", wav]);
const wavBytes = readFileSync(wav);

const requests: number[] = [];
let inFlight = 0;
let maxInFlight = 0;
/** Nächste Antwort ist das Kostenlimit. */
let spendNext = false;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/audio/")) {
    res.writeHead(200, { "content-type": "audio/wav" });
    return void res.end(wavBytes);
  }
  req.resume();
  req.on("end", () => {
    requests.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const spend = spendNext;
    spendNext = false;
    setTimeout(() => {
      inFlight -= 1;
      if (spend) {
        res.writeHead(502, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify({ error: "Your billing account has exceeded its monthly spending limit" }),
        );
      }
      const transcript = {
        speakers: [{ id: "S1", label: "Sprecher 1" }],
        segments: [{ speaker: "S1", sentences: [{ text: "Guten Tag, hier spricht der Test.", startMs: 1000, endMs: 4000 }] }],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: JSON.stringify(transcript) }));
    }, 300);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/* -------------------------------------------- Testdaten */

type Doc = { _id: string; [field: string]: unknown };
const client = await new MongoClient(uri).connect();
const db = client.db();
for (const name of ["jobs", "recordings", "transcript_parts", "transcript_index", "transcriber_workers", "transcriber_limiter"]) {
  await db.collection(name).deleteMany({});
}
const jobs = db.collection<Doc>("jobs");
const recordings = db.collection<Doc>("recordings");
const limiter = db.collection<Doc>("transcriber_limiter");

let seq = 0;
async function addRecording(id: string) {
  seq += 1;
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  await recordings.insertOne({ _id: id, audioUrl: `${base}/audio/ok.wav`, mimeType: "audio/wav", durationMs: 110_000, transcriptionStatus: "wartend" });
  await jobs.insertOne({ _id: id, recordingId: id, type: "transkription", status: "wartend", attempts: 0, createdAt, lockedAt: null, nextAttemptAt: null, lastError: null });
}

/** Wie die Aktionen des Dashboards (`src/lib/transcription.ts`). */
const control = (update: Record<string, unknown>) =>
  limiter.updateOne(
    { _id: "gemini" },
    { ...update, $inc: { controlVersion: 1 } } as unknown as Parameters<typeof limiter.updateOne>[1],
    { upsert: true },
  );

async function waitFor(what: string, test: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(500);
  }
  console.log(`  (Zeitlimit beim Warten auf: ${what})`);
  return false;
}
const allDone = (ids: string[]) => async () =>
  (await jobs.countDocuments({ _id: { $in: ids }, status: "abgeschlossen" })) === ids.length;

/* -------------------------------------------- zwei Instanzen */

const workers: ChildProcess[] = [];
for (const name of ["staging", "produktion"]) {
  const child = spawn(process.execPath, ["--import", "tsx", "worker.ts"], {
    cwd: join(import.meta.dirname, "..", "transcriber"),
    env: {
      ...process.env,
      MONGODB_URI: uri,
      CLAWCORP_API_KEY: "test",
      TRANSCRIBER_GEMINI_URL: `${base}/gemini`,
      TRANSCRIBER_GEMINI_GAP_MS: "300",
      TRANSCRIBER_GEMINI_CONCURRENCY: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  workers.push(child);
}

try {
  /* 1. Kostenlimit sperrt alles */
  console.log("\n1. Kostenlimit");
  spendNext = true;
  for (const id of ["a1", "a2", "a3", "a4"]) await addRecording(id);
  const blocked = await waitFor("Sperre", async () => !!(await limiter.findOne({ _id: "gemini" }))?.spendingBlock, 20_000);
  check(blocked, "Sperre gesetzt");
  const block = (await limiter.findOne({ _id: "gemini" }))?.spendingBlock as { until: string; reason: string } | undefined;
  check(block?.until === spendingBlockUntil(Date.now()), `Ende der Sperre ${block?.until}`);
  check(/spending limit/.test(block?.reason ?? ""), "Grund gespeichert");
  // Laufende Anfragen dürfen noch zurückkommen; danach darf keine neue mehr starten.
  await sleep(1500);
  const countAtBlock = requests.length;
  await sleep(8000);
  check(requests.length === countAtBlock, `Keine Anfrage während der Sperre (${requests.length - countAtBlock} neu)`);
  const waiting = await jobs.find({ _id: { $in: ["a1", "a2", "a3", "a4"] } }).toArray();
  check(
    waiting.every((job) => job.status === "wartend" || job.status === "abgeschlossen"),
    `Aufträge wartend: ${waiting.map((j) => `${j._id}=${j.status}`).join(", ")}`,
  );
  check(
    waiting.filter((job) => job.status === "wartend").every((job) => (job.attempts ?? 0) === 0 && !job.nextAttemptAt && !job.lockId),
    "Kein Versuch gezählt, kein geplanter Versuch, keine Sperre am Auftrag",
  );
  const mirrored = await recordings.find({ _id: { $in: ["a1", "a2", "a3", "a4"] } }).toArray();
  check(
    mirrored.every((r) => r.transcriptionStatus !== "in_arbeit" && !r.transcriptionNextAttemptAt),
    "Aufnahmen zeigen wartend ohne nächsten Versuch",
  );
  const errorsLogged = ((await limiter.findOne({ _id: "gemini" }))?.errors as { recordingId: string }[] | undefined) ?? [];
  check(errorsLogged.some((entry) => entry.recordingId?.startsWith("a")), "Fehler mit Aufnahme protokolliert");

  /* 2. Freigabe */
  console.log("\n2. Freigabe durch den Admin");
  await control({ $set: { spendingBlock: null } });
  check(await waitFor("Abschluss nach Freigabe", allDone(["a1", "a2", "a3", "a4"]), 60_000), "Alle Aufträge nach Freigabe abgeschlossen");
  const done = await jobs.find({ _id: { $in: ["a1", "a2", "a3", "a4"] } }).toArray();
  check(done.every((job) => job.attempts === 1), `Je ein Versuch: ${done.map((j) => j.attempts).join(", ")}`);

  /* 3. Monatswechsel */
  console.log("\n3. Monatswechsel");
  const until = new Date(Date.now() + 6000).toISOString();
  await control({ $set: { spendingBlock: { startedAt: new Date().toISOString(), until, reason: "Test", recordingId: null, workerId: null } } });
  await sleep(1000);
  const beforeRoll = requests.length;
  await addRecording("b1");
  await sleep(4000);
  check(requests.length === beforeRoll, "Keine Anfrage vor dem Monatswechsel");
  check(await waitFor("Abschluss nach Monatswechsel", allDone(["b1"]), 60_000), "Auftrag nach Monatswechsel ohne Admin abgeschlossen");
  check(requests.filter((at) => at < Date.parse(until)).length === beforeRoll, "Erste Anfrage erst nach dem Ende der Sperre");
  check(((await limiter.findOne({ _id: "gemini" }))?.spendingBlock ?? null) === null, "Abgelaufene Sperre entfernt");

  /* 4. Pause, Nach vorne, Grenzen */
  console.log("\n4. Pause, Nach vorne, Grenzen");
  await control({
    $set: {
      manualPause: { at: new Date().toISOString(), by: "test" },
      settings: { maxConcurrent: 1, minGapMs: 200, jobsPerInstance: 1, updatedAt: new Date().toISOString(), updatedBy: "test" },
    },
  });
  await sleep(1500);
  const beforePause = requests.length;
  for (const id of ["c1", "c2", "c3"]) await addRecording(id);
  await jobs.updateOne({ _id: "c2" }, { $set: { priority: Date.now() } });
  await sleep(5000);
  check(requests.length === beforePause, "Keine Anfrage während der Pause");
  check((await jobs.countDocuments({ _id: { $in: ["c1", "c2", "c3"] }, status: "wartend" })) === 3, "Aufträge bleiben wartend");
  maxInFlight = 0;
  await control({ $set: { manualPause: null } });
  check(await waitFor("Abschluss nach Fortsetzen", allDone(["c1", "c2", "c3"]), 90_000), "Alle Aufträge nach Fortsetzen abgeschlossen");
  const order = (await jobs.find({ _id: { $in: ["c1", "c2", "c3"] } }).toArray()).sort((a, b) =>
    String(a.startedAt).localeCompare(String(b.startedAt)),
  );
  // Zwei Instanzen übernehmen gleichzeitig; ohne Vorrang nähmen sie c1 (älteste) und c3 (neueste).
  check(order.findIndex((j) => j._id === "c2") < 2, `„Nach vorne“ unter den ersten (${order.map((j) => j._id).join(", ")})`);
  check(maxInFlight === 1, `Gespeicherte Grenze gilt: höchstens ${maxInFlight} gleichzeitig`);
} finally {
  for (const child of workers) child.kill("SIGTERM");
  await sleep(1500);
  server.close();
  await client.close();
}

if (errors.length > 0) {
  console.error("\nFEHL:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("\nOK");
process.exit(0);
