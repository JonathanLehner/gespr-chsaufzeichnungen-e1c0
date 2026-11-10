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
 *  - Vorübergehende Fehler (Zeitüberschreitung, 5xx, Netzwerk, Kostenlimit
 *    des Dienstes) beenden einen Auftrag nie: Er bleibt `wartend` mit
 *    `nextAttemptAt` (2 min, verdoppelt bis höchstens 30 min) und setzt beim
 *    nächsten Versuch an der gespeicherten Stelle fort. Endgültig
 *    `fehlgeschlagen` wird nur, was kein Versuch beheben kann: fehlende oder
 *    nicht dekodierbare Audiodatei, gelöschte Aufnahme.
 *  - Alle Anfragen an den Dienst laufen durch die gemeinsame Drossel
 *    (`limiter.ts`): wenige gleichzeitig über alle Instanzen, Mindestabstand
 *    zwischen den Starts, Pause der ganzen Spur nach einer Störung.
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
 *  - Steuerung aus dem Admin-Dashboard (Dokument der Drossel): gespeicherte
 *    Grenzen und Aufträge je Instanz gelten ohne Neustart. Bei einer Pause
 *    durch den Admin oder der Sperre nach dem Kostenlimit („monthly spending
 *    limit“) übernimmt kein Platz einen Auftrag, und laufende Aufträge gehen
 *    nach ihrer laufenden Anfrage mit gesichertem Zwischenstand zurück in die
 *    Warteschlange, ohne dass ein Versuch gezählt wird. Die Sperre endet am
 *    Monatsersten (Europe/Zurich) oder mit der Freigabe im Dashboard.
 *  - „Nach vorne“ im Dashboard setzt `priority`; solche Aufträge kommen zuerst.
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
import { AbortedWhileWaiting, GeminiLimiter, QueueHalted } from "./limiter";
import { alignTranscript } from "./shared/forced-alignment";
import {
  HEARTBEAT_MS,
  LIMITER_COLLECTION,
  LIMITER_ID,
  SETTINGS_LIMITS,
  STALE_LOCK_MS,
  WORKERS_COLLECTION,
  activeBlock,
  claimableFilter,
  iso,
  isSpendingLimitError,
  isTransientError,
  nextAttemptAfter,
  scheduledRetryFilter,
  type LimiterDoc,
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

/** Überschreibbar nur für lokale Tests (`scripts/check-transcriber-retry.mts`). */
const geminiUrl = () => process.env.TRANSCRIBER_GEMINI_URL || "https://www.clawcorp.ai/api/platform/gemini";
const MODEL = "gemini-2.5-flash";
/** Wird ein Auftrag so oft verwaist vorgefunden, wird er zurückgestellt statt sofort fortgesetzt. */
const MAX_STALE_CLAIMS = 2;
const CHUNK_MS = 60 * 1000;
const CHUNK_CONCURRENCY = 2;
/** Anläufe je Abschnitt und Lauf bei inhaltlichen Fehlern (ungültige Antwort, 400). */
const CHUNK_ATTEMPTS = 3;
/** Anläufe je Abschnitt und Lauf bei Störungen; danach wird der ganze Auftrag zurückgestellt. */
const CHUNK_TRANSIENT_ATTEMPTS = 2;
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
/** Abstand der Protokollzeile mit der tatsächlichen Anfragerate. */
const RATE_LOG_MS = 5 * 60 * 1000;
/** Docker beendet nach 10 s hart; bis dahin muss der Zwischenstand gesichert sein. */
const SHUTDOWN_GRACE_MS = 8 * 1000;

type Progress = {
  chunkCount: number;
  chunks: (NormalizedTranscript | null)[];
  /** Abschnitte ohne verwertbare Antwort (inhaltlicher Fehler); bleiben als Lücke. */
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
  /** „Nach vorne“ im Dashboard: höhere Werte kommen zuerst. */
  priority?: number | null;
  lastError?: string | null;
  /** Endgültig fehlgeschlagen; wird nicht automatisch wiederholt. */
  permanent?: boolean | null;
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
  deferred?: number;
};

type Db = {
  jobs: Collection<JobDoc>;
  recordings: Collection<RecordingDoc>;
  parts: Collection<{ _id: string }>;
  index: Collection<{ _id: string }>;
  workers: Collection<WorkerDoc>;
  limiter: Collection<LimiterDoc>;
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  return value;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= min ? Math.min(value, max) : fallback;
}

const concurrency = () => intEnv("TRANSCRIBER_CONCURRENCY", 2, 1, SETTINGS_LIMITS.jobsPerInstance.max);
/** Gleichzeitige Anfragen an den Dienst, über alle Instanzen zusammen. */
const geminiConcurrency = () => intEnv("TRANSCRIBER_GEMINI_CONCURRENCY", 2, 1, 8);
/** Mindestabstand zwischen zwei Anfragestarts, über alle Instanzen zusammen. */
const geminiGapMs = () => intEnv("TRANSCRIBER_GEMINI_GAP_MS", 4000, 0, 120_000);

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

/* --------------------------------------------------------------- Steuerung */

type Control = {
  halted: "pausiert" | "gesperrt" | null;
  /** Ende der Sperre (Monatswechsel); danach wird ohne Freigabe weitergearbeitet. */
  haltedUntil: number | null;
  jobsPerInstance: number;
};

let control: Control = { halted: null, haltedUntil: null, jobsPerInstance: 2 };

/** Liest Pause, Sperre und Aufträge je Instanz aus dem Dokument der Drossel. */
async function refreshControl(db: Db): Promise<Control> {
  const doc = await db.limiter.findOne(
    { _id: LIMITER_ID },
    { projection: { manualPause: 1, spendingBlock: 1, settings: 1 } },
  );
  const block = activeBlock(doc);
  const next: Control = {
    halted: block ? "gesperrt" : doc?.manualPause ? "pausiert" : null,
    haltedUntil: block ? Date.parse(block.until) : null,
    jobsPerInstance: doc?.settings?.jobsPerInstance ?? concurrency(),
  };
  if (next.halted !== control.halted || next.jobsPerInstance !== control.jobsPerInstance) {
    log(
      next.halted === "gesperrt"
        ? `Gesperrt wegen Kostenlimit bis ${block?.until}.`
        : next.halted === "pausiert"
          ? "Vom Admin pausiert."
          : `Warteschlange läuft, ${next.jobsPerInstance} Aufträge je Instanz.`,
    );
  }
  control = next;
  return next;
}

/** Weckt alle Plätze, sobald das Dashboard die Steuerung ändert (`controlVersion`). */
function watchControl(db: Db): () => Promise<void> {
  let stream: ChangeStream | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    try {
      stream = db.limiter.watch([
        { $match: { "updateDescription.updatedFields.controlVersion": { $exists: true } } },
      ]);
    } catch {
      return;
    }
    stream.on("change", () => {
      refreshControl(db)
        .catch((error) => log(`Steuerung nicht gelesen (${errorText(error)})`))
        .finally(() => wake.notify());
    });
    stream.on("error", () => {
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
    db.jobs.findOne(scheduledRetryFilter(), { sort: { nextAttemptAt: 1 }, projection: { nextAttemptAt: 1 } }),
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
    { sort: { priority: -1, createdAt: newestFirst ? -1 : 1 }, returnDocument: "before" },
  );
}

/* --------------------------------------------------------------- Audio */

/** Kein weiterer Versuch kann das beheben; der Auftrag endet als „fehlgeschlagen“. */
class PermanentError extends Error {}

/** Inhaltlicher Fehler einer einzelnen Anfrage (ungültige Antwort, 400, 413). */
class ContentError extends Error {}

/** Monatliches Kostenlimit des Kontos erreicht: sperrt alle Anfragen. */
class SpendingLimitError extends Error {}

async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  let res: Response;
  try {
    new URL(url);
  } catch {
    throw new PermanentError(`Die Adresse der Audiodatei ist ungültig: ${url.slice(0, 120)}`);
  }
  try {
    res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), signal]) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Download der Audiodatei: Zeitüberschreitung nach ${DOWNLOAD_TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`Download der Audiodatei: Netzwerkfehler (${errorText(error)}).`);
  }
  if (res.status === 404 || res.status === 410) {
    throw new PermanentError(`Die Audiodatei ist im Speicher nicht mehr vorhanden (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`Die Audiodatei konnte nicht geladen werden (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new PermanentError("Die Audiodatei ist leer (0 Byte).");
  return bytes;
}

/**
 * Prüft, ob ffmpeg die Datei lesen kann, und liefert die Dauer. Eine Datei
 * ohne lesbare Tonspur ist ein endgültiger Fehler; fehlt dagegen ffprobe
 * selbst, ist das ein Fehler des Dienstes und wird später wiederholt.
 */
async function probeAudio(file: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration",
      "-of", "json", file,
    ]));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    // Startfehler (ENOENT) oder Abbruch durch ein Signal: kein Befund über die Datei.
    if (typeof failure.code === "string" || (failure as { signal?: string }).signal) throw error;
    const detail = (failure.stderr ?? "").trim().split("\n").pop()?.replace(/^.*?: /, "") || "unbekanntes Format";
    throw new PermanentError(`Die Audiodatei lässt sich nicht dekodieren (${detail.slice(0, 160)}).`);
  }
  const info = JSON.parse(stdout || "{}") as { streams?: unknown[]; format?: { duration?: string } };
  if (!info.streams || info.streams.length === 0) {
    throw new PermanentError("Die Audiodatei enthält keine Tonspur.");
  }
  const seconds = Number(info.format?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
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
    res = await fetch(geminiUrl(), {
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
    const failure = `/gemini fehlgeschlagen (${res.status}): ${message}`;
    if (isSpendingLimitError(message)) throw new SpendingLimitError(failure);
    // 400, 413, 415, 422 betreffen diese eine Anfrage; alles andere ist eine Störung des Dienstes.
    if ([400, 413, 415, 422].includes(res.status) && !isTransientError(message)) throw new ContentError(failure);
    throw new Error(failure);
  }
  try {
    return normalizeTranscript(parseJsonLoosely((JSON.parse(text) as { text?: string }).text ?? ""));
  } catch (error) {
    throw new ContentError(errorText(error));
  }
}

/* --------------------------------------------------------------- Ablauf */

class LockLost extends Error {}

let limiter: GeminiLimiter;

/** Eine Anfrage an den Dienst, eingereiht in die gemeinsame Drossel. */
async function throttledTranscript(prompt: string, audio: string, signal: AbortSignal, recordingId: string) {
  const lease = await limiter.acquire(signal);
  try {
    const result = await requestTranscript(prompt, audio, signal);
    await limiter.release(lease, { ok: true });
    return result;
  } catch (error) {
    const reason = errorText(error);
    if (error instanceof SpendingLimitError) {
      // Erst sperren, dann den Platz freigeben: keine Instanz startet dazwischen eine Anfrage.
      await limiter.block(reason, recordingId);
      await limiter.recordError(recordingId, reason).catch(() => undefined);
      await limiter.release(lease, { ok: false, reason }).catch(() => undefined);
      throw new QueueHalted("gesperrt");
    }
    await limiter
      .release(lease, signal.aborted ? { ok: false, aborted: true } : { ok: false, transient: isTransientError(reason), reason })
      .catch((releaseError) => log(`Drossel nicht freigegeben (${errorText(releaseError)})`));
    throw error;
  }
}

type Outcome = { label: string; ok: boolean };

async function processJob(db: Db, before: JobDoc, lockId: string): Promise<Outcome> {
  const id = before._id;
  const own = { _id: id, lockId };
  const now = iso();
  const resumed = before.status === "in_arbeit" || !!before.paused;
  const orphaned = before.status === "in_arbeit" && !!before.lockedAt;
  const attempts = resumed ? Math.max(before.attempts ?? 0, 1) : (before.attempts ?? 0) + 1;
  const staleClaims = (before.staleClaims ?? 0) + (orphaned ? 1 : 0);
  // Ein Zwischenstand bleibt über Wiederholungen erhalten; fertige Abschnitte
  // werden nicht noch einmal angefragt. `resetJob` verwirft ihn.
  let progress: Progress | null = before.progress ?? null;

  const progressFields = (state: Progress | null) => ({
    progress: state,
    progressDone: state ? state.chunks.filter(Boolean).length + state.failed.length : null,
    progressTotal: state?.chunkCount ?? null,
  });

  const mirror = (fields: Record<string, unknown>) => db.recordings.updateOne({ _id: id }, { $set: fields });

  /** Endzustand: abgeschlossen, ohne Sprache oder endgültig fehlgeschlagen. */
  const finish = async (status: string, lastError: string | null = null) => {
    const closedAt = iso();
    const done = await db.jobs.updateOne(own, {
      $set: {
        status, finishedAt: closedAt, nextAttemptAt: null, lastError, permanent: status === "fehlgeschlagen",
        lockedAt: null, lockId: null, paused: null, staleClaims: 0, progressAt: null, priority: null,
        ...progressFields(null),
      },
    });
    if (done.matchedCount === 0) throw new LockLost();
    await mirror({
      transcriptionStatus: status,
      transcriptionError: lastError,
      transcriptionFinishedAt: closedAt,
      transcriptionNextAttemptAt: null,
      transcriptionAttempts: attempts,
    });
  };
  const fail = async (message: string): Promise<Outcome> => {
    await finish("fehlgeschlagen", message.slice(0, 400));
    return { label: `fehlgeschlagen: ${message}`, ok: false };
  };
  /**
   * Vorübergehender Fehler: Der Auftrag bleibt wartend und wird nach einer
   * wachsenden Pause (höchstens 30 min) an derselben Stelle fortgesetzt.
   */
  const defer = async (message: string, delayAttempts = attempts): Promise<Outcome> => {
    const closedAt = iso();
    const nextAttemptAt = nextAttemptAfter(delayAttempts);
    const lastError = message.slice(0, 400);
    const done = await db.jobs.updateOne(own, {
      $set: {
        status: "wartend", finishedAt: closedAt, nextAttemptAt, lastError, permanent: null,
        lockedAt: null, lockId: null, workerId: null, paused: null, staleClaims,
        ...progressFields(progress),
      },
    });
    if (done.matchedCount === 0) throw new LockLost();
    await mirror({
      transcriptionStatus: "wartend",
      transcriptionError: lastError,
      transcriptionFinishedAt: closedAt,
      transcriptionNextAttemptAt: nextAttemptAt,
      transcriptionAttempts: attempts,
    });
    return { label: `zurückgestellt bis ${nextAttemptAt}: ${message}`, ok: false };
  };
  /** Gibt den Auftrag beim Beenden frei; ein anderer Platz setzt an derselben Stelle fort. */
  const pause = async (): Promise<Outcome> => {
    const released = await db.jobs.updateOne(own, {
      $set: {
        status: "wartend", paused: true, lockedAt: null, lockId: null, workerId: null,
        ...(progress ? progressFields(progress) : {}),
      },
    });
    if (released.matchedCount === 0) return { label: "Auftrag wurde zwischenzeitlich zurückgesetzt", ok: false };
    await mirror({ transcriptionStatus: "wartend" });
    const doneCount = progress?.chunks.filter(Boolean).length ?? 0;
    return { label: `freigegeben bei ${doneCount}/${progress?.chunkCount ?? "?"} Abschnitten`, ok: false };
  };

  /**
   * Warteschlange angehalten (Admin-Pause oder Kostenlimit): Der Auftrag geht
   * mit gesichertem Zwischenstand und unverändertem Versuchszähler zurück und
   * behält seinen Platz (`createdAt`, `priority`).
   */
  const requeueHalted = async (kind: QueueHalted["kind"]): Promise<Outcome> => {
    const previous = before.attempts ?? 0;
    const released = await db.jobs.updateOne(own, {
      $set: {
        status: "wartend", attempts: previous, nextAttemptAt: null, lockedAt: null, lockId: null,
        workerId: null, paused: before.paused ?? null, staleClaims: before.staleClaims ?? 0,
        startedAt: before.startedAt ?? null,
        ...(progress ? progressFields(progress) : {}),
      },
    });
    if (released.matchedCount === 0) return { label: "Auftrag wurde zwischenzeitlich zurückgesetzt", ok: false };
    await mirror({
      transcriptionStatus: "wartend",
      transcriptionAttempts: previous,
      transcriptionNextAttemptAt: null,
      transcriptionError: before.lastError ?? null,
    });
    return { label: `angehalten (${kind}), zurück in die Warteschlange`, ok: false };
  };

  const recording = await db.recordings.findOne({ _id: id });
  if (!recording) {
    await finish("fehlgeschlagen", "Die Aufnahme wurde gelöscht.");
    return { label: "Aufnahme fehlt", ok: false };
  }
  if (staleClaims > MAX_STALE_CLAIMS) {
    // Der Dienst wurde mitten in diesem Auftrag mehrfach beendet. Statt sofort
    // weiterzumachen, wird er mit wachsender Pause zurückgestellt.
    await db.jobs.updateOne(own, { $set: { attempts } });
    return await defer("Die Transkription wurde wiederholt unterbrochen.", staleClaims);
  }

  await db.jobs.updateOne(own, {
    $set: {
      attempts,
      staleClaims,
      nextAttemptAt: null,
      paused: null,
      startedAt: resumed ? (before.startedAt ?? now) : now,
      progressAt: now,
    },
  });
  await mirror({
    transcriptionStatus: "in_arbeit",
    transcriptionError: null,
    transcriptionNextAttemptAt: null,
    transcriptionFinishedAt: null,
    transcriptionAttempts: attempts,
    ...(resumed ? {} : { transcriptionStartedAt: now }),
  });

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
    const measuredMs = await probeAudio(file);
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
    await db.jobs.updateOne(own, { $set: progressFields(state) });

    /** Letzte Störung eines Abschnitts; beendet den Lauf und stellt den Auftrag zurück. */
    let deferredBy: string | null = null;
    /** Pause oder Sperre: Lauf endet, der Auftrag geht ohne gezählten Versuch zurück. */
    let haltedBy: QueueHalted["kind"] | null = null;
    const stopRun = () => interrupted() || deferredBy !== null || haltedBy !== null;

    let next = 0;
    const chunkWorker = async () => {
      while (next < pending.length && !stopRun()) {
        const index = pending[next++];
        const startMs = index * CHUNK_MS;
        const prompt = chunkCount === 1 ? PROMPT : chunkPrompt(index, chunkCount);
        let result: NormalizedTranscript | null = null;
        let transientError: string | null = null;
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !result && !stopRun(); attempt += 1) {
          try {
            // Jeder Anlauf mit anderer Bitrate: Eine Wiederholung mit identischer
            // Anfrage blieb in der Messung beim Dienst wiederholt hängen.
            const bitrate = BITRATES[attempt - 1] ?? "12k";
            let audio = await encodeChunk(file, startMs, bitrate);
            if (audio.length > MAX_INLINE_CHARS) audio = await encodeChunk(file, startMs, "10k");
            const part = await throttledTranscript(prompt, audio, signal, id);
            result = { ...part, segments: shiftSegments(part.segments, startMs) };
            transientError = null;
          } catch (error) {
            if (interrupted() || error instanceof AbortedWhileWaiting) break;
            if (error instanceof QueueHalted) {
              haltedBy ??= error.kind;
              break;
            }
            log(`${id} Abschnitt ${index + 1}/${chunkCount}: Anlauf ${attempt} – ${errorText(error)}`);
            await limiter
              .recordError(id, `Abschnitt ${index + 1}/${chunkCount}: ${errorText(error)}`)
              .catch(() => undefined);
            transientError = error instanceof ContentError ? null : errorText(error);
            if (transientError && attempt >= CHUNK_TRANSIENT_ATTEMPTS) break;
            if (attempt < CHUNK_ATTEMPTS) await sleep(CHUNK_RETRY_PAUSE_MS);
          }
        }
        // Unterbrochen oder angehalten: Abschnitt bleibt offen für den nächsten Lauf.
        if (!result && (interrupted() || haltedBy)) break;
        if (!result && transientError) {
          // Störung: Abschnitt bleibt offen und wird beim nächsten Versuch nachgeholt.
          deferredBy ??= transientError;
          break;
        }
        if (result) state.chunks[index] = result;
        else state.failed.push(index);
        // Zwischenstand nach jedem Abschnitt sichern; beide Abschnitt-Worker
        // schreiben denselben Stand, der letzte Schreibvorgang enthält also beide.
        const written = await db.jobs.updateOne(own, {
          $set: { ...progressFields(state), lockedAt: iso(), progressAt: iso() },
        });
        if (written.matchedCount === 0) throw new LockLost();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, pending.length) }, chunkWorker));
    if (lost) throw new LockLost();
    if (stopping) return await pause();
    if (haltedBy) return await requeueHalted(haltedBy);
    if (deferredBy) return await defer(deferredBy);

    const done = state.chunks.filter((chunk): chunk is NormalizedTranscript => chunk !== null);
    if (done.length === 0) {
      // Keine einzige verwertbare Antwort: kein Transkript aus lauter Lücken
      // speichern, sondern alle Abschnitte später erneut anfragen.
      state.failed = [];
      return await defer(
        chunkCount > 1
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
    if (error instanceof QueueHalted) return await requeueHalted(error.kind);
    await limiter.recordError(id, errorText(error)).catch(() => undefined);
    if (error instanceof PermanentError) return await fail(error.message);
    return await defer(errorText(error));
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

const health = { activeJobs: new Set<string>(), processed: 0, failed: 0, deferred: 0 };

async function writeHealth(db: Db, extra: Partial<WorkerDoc> = {}) {
  await db.workers.updateOne(
    { _id: WORKER_ID },
    {
      $set: {
        lastHeartbeatAt: iso(),
        activeJobs: [...health.activeJobs],
        processed: health.processed,
        failed: health.failed,
        deferred: health.deferred,
        ...extra,
      },
    },
  );
}

async function slot(db: Db, index: number): Promise<void> {
  let claims = 0;
  while (!stopping) {
    // Angehalten oder dieser Platz liegt über den Aufträgen je Instanz: nichts übernehmen.
    const current = await refreshControl(db).catch(() => control);
    if (current.halted || index >= current.jobsPerInstance) {
      const untilLift = current.haltedUntil ? current.haltedUntil - Date.now() + 1000 : Infinity;
      await wake.wait(Math.max(1000, Math.min(changeStreamActive ? IDLE_MAX_MS : IDLE_FALLBACK_MS, untilLift)));
      continue;
    }
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
      else if (outcome.label.startsWith("zurückgestellt")) health.deferred += 1;
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

/**
 * Ältere Fassungen des Dienstes beendeten Aufträge nach drei vorübergehenden
 * Fehlern endgültig. Solche Aufträge kommen beim Start wieder in die
 * Warteschlange; endgültige Fehler (fehlende Datei) bleiben, wie sie sind.
 */
async function requeueTransientFailures(db: Db): Promise<void> {
  const failed = await db.jobs
    .find({ status: "fehlgeschlagen", permanent: { $ne: true } }, { projection: { lastError: 1 } })
    .toArray();
  const ids = failed.filter((job) => isTransientError(job.lastError ?? "")).map((job) => job._id);
  if (ids.length === 0) return;
  const at = iso();
  await db.jobs.updateMany(
    { _id: { $in: ids }, status: "fehlgeschlagen" },
    { $set: { status: "wartend", nextAttemptAt: at, lockedAt: null, lockId: null, workerId: null } },
  );
  await db.recordings.updateMany(
    { _id: { $in: ids }, transcriptionStatus: "fehlgeschlagen" },
    { $set: { transcriptionStatus: "wartend", transcriptionNextAttemptAt: at } },
  );
  log(`${ids.length} wegen vorübergehender Fehler beendete Aufträge wieder eingereiht.`);
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
    limiter: database.collection<LimiterDoc>(LIMITER_COLLECTION),
  };
  limiter = new GeminiLimiter(db.limiter, WORKER_ID, {
    maxConcurrent: geminiConcurrency(),
    minGapMs: geminiGapMs(),
    leaseMs: GEMINI_TIMEOUT_MS + 60 * 1000,
    log,
  });
  await requeueTransientFailures(db);
  await refreshControl(db);
  const slots = control.jobsPerInstance;
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
        deferred: 0,
      },
    },
    { upsert: true },
  );
  const beat = setInterval(() => {
    refreshControl(db)
      .then(() => writeHealth(db, { concurrency: control.jobsPerInstance }))
      .catch((error) => log(`Lebenszeichen nicht geschrieben (${errorText(error)})`));
  }, HEARTBEAT_MS);
  const rateLog = setInterval(() => {
    limiter.summary().then((line) => log(`Drossel: ${line}`), () => undefined);
  }, RATE_LOG_MS);
  const stopWatching = watchJobs(db);
  const stopWatchingControl = watchControl(db);
  log(
    `Dienst ${WORKER_ID} gestartet, ${slots} Plätze, Drossel ${limiter.options.maxConcurrent} gleichzeitig ` +
      `(alle Instanzen), ${limiter.options.minGapMs / 1000} s Abstand (Standard, Dashboard-Werte gehen vor).`,
  );

  try {
    // Alle möglichen Plätze laufen; über `jobsPerInstance` hinaus ruhen sie (änderbar im Dashboard).
    const maxSlots = SETTINGS_LIMITS.jobsPerInstance.max;
    await Promise.all(Array.from({ length: maxSlots }, (_, index) => slot(db, index)));
  } finally {
    clearInterval(beat);
    clearInterval(rateLog);
    await stopWatching();
    await stopWatchingControl();
    await writeHealth(db, { stoppedAt: iso() }).catch(() => undefined);
    await client.close();
  }
  log(
    `Dienst beendet, ${health.processed} Aufträge abgeschlossen, ${health.deferred} zurückgestellt, ` +
      `${health.failed} fehlgeschlagen.`,
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[transkription] Dienst abgebrochen: ${errorText(error)}`);
    process.exit(1);
  },
);
