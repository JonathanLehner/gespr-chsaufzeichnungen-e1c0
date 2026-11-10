/**
 * Transkriptionsdienst: arbeitet die Warteschlange `jobs` dauerhaft ab.
 *
 * Läuft als ständiger Dienst neben der Anwendung (siehe `clawcorp.json`). Die
 * Anwendung legt beim Upload nur den Auftrag an; die eigentliche Arbeit dauert
 * bei langen Gesprächen Minuten und hängt an keiner Web-Anfrage.
 *
 * Ablauf:
 *  - `TRANSCRIBER_CONCURRENCY` Plätze (Standard 2) übernehmen je einen Auftrag
 *    atomar per `findOneAndUpdate` (wartend, fällige Wiederholung oder
 *    verwaiste Sperre → `in_arbeit` mit `lockedAt`, `lockId`, `workerId`). Ein
 *    Auftrag gehört damit genau einem Platz, auch wenn Staging und Produktion
 *    gleichzeitig auf dieselbe Datenbank zugreifen.
 *  - Reihenfolge: Jeder Platz wechselt bei jeder Übernahme zwischen dem
 *    neuesten und dem ältesten fälligen Auftrag. Ein neuer Upload wartet so
 *    höchstens, bis der nächste Platz frei wird, statt hinter Hunderten
 *    Aufträgen eines Massen-Uploads; der Rückstand läuft trotzdem weiter ab.
 *  - Während ein Auftrag läuft, wird alle 30 s `lockedAt` erneuert. Fehlt das
 *    Lebenszeichen länger als drei Minuten, übernimmt ein anderer Platz den
 *    Auftrag an der gespeicherten Stelle (`progress`).
 *  - Ohne offene Arbeit wartet ein Platz auf eine Änderung an `jobs`
 *    (Change Stream) oder bis zur nächsten bekannten Fälligkeit
 *    (Wiederholung, ablaufende Sperre) und fragt erst dann wieder.
 *  - SIGTERM: laufende Anfragen werden abgebrochen, der Zwischenstand
 *    gespeichert und der Auftrag als `wartend` freigegeben.
 *  - Jeder Dienst schreibt sein Lebenszeichen nach `transcriber_workers`
 *    (Anzeige im Admin-Dashboard).
 *
 * Die Audiodatei wird über ihre Adresse geholt (`/api/dateien/<schlüssel>` der
 * Anwendung, die aus dem R2-Bucket liefert) und mit ffmpeg in Abschnitte von
 * einer Minute geteilt, die als Opus mit 16 kbit/s direkt in der Anfrage
 * mitgehen (rund 160 KB je Abschnitt, Grenze des Endpunkts 200 KB).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MongoClient, type ChangeStream, type Collection } from "mongodb";
import { alignTranscript } from "./shared/forced-alignment";
import {
  HEARTBEAT_MS,
  MAX_ATTEMPTS,
  STALE_LOCK_MS,
  WORKERS_COLLECTION,
  claimableFilter,
  iso,
  nextAttemptAfter,
} from "./shared/queue";
import {
  PROMPT,
  buildTranscriptIndex,
  chunkPrompt,
  mergeChunks,
  normalizeTranscript,
  parseJsonLoosely,
  shiftSegments,
  splitIntoParts,
  type NormalizedTranscript,
} from "./shared/transcript";
import type { AudioMime, TranscriptSegment } from "./shared/types";

const run = promisify(execFile);

const GEMINI_URL = "https://www.clawcorp.ai/api/platform/gemini";
const MODEL = "gemini-2.5-flash";
/** Wird ein Auftrag so oft verwaist vorgefunden, gilt er als fehlgeschlagen. */
const MAX_STALE_CLAIMS = 2;
const CHUNK_MS = 60 * 1000;
const CHUNK_CONCURRENCY = 2;
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_PAUSE_MS = 2000;
const GEMINI_TIMEOUT_MS = 120 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;
const BITRATES = ["16k", "14k", "12k"];
/** Base64-Länge, ab der ein Abschnitt mit geringerer Bitrate neu kodiert wird. */
const MAX_INLINE_CHARS = 180 * 1024;
/** Längste Ruhepause ohne Änderung an `jobs`, als Absicherung des Change Streams. */
const IDLE_MAX_MS = 5 * 60 * 1000;
/** Ruhepause, wenn kein Change Stream verfügbar ist (Einzelserver ohne Replikation). */
const IDLE_FALLBACK_MS = 30 * 1000;
const ERROR_PAUSE_MS = 10 * 1000;
/** Docker beendet nach 10 s hart; bis dahin muss der Zwischenstand gesichert sein. */
const SHUTDOWN_GRACE_MS = 8 * 1000;

type Progress = {
  chunkCount: number;
  chunks: (NormalizedTranscript | null)[];
  /** Abschnitte, auf die der Dienst auch nach allen Anläufen nicht antwortete. */
  failed: number[];
};

type JobDoc = {
  _id: string;
  recordingId: string;
  status: string;
  attempts?: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lockedAt?: string | null;
  lockId?: string | null;
  workerId?: string | null;
  nextAttemptAt?: string | null;
  progress?: Progress | null;
  /** Beim Beenden eines Dienstes freigegeben; wird an derselben Stelle fortgesetzt. */
  paused?: boolean | null;
  staleClaims?: number;
};

type RecordingDoc = {
  _id: string;
  audioUrl: string;
  mimeType: string;
  durationMs: number | null;
};

type WorkerDoc = {
  _id: string;
  host: string;
  concurrency: number;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  activeJobs: string[];
  processed: number;
  failed: number;
};

type Db = {
  jobs: Collection<JobDoc>;
  recordings: Collection<RecordingDoc>;
  parts: Collection<{ _id: string }>;
  index: Collection<{ _id: string }>;
  workers: Collection<WorkerDoc>;
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  return value;
}

function concurrency(): number {
  const value = Number.parseInt(process.env.TRANSCRIBER_CONCURRENCY ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 8) : 2;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (message: string) => console.log(`[transkription] ${message}`);

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

/* --------------------------------------------------------------- Beenden und Wecken */

let stopping = false;
const shutdown = new AbortController();

/** Weckt wartende Plätze bei einer Änderung an `jobs` oder beim Beenden. */
const wake = (() => {
  let waiters: (() => void)[] = [];
  return {
    notify() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          waiters = waiters.filter((waiter) => waiter !== done);
          resolve();
        }
        waiters.push(done);
      });
    },
  };
})();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    log(`${signal} erhalten, laufende Aufträge werden freigegeben.`);
    stopping = true;
    shutdown.abort();
    wake.notify();
    setTimeout(() => {
      log("Freigabe dauert zu lange, Dienst wird beendet.");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  });
}

let changeStreamActive = false;

/** Hält einen Change Stream auf `jobs` offen; jede relevante Änderung weckt die Plätze. */
function watchJobs(db: Db): () => Promise<void> {
  let stream: ChangeStream | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    try {
      stream = db.jobs.watch([
        {
          $match: {
            $or: [
              { operationType: { $in: ["insert", "replace"] } },
              { "updateDescription.updatedFields.status": { $in: ["wartend", "fehlgeschlagen"] } },
            ],
          },
        },
      ]);
    } catch (error) {
      log(`Change Stream nicht verfügbar (${errorText(error)}), Ruhepause ${IDLE_FALLBACK_MS / 1000} s.`);
      return;
    }
    changeStreamActive = true;
    stream.on("change", () => wake.notify());
    stream.on("error", (error) => {
      if (changeStreamActive) {
        log(`Change Stream unterbrochen (${errorText(error)}), Ruhepause ${IDLE_FALLBACK_MS / 1000} s.`);
      }
      changeStreamActive = false;
      stream?.close().catch(() => undefined);
      if (!closed) setTimeout(open, IDLE_MAX_MS).unref();
    });
  };
  open();
  return async () => {
    closed = true;
    await stream?.close().catch(() => undefined);
  };
}

/** Zeit bis zur nächsten bekannten Fälligkeit: Wiederholung oder ablaufende Sperre. */
async function msUntilNextDue(db: Db): Promise<number> {
  const limit = changeStreamActive ? IDLE_MAX_MS : IDLE_FALLBACK_MS;
  const [retry, locked] = await Promise.all([
    db.jobs.findOne(
      { status: "fehlgeschlagen", attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $ne: null } },
      { sort: { nextAttemptAt: 1 }, projection: { nextAttemptAt: 1 } },
    ),
    db.jobs.findOne(
      { status: "in_arbeit", lockedAt: { $ne: null } },
      { sort: { lockedAt: 1 }, projection: { lockedAt: 1 } },
    ),
  ]);
  const now = Date.now();
  const candidates = [
    retry?.nextAttemptAt ? Date.parse(retry.nextAttemptAt) : Infinity,
    locked?.lockedAt ? Date.parse(locked.lockedAt) + STALE_LOCK_MS + 1000 : Infinity,
  ];
  return Math.max(1000, Math.min(limit, ...candidates.map((at) => at - now)));
}

/* --------------------------------------------------------------- Übernahme */

/**
 * Übernimmt einen fälligen Auftrag exklusiv: `findOneAndUpdate` prüft Filter
 * und setzt die Sperre in einem Schritt, zwei Plätze können denselben Auftrag
 * also nie gleichzeitig erhalten. Geliefert wird der Stand vor der Übernahme,
 * daran entscheidet sich, ob fortgesetzt oder neu begonnen wird.
 */
async function claimNext(db: Db, lockId: string, newestFirst: boolean): Promise<JobDoc | null> {
  return db.jobs.findOneAndUpdate(
    claimableFilter(),
    { $set: { status: "in_arbeit", lockedAt: iso(), lockId, workerId: WORKER_ID } },
    { sort: { createdAt: newestFirst ? -1 : 1 }, returnDocument: "before" },
  );
}

/* --------------------------------------------------------------- Audio */

async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), signal]) });
  if (!res.ok) throw new Error(`Die Audiodatei konnte nicht gelesen werden (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function probeDurationMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

async function encodeChunk(file: string, startMs: number, bitrate: string): Promise<string> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-loglevel", "error", "-ss", String(startMs / 1000), "-t", String(CHUNK_MS / 1000),
      "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", bitrate,
      "-application", "voip", "-f", "ogg", "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.toString("base64");
}

/* --------------------------------------------------------------- Dienst */

async function requestTranscript(
  prompt: string,
  audioBase64: string,
  signal: AbortSignal,
): Promise<NormalizedTranscript> {
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("CLAWCORP_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        contents: [
          { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/ogg", data: audioBase64 } }] },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
      signal: AbortSignal.any([AbortSignal.timeout(GEMINI_TIMEOUT_MS), signal]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`/gemini: Zeitüberschreitung nach ${GEMINI_TIMEOUT_MS / 1000} s.`);
    }
    throw error;
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* Rohtext verwenden */
    }
    throw new Error(`/gemini fehlgeschlagen (${res.status}): ${message}`);
  }
  return normalizeTranscript(parseJsonLoosely((JSON.parse(text) as { text?: string }).text ?? ""));
}

/* --------------------------------------------------------------- Ablauf */

class LockLost extends Error {}

type Outcome = { label: string; ok: boolean };

async function processJob(db: Db, before: JobDoc, lockId: string): Promise<Outcome> {
  const id = before._id;
  const own = { _id: id, lockId };
  const now = iso();
  const resumed = before.status === "in_arbeit" || !!before.paused;
  const orphaned = before.status === "in_arbeit" && !!before.lockedAt;
  const attempts = resumed ? Math.max(before.attempts ?? 0, 1) : (before.attempts ?? 0) + 1;
  const staleClaims = (before.staleClaims ?? 0) + (orphaned ? 1 : 0);
  let progress: Progress | null = resumed ? (before.progress ?? null) : null;

  const finish = async (status: string, fields: { lastError?: string | null; nextAttemptAt?: string | null } = {}) => {
    const closedAt = iso();
    const lastError = fields.lastError ?? null;
    const nextAttemptAt = fields.nextAttemptAt ?? null;
    const done = await db.jobs.updateOne(own, {
      $set: {
        status, finishedAt: closedAt, nextAttemptAt, lastError,
        lockedAt: null, lockId: null, progress: null, paused: null,
      },
    });
    if (done.matchedCount === 0) throw new LockLost();
    await db.recordings.updateOne(
      { _id: id },
      {
        $set: {
          transcriptionStatus: status,
          transcriptionError: lastError,
          transcriptionFinishedAt: closedAt,
          transcriptionNextAttemptAt: nextAttemptAt,
          transcriptionAttempts: attempts,
        },
      },
    );
  };
  const fail = async (message: string): Promise<Outcome> => {
    await finish("fehlgeschlagen", { lastError: message.slice(0, 400), nextAttemptAt: nextAttemptAfter(attempts) });
    return { label: `fehlgeschlagen: ${message}`, ok: false };
  };
  /** Gibt den Auftrag beim Beenden frei; ein anderer Platz setzt an derselben Stelle fort. */
  const pause = async (): Promise<Outcome> => {
    const released = await db.jobs.updateOne(own, {
      $set: {
        status: "wartend", paused: true, lockedAt: null, lockId: null, workerId: null,
        ...(progress ? { progress } : {}),
      },
    });
    if (released.matchedCount === 0) return { label: "Auftrag wurde zwischenzeitlich zurückgesetzt", ok: false };
    await db.recordings.updateOne({ _id: id }, { $set: { transcriptionStatus: "wartend" } });
    const doneCount = progress?.chunks.filter(Boolean).length ?? 0;
    return { label: `freigegeben bei ${doneCount}/${progress?.chunkCount ?? "?"} Abschnitten`, ok: false };
  };

  const recording = await db.recordings.findOne({ _id: id });
  if (!recording) {
    await db.jobs.updateOne(own, { $set: { attempts: MAX_ATTEMPTS } });
    await finish("fehlgeschlagen", { lastError: "Aufnahme nicht gefunden." });
    return { label: "Aufnahme fehlt", ok: false };
  }
  if (staleClaims > MAX_STALE_CLAIMS) {
    await db.jobs.updateOne(own, { $set: { attempts: MAX_ATTEMPTS, staleClaims } });
    await finish("fehlgeschlagen", { lastError: "Die Transkription wurde wiederholt unterbrochen." });
    return { label: "wiederholt unterbrochen", ok: false };
  }

  await db.jobs.updateOne(own, {
    $set: {
      attempts,
      staleClaims,
      nextAttemptAt: null,
      paused: null,
      startedAt: resumed ? (before.startedAt ?? now) : now,
      ...(resumed ? {} : { progress: null }),
    },
  });
  await db.recordings.updateOne(
    { _id: id },
    {
      $set: {
        transcriptionStatus: "in_arbeit",
        transcriptionError: null,
        transcriptionNextAttemptAt: null,
        transcriptionFinishedAt: null,
        transcriptionAttempts: attempts,
        ...(resumed ? {} : { transcriptionStartedAt: now }),
      },
    },
  );

  // Lebenszeichen des Auftrags. Fehlt die Sperre (zurückgesetzt oder von einem
  // anderen Platz übernommen), wird der Lauf sofort abgebrochen.
  const jobAbort = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, jobAbort.signal]);
  let lost = false;
  const heartbeat = setInterval(() => {
    db.jobs
      .updateOne(own, { $set: { lockedAt: iso() } })
      .then((result) => {
        if (result.matchedCount === 0) {
          lost = true;
          jobAbort.abort();
        }
      })
      .catch((error) => log(`${id}: Lebenszeichen nicht geschrieben (${errorText(error)})`));
  }, HEARTBEAT_MS);
  const interrupted = () => stopping || lost;

  const dir = await mkdtemp(join(tmpdir(), "transkription-"));
  try {
    const bytes = await download(recording.audioUrl, signal);
    const file = join(dir, "audio");
    await writeFile(file, bytes);
    const measuredMs = await probeDurationMs(file);
    const durationMs = measuredMs ?? recording.durationMs ?? CHUNK_MS;
    const chunkCount = Math.max(1, Math.ceil(durationMs / CHUNK_MS));

    const state: Progress =
      progress && progress.chunkCount === chunkCount
        ? progress
        : { chunkCount, chunks: new Array(chunkCount).fill(null), failed: [] };
    progress = state;
    const pending = state.chunks
      .map((chunk, index) => (chunk === null && !state.failed.includes(index) ? index : -1))
      .filter((index) => index >= 0);

    let next = 0;
    const chunkWorker = async () => {
      while (next < pending.length && !interrupted()) {
        const index = pending[next++];
        const startMs = index * CHUNK_MS;
        const prompt = chunkCount === 1 ? PROMPT : chunkPrompt(index, chunkCount);
        let result: NormalizedTranscript | null = null;
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !result && !interrupted(); attempt += 1) {
          try {
            // Jeder Anlauf mit anderer Bitrate: Eine Wiederholung mit identischer
            // Anfrage blieb in der Messung beim Dienst wiederholt hängen.
            const bitrate = BITRATES[attempt - 1] ?? "12k";
            let audio = await encodeChunk(file, startMs, bitrate);
            if (audio.length > MAX_INLINE_CHARS) audio = await encodeChunk(file, startMs, "10k");
            const part = await requestTranscript(prompt, audio, signal);
            result = { ...part, segments: shiftSegments(part.segments, startMs) };
          } catch (error) {
            if (interrupted()) break;
            log(`${id} Abschnitt ${index + 1}/${chunkCount}: Anlauf ${attempt} – ${errorText(error)}`);
            if (attempt < CHUNK_ATTEMPTS) await sleep(CHUNK_RETRY_PAUSE_MS);
          }
        }
        // Unterbrochen: Abschnitt bleibt offen für den nächsten Lauf.
        if (!result && interrupted()) break;
        if (result) state.chunks[index] = result;
        else state.failed.push(index);
        // Zwischenstand nach jedem Abschnitt sichern; beide Abschnitt-Worker
        // schreiben denselben Stand, der letzte Schreibvorgang enthält also beide.
        const written = await db.jobs.updateOne(own, { $set: { progress: state, lockedAt: iso() } });
        if (written.matchedCount === 0) throw new LockLost();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, pending.length) }, chunkWorker));
    if (lost) throw new LockLost();
    if (stopping) return await pause();

    const done = state.chunks.filter((chunk): chunk is NormalizedTranscript => chunk !== null);
    if (done.length === 0) {
      return await fail(
        state.failed.length > 0 && chunkCount > 1
          ? "Der Transkriptionsdienst hat auf keinen Abschnitt der Aufnahme geantwortet."
          : "Der Transkriptionsdienst hat nicht geantwortet.",
      );
    }
    const merged = mergeChunks(done);
    const gaps = [...state.failed]
      .sort((a, b) => a - b)
      .map((index) => ({ startMs: index * CHUNK_MS, endMs: Math.min((index + 1) * CHUNK_MS, durationMs) }));

    const mime = recording.mimeType as AudioMime;
    const aligned =
      mime === "audio/wav" || mime === "audio/mpeg"
        ? alignTranscript(merged.segments, bytes, mime, { gaps })
        : null;
    const segments = aligned?.segments ?? merged.segments;

    await saveTranscript(db, id, segments, merged.speakerLabels);
    const endMs = segments.length > 0 ? segments[segments.length - 1].endMs : 0;
    const duration = measuredMs ?? recording.durationMs ?? endMs;
    await db.recordings.updateOne(
      { _id: id },
      {
        $set: {
          speakerCount: merged.speakerLabels.length,
          wordCount: merged.wordCount,
          transcriptionChunks: chunkCount,
          transcriptionGaps: gaps.length > 0 ? gaps : null,
          transcriptionAlignment: aligned ? "akustisch" : "geschaetzt",
          ...(duration > 0 ? { durationMs: duration } : {}),
        },
      },
    );
    const status = segments.length === 0 ? "ohne_sprache" : "abgeschlossen";
    await finish(status);
    return { label: `${status}, ${chunkCount} Abschnitte, ${gaps.length} Lücken`, ok: true };
  } catch (error) {
    if (error instanceof LockLost || lost) {
      return { label: "Auftrag wurde zwischenzeitlich zurückgesetzt oder übernommen", ok: false };
    }
    if (stopping) return await pause();
    return await fail(errorText(error));
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Gleiche Ablage wie `saveTranscript` in `src/lib/transcription.ts`. */
async function saveTranscript(db: Db, recordingId: string, segments: TranscriptSegment[], speakerLabels: string[]) {
  await db.parts.deleteMany({ recordingId });
  for (const part of splitIntoParts(recordingId, segments)) await db.parts.insertOne(part);
  const index = buildTranscriptIndex(recordingId, segments, speakerLabels);
  await db.index.replaceOne({ _id: recordingId }, index, { upsert: true });
}

/* --------------------------------------------------------------- Dienst-Schleife */

const health = { activeJobs: new Set<string>(), processed: 0, failed: 0 };

async function writeHealth(db: Db, extra: Partial<WorkerDoc> = {}) {
  await db.workers.updateOne(
    { _id: WORKER_ID },
    {
      $set: {
        lastHeartbeatAt: iso(),
        activeJobs: [...health.activeJobs],
        processed: health.processed,
        failed: health.failed,
        ...extra,
      },
    },
  );
}

async function slot(db: Db, index: number): Promise<void> {
  let claims = 0;
  while (!stopping) {
    // Abwechselnd neuester und ältester Auftrag; die Plätze beginnen versetzt.
    const newestFirst = (index + claims) % 2 === 0;
    const lockId = randomUUID();
    let job: JobDoc | null;
    try {
      job = await claimNext(db, lockId, newestFirst);
    } catch (error) {
      log(`Platz ${index + 1}: Übernahme fehlgeschlagen (${errorText(error)})`);
      await wake.wait(ERROR_PAUSE_MS);
      continue;
    }
    if (!job) {
      const ms = await msUntilNextDue(db).catch(() => ERROR_PAUSE_MS);
      await wake.wait(ms);
      continue;
    }
    claims += 1;
    const started = Date.now();
    health.activeJobs.add(job._id);
    try {
      const outcome = await processJob(db, job, lockId);
      if (outcome.ok) health.processed += 1;
      else if (outcome.label.startsWith("fehlgeschlagen")) health.failed += 1;
      log(
        `Platz ${index + 1} ${newestFirst ? "neu" : "alt"} ${job._id}: ${outcome.label} ` +
          `(${Math.round((Date.now() - started) / 1000)} s)`,
      );
    } catch (error) {
      log(`Platz ${index + 1} ${job._id}: unerwarteter Fehler (${errorText(error)})`);
      await wake.wait(ERROR_PAUSE_MS);
    } finally {
      health.activeJobs.delete(job._id);
    }
  }
}

async function main() {
  env("CLAWCORP_API_KEY");
  const client = await new MongoClient(env("MONGODB_URI"), { maxPoolSize: 5 }).connect();
  const database = client.db();
  const db: Db = {
    jobs: database.collection<JobDoc>("jobs"),
    recordings: database.collection<RecordingDoc>("recordings"),
    parts: database.collection("transcript_parts"),
    index: database.collection("transcript_index"),
    workers: database.collection<WorkerDoc>(WORKERS_COLLECTION),
  };
  const slots = concurrency();
  const startedAt = iso();
  await db.workers.updateOne(
    { _id: WORKER_ID },
    {
      $set: {
        host: hostname(),
        concurrency: slots,
        startedAt,
        lastHeartbeatAt: startedAt,
        stoppedAt: null,
        activeJobs: [],
        processed: 0,
        failed: 0,
      },
    },
    { upsert: true },
  );
  const beat = setInterval(() => {
    writeHealth(db).catch((error) => log(`Lebenszeichen nicht geschrieben (${errorText(error)})`));
  }, HEARTBEAT_MS);
  const stopWatching = watchJobs(db);
  log(`Dienst ${WORKER_ID} gestartet, ${slots} Plätze.`);

  try {
    await Promise.all(Array.from({ length: slots }, (_, index) => slot(db, index)));
  } finally {
    clearInterval(beat);
    await stopWatching();
    await writeHealth(db, { stoppedAt: iso() }).catch(() => undefined);
    await client.close();
  }
  log(`Dienst beendet, ${health.processed} Aufträge abgeschlossen, ${health.failed} fehlgeschlagen.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[transkription] Dienst abgebrochen: ${errorText(error)}`);
    process.exit(1);
  },
);
