/**
 * Transkriptionsdienst: arbeitet die Warteschlange `jobs` ab.
 *
 * Läuft als geplanter Dienst (siehe `clawcorp.json`, alle zehn Minuten) neben
 * der Anwendung. Die Anwendung legt beim Upload nur den Auftrag an; die
 * eigentliche Arbeit dauert bei langen Gesprächen Minuten und passt deshalb
 * nicht in eine Anfrage des Workers.
 *
 * Ein Lauf übernimmt fällige Aufträge nacheinander, bis die Warteschlange leer
 * oder das Zeitbudget aufgebraucht ist, und endet dann. Jeder fertige
 * Abschnitt wird sofort am Auftrag gespeichert (`progress`); ein Auftrag, der
 * am Ende des Budgets noch offen ist, wird im nächsten Lauf an derselben
 * Stelle fortgesetzt.
 *
 * Die Audiodatei wird über ihre Adresse geholt und mit ffmpeg in Abschnitte
 * von einer Minute geteilt, die als Opus mit 16 kbit/s direkt in der Anfrage
 * mitgehen (rund 160 KB je Abschnitt, Grenze des Endpunkts 200 KB).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MongoClient, type Collection } from "mongodb";
import { alignTranscript } from "./shared/forced-alignment";
import {
  PROMPT,
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
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3 * 60 * 1000, 15 * 60 * 1000];
/** Ab hier gilt eine Sperre als verwaist (Lauf abgebrochen). */
const STALE_LOCK_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
/** Wird ein Auftrag so oft verwaist vorgefunden, gilt er als fehlgeschlagen. */
const MAX_STALE_CLAIMS = 2;
/** Kürzer als der Abstand der Läufe, damit sie sich nicht überlappen. */
const RUN_BUDGET_MS = 8 * 60 * 1000;
const CHUNK_MS = 60 * 1000;
const CHUNK_CONCURRENCY = 2;
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_PAUSE_MS = 2000;
const GEMINI_TIMEOUT_MS = 120 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;
const BITRATES = ["16k", "14k", "12k"];
/** Base64-Länge, ab der ein Abschnitt mit geringerer Bitrate neu kodiert wird. */
const MAX_INLINE_CHARS = 180 * 1024;

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
  lockedAt?: string | null;
  lockId?: string | null;
  nextAttemptAt?: string | null;
  progress?: Progress | null;
  staleClaims?: number;
};

type RecordingDoc = {
  _id: string;
  audioUrl: string;
  mimeType: string;
  durationMs: number | null;
};

type Db = {
  jobs: Collection<JobDoc>;
  recordings: Collection<RecordingDoc>;
  parts: Collection<{ _id: string }>;
  index: Collection<{ _id: string }>;
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  return value;
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Beim Beenden des Containers laufende Anfragen abbrechen und pausieren. */
let stopping = false;
const shutdown = new AbortController();
process.on("SIGTERM", () => {
  stopping = true;
  shutdown.abort();
});

/* --------------------------------------------------------------- Übernahme */

/**
 * Übernimmt den ältesten fälligen Auftrag exklusiv. Geliefert wird der Stand
 * vor der Übernahme, daran entscheidet sich, ob fortgesetzt oder neu begonnen
 * wird.
 */
async function claimNext(db: Db, lockId: string): Promise<JobDoc | null> {
  const now = iso();
  return db.jobs.findOneAndUpdate(
    {
      $or: [
        { status: "wartend" },
        {
          status: "fehlgeschlagen",
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        // Pausiert (Sperre freigegeben) oder verwaist (Sperre abgelaufen).
        { status: "in_arbeit", $or: [{ lockedAt: null }, { lockedAt: { $lt: iso(Date.now() - STALE_LOCK_MS) } }] },
      ],
    },
    { $set: { status: "in_arbeit", lockedAt: now, lockId } },
    { sort: { createdAt: 1 }, returnDocument: "before" },
  );
}

/* --------------------------------------------------------------- Audio */

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
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

async function requestTranscript(prompt: string, audioBase64: string): Promise<NormalizedTranscript> {
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
      signal: AbortSignal.any([AbortSignal.timeout(GEMINI_TIMEOUT_MS), shutdown.signal]),
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

async function processJob(db: Db, before: JobDoc, lockId: string, deadline: number): Promise<string> {
  const id = before._id;
  const own = { _id: id, lockId };
  const now = iso();
  const resumed = before.status === "in_arbeit";
  const orphaned = resumed && !!before.lockedAt;
  const attempts = resumed ? Math.max(before.attempts ?? 0, 1) : (before.attempts ?? 0) + 1;
  const staleClaims = (before.staleClaims ?? 0) + (orphaned ? 1 : 0);

  const finish = async (status: string, fields: { lastError?: string | null; nextAttemptAt?: string | null } = {}) => {
    const closedAt = iso();
    const lastError = fields.lastError ?? null;
    const nextAttemptAt = fields.nextAttemptAt ?? null;
    const done = await db.jobs.updateOne(own, {
      $set: { status, finishedAt: closedAt, nextAttemptAt, lastError, lockedAt: null, lockId: null, progress: null },
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
  const fail = (message: string) =>
    finish("fehlgeschlagen", {
      lastError: message.slice(0, 400),
      nextAttemptAt:
        attempts >= MAX_ATTEMPTS ? null : iso(Date.now() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]),
    });

  const recording = await db.recordings.findOne({ _id: id });
  if (!recording) {
    await db.jobs.updateOne(own, { $set: { attempts: MAX_ATTEMPTS } });
    await fail("Aufnahme nicht gefunden.");
    return "Aufnahme fehlt";
  }
  if (staleClaims > MAX_STALE_CLAIMS) {
    await db.jobs.updateOne(own, { $set: { attempts: MAX_ATTEMPTS, staleClaims } });
    await fail("Die Transkription wurde wiederholt unterbrochen.");
    return "wiederholt unterbrochen";
  }

  await db.jobs.updateOne(own, {
    $set: {
      attempts,
      staleClaims,
      nextAttemptAt: null,
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

  const heartbeat = setInterval(() => {
    db.jobs.updateOne(own, { $set: { lockedAt: iso() } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  const dir = await mkdtemp(join(tmpdir(), "transkription-"));
  try {
    const bytes = await download(recording.audioUrl);
    const file = join(dir, "audio");
    await writeFile(file, bytes);
    const measuredMs = await probeDurationMs(file);
    const durationMs = measuredMs ?? recording.durationMs ?? CHUNK_MS;
    const chunkCount = Math.max(1, Math.ceil(durationMs / CHUNK_MS));

    const saved = resumed ? before.progress : null;
    const progress: Progress =
      saved && saved.chunkCount === chunkCount
        ? saved
        : { chunkCount, chunks: new Array(chunkCount).fill(null), failed: [] };
    const pending = progress.chunks
      .map((chunk, index) => (chunk === null && !progress.failed.includes(index) ? index : -1))
      .filter((index) => index >= 0);

    let next = 0;
    const worker = async () => {
      while (next < pending.length && Date.now() < deadline && !stopping) {
        const index = pending[next++];
        const startMs = index * CHUNK_MS;
        const prompt = chunkCount === 1 ? PROMPT : chunkPrompt(index, chunkCount);
        let result: NormalizedTranscript | null = null;
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !result && !stopping; attempt += 1) {
          try {
            // Jeder Anlauf mit anderer Bitrate: Eine Wiederholung mit identischer
            // Anfrage blieb in der Messung beim Dienst wiederholt hängen.
            const bitrate = BITRATES[attempt - 1] ?? "12k";
            let audio = await encodeChunk(file, startMs, bitrate);
            if (audio.length > MAX_INLINE_CHARS) audio = await encodeChunk(file, startMs, "10k");
            const part = await requestTranscript(prompt, audio);
            result = { ...part, segments: shiftSegments(part.segments, startMs) };
          } catch (error) {
            console.warn(`[transkription] ${id} Abschnitt ${index + 1}/${chunkCount}: Anlauf ${attempt} – ${errorText(error)}`);
            if (attempt < CHUNK_ATTEMPTS) await sleep(CHUNK_RETRY_PAUSE_MS);
          }
        }
        // Beim Beenden unterbrochen: Abschnitt bleibt offen für den nächsten Lauf.
        if (!result && stopping) break;
        if (result) progress.chunks[index] = result;
        else progress.failed.push(index);
        // Zwischenstand nach jedem Abschnitt sichern; beide Worker schreiben
        // denselben Stand, der letzte Schreibvorgang enthält also beide.
        const written = await db.jobs.updateOne(own, { $set: { progress, lockedAt: iso() } });
        if (written.matchedCount === 0) throw new LockLost();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, pending.length) }, worker));

    const open = progress.chunks.some((chunk, index) => chunk === null && !progress.failed.includes(index));
    if (open) {
      const paused = await db.jobs.updateOne(own, { $set: { lockedAt: null, lockId: null } });
      if (paused.matchedCount === 0) throw new LockLost();
      const doneCount = progress.chunks.filter(Boolean).length;
      return `pausiert bei ${doneCount}/${chunkCount} Abschnitten`;
    }

    const done = progress.chunks.filter((chunk): chunk is NormalizedTranscript => chunk !== null);
    if (done.length === 0) {
      await fail(
        progress.failed.length > 0 && chunkCount > 1
          ? "Der Transkriptionsdienst hat auf keinen Abschnitt der Aufnahme geantwortet."
          : "Der Transkriptionsdienst hat nicht geantwortet.",
      );
      return "fehlgeschlagen";
    }
    const merged = mergeChunks(done);
    const gaps = [...progress.failed]
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
    await finish(segments.length === 0 ? "ohne_sprache" : "abgeschlossen");
    return `${segments.length === 0 ? "ohne Sprache" : "abgeschlossen"}, ${chunkCount} Abschnitte, ${gaps.length} Lücken`;
  } catch (error) {
    if (error instanceof LockLost) return "Auftrag wurde zwischenzeitlich zurückgesetzt";
    await fail(errorText(error));
    return `fehlgeschlagen: ${errorText(error)}`;
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Gleiche Ablage wie `saveTranscript` in `src/lib/transcription.ts`. */
async function saveTranscript(db: Db, recordingId: string, segments: TranscriptSegment[], speakerLabels: string[]) {
  await db.parts.deleteMany({ recordingId });
  for (const part of splitIntoParts(recordingId, segments)) await db.parts.insertOne(part);
  const sentences = segments.flatMap((segment) =>
    segment.sentences.map((sentence) => ({
      t: sentence.startMs,
      e: sentence.endMs,
      s: segment.speakerLabel,
      x: sentence.text,
    })),
  );
  await db.index.replaceOne(
    { _id: recordingId },
    {
      recordingId,
      fullText: sentences.map((sentence) => sentence.x).join(" "),
      sentences,
      speakerLabels,
      updatedAt: iso(),
    },
    { upsert: true },
  );
}

async function main() {
  const client = await new MongoClient(env("MONGODB_URI"), { maxPoolSize: 5 }).connect();
  const database = client.db();
  const db: Db = {
    jobs: database.collection<JobDoc>("jobs"),
    recordings: database.collection<RecordingDoc>("recordings"),
    parts: database.collection("transcript_parts"),
    index: database.collection("transcript_index"),
  };
  const deadline = Date.now() + RUN_BUDGET_MS;
  let handled = 0;
  try {
    while (Date.now() < deadline && !stopping) {
      const lockId = randomUUID();
      const job = await claimNext(db, lockId);
      if (!job) break;
      const started = Date.now();
      const outcome = await processJob(db, job, lockId, deadline);
      handled += 1;
      console.log(`[transkription] ${job._id}: ${outcome} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  } finally {
    await client.close();
  }
  console.log(`[transkription] Lauf beendet, ${handled} Aufträge bearbeitet.`);
}

main().catch((error) => {
  console.error(`[transkription] Lauf abgebrochen: ${errorText(error)}`);
  process.exit(1);
});
