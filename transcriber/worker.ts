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
 *    Auftrag an der gespeicherten Stelle (`progress`), vor allen wartenden.
 *    Das gilt für jeden laufenden Auftrag mit altem `lockedAt`, auch ohne
 *    `workerId`/`lockId` (frühere Verarbeitung in der Anfrage).
 *  - Jede Änderung an Status, Fortschritt oder Lebenszeichen erhöht den
 *    Versionsstempel `settings/status_version`; die Anwendung zeigt damit
 *    immer den Stand der Datenbank.
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
 * Anwendung, die aus dem R2-Bucket liefert) und mit ffmpeg in Abschnitte
 * geteilt:
 *  - Flash-Modelle (Plattform-Endpunkt `/gemini`): eine Minute, als Opus mit
 *    16 kbit/s direkt in der Anfrage (rund 160 KB, Grenze des Endpunkts 200 KB),
 *    Antwort an `responseSchema` gebunden.
 *  - gemini-3.5-transcribe (Gemini API direkt mit `GEMINI_API_KEY`): höchstens
 *    `DIRECT_CHUNK_MAX_MS`, in einer Pause geschnitten, Upload über die Files
 *    API und Transkription über die Interactions-API mit Wortzeiten und
 *    Sprechern. Der Schlüssel wird nie protokolliert; Fehler werden nur mit
 *    ihrer Meldung weitergegeben.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { MongoClient, type ChangeStream, type Collection } from "mongodb";
import { claimJob } from "./claim";
import { AbortedWhileWaiting, GeminiLimiter, QueueHalted } from "./limiter";
import { energyEnvelope } from "./shared/audio-envelope";
import { boundsAtPauses, fixedBounds, type ChunkBounds } from "./shared/chunk-bounds";
import { alignTranscript, detectSpeech } from "./shared/forced-alignment";
import {
  BASE_VOCABULARY,
  EMPTY_USAGE,
  TRANSCRIPTION_SETTINGS_ID,
  TRANSCRIPT_HISTORY_MAX,
  addUsage,
  callerVocabulary,
  costUsd,
  legacyTranscriptMeta,
  normalizeVocabulary,
  resolveModel,
  usageFromInteraction,
  usageFromMetadata,
  vocabularyPrompt,
  type TokenUsage,
  type TranscriptMeta,
  type TranscriptionModel,
  type TranscriptionSettings,
} from "./shared/models";
import {
  HEARTBEAT_MS,
  LIMITER_COLLECTION,
  REQUIRED_WORKER_FEATURES,
  LIMITER_ID,
  SETTINGS_LIMITS,
  STALE_LOCK_MS,
  STATUS_VERSION_COLLECTION,
  STATUS_VERSION_ID,
  WORKERS_COLLECTION,
  activeBlock,
  iso,
  isSpendingLimitError,
  isTransientError,
  nextAttemptAfter,
  scheduledRetryFilter,
  type LimiterDoc,
} from "./shared/queue";
import {
  PROMPT,
  TRANSCRIPT_RESPONSE_SCHEMA,
  buildTranscriptIndex,
  chunkPrompt,
  chunkContext,
  mergeChunks,
  normalizeTranscript,
  parseJsonLoosely,
  shiftSegments,
  splitIntoParts,
  type NormalizedTranscript,
} from "./shared/transcript";
import type { AudioMime, TranscriptSegment } from "./shared/types";
import { correctVocabulary } from "./shared/vocabulary-correction";
import { segmentsFromWords, type WordAnnotation } from "./shared/word-timestamps";

const run = promisify(execFile);

/** Überschreibbar nur für lokale Tests (`scripts/check-transcriber-retry.mts`). */
const geminiUrl = () => process.env.TRANSCRIBER_GEMINI_URL || "https://www.clawcorp.ai/api/platform/gemini";
/** Sammlung mit einem Eintrag je abgeschlossenem Lauf (Kosten je Monat im Dashboard). */
const RUNS_COLLECTION = "transcription_runs";
/** Abgelöste Transkripte (Text samt Zeiten) bei einer Neu-Transkription. */
const HISTORY_PARTS_COLLECTION = "transcript_history_parts";
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
/**
 * Längster Abschnitt für gemini-3.5-transcribe. Google erlaubt mit Wortzeiten
 * und Sprechern 30 min je Anfrage, begrenzt aber in Stufe 1 auf 10 000
 * Eingabe-Tokens je Minute (rund 1500 Tokens je Audiominute). Ein längerer
 * Abschnitt würde nie angenommen.
 */
const DIRECT_CHUNK_MAX_MS = 5 * 60 * 1000;
const DIRECT_BITRATE = "24k";
const UPLOAD_TIMEOUT_MS = 45 * 1000;
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
  /** Modell dieses Zwischenstands; ein anderes Modell beginnt von vorn. */
  model?: string;
  /** Grenzen der Abschnitte; fehlt bei älteren Zwischenständen (feste 60 s). */
  bounds?: ChunkBounds[];
  /** Summe der Tokens aller beantworteten Anfragen dieses Auftrags. */
  usage?: TokenUsage;
  modelVersion?: string | null;
  /** Antworten, die kein gültiges JSON waren (Dashboard). */
  invalidReplies?: number;
  /** Nachkorrekturen aus dem Vokabular (gemini-3.5-transcribe). */
  corrections?: number;
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
  /** Modell nur für diesen Auftrag; sonst gilt die Einstellung im Dashboard. */
  model?: string | null;
  /** `neu_ausrichten`: nur die Zeiten des vorhandenen Transkripts neu bestimmen, ohne Anfrage. */
  kind?: "transkription" | "neu_ausrichten" | null;
  /**
   * Nachrangige Neu-Transkription eines vorhandenen Transkripts: kommt nach
   * allen anderen Aufträgen, und das bisherige Transkript bleibt sichtbar,
   * bis das neue gespeichert ist.
   */
  background?: boolean | null;
};

type RecordingDoc = {
  _id: string;
  audioUrl: string;
  mimeType: string;
  durationMs: number | null;
  transcriptionStatus?: string;
  transcriptionFinishedAt?: string | null;
  transcriptionGaps?: { startMs: number; endMs: number }[] | null;
  transcript?: TranscriptMeta | null;
};

type RunDoc = {
  _id: string;
  recordingId: string;
  model: string;
  modelVersion: string | null;
  kind: "transkription" | "neu_ausrichten";
  background: boolean;
  at: string;
  audioMs: number | null;
  usage: TokenUsage;
  costUsd: number;
  invalidReplies: number;
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
  historyParts: Collection<{ _id: string }>;
  index: Collection<{ _id: string }>;
  workers: Collection<WorkerDoc>;
  limiter: Collection<LimiterDoc>;
  settings: Collection<{ _id: string; value?: number; at?: string }>;
  config: Collection<TranscriptionSettings>;
  runs: Collection<RunDoc>;
};

/**
 * Erhöht den Versionsstempel (`STATUS_VERSION_ID`). Die Anwendung erkennt
 * daran geänderte Status und Fortschritte sofort, statt Zwischengespeichertes
 * zu zeigen. Ein Fehler hier hält keinen Auftrag auf.
 */
function bumpStatusVersion(db: Db): Promise<void> {
  return db.settings
    .updateOne({ _id: STATUS_VERSION_ID }, { $inc: { value: 1 }, $set: { at: iso() } }, { upsert: true })
    .then(
      () => undefined,
      (error) => log(`Versionsstempel nicht erhöht (${errorText(error)})`),
    );
}

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
const WORKER_FEATURES = [...REQUIRED_WORKER_FEATURES];

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

/** Übernimmt einen fälligen Auftrag exklusiv, verwaiste zuerst (`claim.ts`). */
function claimNext(db: Db, lockId: string, newestFirst: boolean, allowBackground: boolean): Promise<JobDoc | null> {
  return claimJob(db.jobs, { lockId, workerId: WORKER_ID, newestFirst, allowBackground });
}

/* --------------------------------------------------------------- Einstellungen */

/**
 * Modell und Vokabular aus dem Dashboard. Ohne gespeicherte Liste gilt die
 * Vorbelegung samt den Namen der Anrufer aus den Aufnahmen.
 */
async function readTranscriptionConfig(db: Db, jobModel: string | null | undefined) {
  const doc = await db.config.findOne({ _id: TRANSCRIPTION_SETTINGS_ID });
  const model = resolveModel(jobModel || doc?.model, hasDirectKey());
  let vocabulary = doc?.vocabulary;
  if (!vocabulary) {
    const names = await db.recordings
      .aggregate<{ _id: { first?: string; last?: string } }>([
        { $group: { _id: { first: "$callerFirstName", last: "$callerLastName" } } },
      ])
      .toArray();
    vocabulary = [...BASE_VOCABULARY, ...callerVocabulary(names.map((entry) => entry._id))];
  }
  return { model, vocabulary: normalizeVocabulary(vocabulary) };
}

/* --------------------------------------------------------------- Audio */

/** Kein weiterer Versuch kann das beheben; der Auftrag endet als „fehlgeschlagen“. */
class PermanentError extends Error {}

/** Inhaltlicher Fehler einer einzelnen Anfrage (ungültige Antwort, 400, 413). */
class ContentError extends Error {}

/** Antwort war kein gültiges JSON: einmal wiederholen, dann zurückstellen statt Lücke. */
class InvalidReplyError extends ContentError {}

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

async function encodeChunk(file: string, bounds: ChunkBounds, bitrate: string): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-loglevel", "error", "-ss", String(bounds.startMs / 1000), "-t", String((bounds.endMs - bounds.startMs) / 1000),
      "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", bitrate,
      "-application", "voip", "-f", "ogg", "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/** Sprechbereiche für die Schnitte von gemini-3.5-transcribe; `null` bei unlesbarem Format. */
function speechRegions(bytes: Uint8Array, mime: AudioMime) {
  if (mime !== "audio/wav" && mime !== "audio/mpeg") return null;
  const envelope = energyEnvelope(bytes, mime);
  return envelope ? detectSpeech(envelope) : null;
}

/* --------------------------------------------------------------- Dienst */

type ChunkAnswer = { transcript: NormalizedTranscript; usage: TokenUsage; modelVersion: string | null; corrections?: number };

/** Prompt-Modelle mit eigenem Schlüssel direkt bei Google (`generateContent`, REST). */
async function requestPromptDirect(
  model: TranscriptionModel,
  prompt: string,
  audioBase64: string,
  signal: AbortSignal,
): Promise<ChunkAnswer> {
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/ogg", data: audioBase64 } }] },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          temperature: 0,
          ...model.generationConfig,
        },
      }),
      signal: AbortSignal.any([AbortSignal.timeout(GEMINI_TIMEOUT_MS), signal]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Gemini API: Zeitüberschreitung nach ${GEMINI_TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`Gemini API: Netzwerkfehler (${errorText(error)}).`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* Rohtext verwenden */
    }
    const failure = `Gemini API fehlgeschlagen (${res.status}): ${message.slice(0, 400)}`;
    if (isSpendingLimitError(message)) throw new SpendingLimitError(failure);
    if ([400, 413, 415, 422].includes(res.status) && !isTransientError(message)) throw new ContentError(failure);
    // 401/403 (Schlüssel), 404, 429, 5xx: vorübergehend, der Auftrag wird zurückgestellt.
    throw new Error(failure);
  }
  type Body = {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: Parameters<typeof usageFromMetadata>[0];
    modelVersion?: string;
  };
  let body: Body;
  try {
    body = JSON.parse(text) as Body;
  } catch (error) {
    throw new ContentError(`Gemini API: unlesbare Antwort (${errorText(error)})`);
  }
  const usage = usageFromMetadata(body.usageMetadata);
  const modelVersion = body.modelVersion ?? null;
  const answer = (body.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  try {
    return { transcript: normalizeTranscript(parseJsonLoosely(answer)), usage, modelVersion };
  } catch (error) {
    throw Object.assign(new InvalidReplyError(`Ungültiges JSON vom Modell: ${errorText(error)}`), { usage, modelVersion });
  }
}

/** Prompt-Modelle, Antwort an `responseSchema` gebunden: direkt bei Google oder über den Plattform-Endpunkt. */
async function requestTranscript(
  model: TranscriptionModel,
  prompt: string,
  audioBase64: string,
  signal: AbortSignal,
): Promise<ChunkAnswer> {
  if (model.path !== "prompt") throw new PermanentError(`Das Modell ${model.id} ist nicht verfügbar.`);
  if (model.route === "direkt") return requestPromptDirect(model, prompt, audioBase64, signal);
  let res: Response;
  try {
    res = await fetch(geminiUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${env("CLAWCORP_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        contents: [
          { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/ogg", data: audioBase64 } }] },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          temperature: 0,
          ...model.generationConfig,
        },
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
  let body: { text?: string; response?: { usageMetadata?: Parameters<typeof usageFromMetadata>[0]; modelVersion?: string } };
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ContentError(`/gemini: unlesbare Antwort (${errorText(error)})`);
  }
  const usage = usageFromMetadata(body.response?.usageMetadata);
  const modelVersion = body.response?.modelVersion ?? null;
  try {
    return { transcript: normalizeTranscript(parseJsonLoosely(body.text ?? "")), usage, modelVersion };
  } catch (error) {
    // Die Anfrage ist trotzdem berechnet worden.
    throw Object.assign(new InvalidReplyError(`Ungültiges JSON vom Modell: ${errorText(error)}`), { usage, modelVersion });
  }
}

const hasDirectKey = () => !!process.env.GEMINI_API_KEY;

/** Client je Anfrage; der Schlüssel wird erst hier gelesen. Eigene Wiederholungen des SDK aus: Das übernimmt die Drossel. */
function directClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: env("GEMINI_API_KEY"),
    apiVersion: "v1beta",
    httpOptions: { retryOptions: { attempts: 1 } },
  });
}

/** Ordnet einen Fehler des SDK den Regeln des Dienstes zu, nur mit Status und Meldung. */
function directFailure(step: string, error: unknown): Error {
  const status = (error as { status?: number }).status;
  const raw = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error(`Gemini API (${step}): Zeitüberschreitung oder abgebrochen.`);
  }
  const message = `Gemini API ${step} fehlgeschlagen${status ? ` (${status})` : ""}: ${raw.slice(0, 400)}`;
  if (isSpendingLimitError(raw)) return new SpendingLimitError(message);
  if (status && [400, 413, 415, 422].includes(status) && !isTransientError(raw)) return new ContentError(message);
  // 401/403 (Schlüssel), 404, 429, 5xx und Netzwerk: vorübergehend, der Auftrag wird zurückgestellt.
  return new Error(message);
}

/**
 * gemini-3.5-transcribe direkt bei Google: Upload über die Files API
 * (fortsetzbar, vom SDK erledigt), dann Interactions-API mit Wortzeiten und
 * Sprechern. `custom_vocabulary` lehnt Google in dieser Kombination ab; das
 * Vokabular wird nachträglich auf die Wörter angewendet.
 */
async function requestDirectTranscript(
  audio: Buffer,
  offsetMs: number,
  vocabulary: readonly string[],
  signal: AbortSignal,
): Promise<ChunkAnswer> {
  const ai = directClient();
  let uploaded: { name?: string; uri?: string };
  try {
    uploaded = await ai.files.upload({
      file: new Blob([new Uint8Array(audio)], { type: "audio/ogg" }),
      config: { mimeType: "audio/ogg", abortSignal: AbortSignal.any([AbortSignal.timeout(UPLOAD_TIMEOUT_MS), signal]) },
    });
  } catch (error) {
    throw directFailure("Upload", error);
  }
  try {
    if (!uploaded.uri) throw new Error("Upload ohne Adresse.");
    let response: {
      model?: string;
      usage?: Parameters<typeof usageFromInteraction>[0];
      steps?: { type?: string; content?: { type?: string; annotations?: WordAnnotation[] }[] }[];
    };
    try {
      response = (await ai.interactions.create(
        {
          model: "gemini-3.5-transcribe",
          input: [{ type: "audio", uri: uploaded.uri, mime_type: "audio/ogg" }],
          generation_config: {
            transcription_config: {
              mode: { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] },
            },
          },
        } as Parameters<typeof ai.interactions.create>[0],
        { signal: AbortSignal.any([AbortSignal.timeout(GEMINI_TIMEOUT_MS), signal]), retries: { strategy: "none" } },
      )) as typeof response;
    } catch (error) {
      throw directFailure("Transkription", error);
    }
    const usage = usageFromInteraction(response.usage);
    const words = (response.steps ?? [])
      .flatMap((step) => step.content ?? [])
      .flatMap((content) => content.annotations ?? [])
      .filter((annotation) => annotation.type === "word_info");
    const corrected = correctVocabulary(words, vocabulary);
    const built = segmentsFromWords(corrected.words, offsetMs);
    const endMs = built.segments.length > 0 ? built.segments[built.segments.length - 1].endMs : 0;
    return {
      transcript: { ...built, endMs },
      usage,
      modelVersion: response.model ?? null,
      corrections: corrected.corrections,
    };
  } finally {
    // Aufräumen ist nicht kritisch: Google löscht hochgeladene Dateien nach 48 h selbst.
    if (uploaded.name) await ai.files.delete({ name: uploaded.name }).catch(() => undefined);
  }
}

/* --------------------------------------------------------------- Ablauf */

class LockLost extends Error {}

let limiter: GeminiLimiter;

/** Eine Anfrage an den Dienst, eingereiht in die gemeinsame Drossel. */
async function throttled<T>(request: () => Promise<T>, signal: AbortSignal, recordingId: string): Promise<T> {
  const lease = await limiter.acquire(signal);
  try {
    const result = await request();
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
  const background = !!before.background;
  // Ein Zwischenstand bleibt über Wiederholungen erhalten; fertige Abschnitte
  // werden nicht noch einmal angefragt. `resetJob` verwirft ihn.
  let progress: Progress | null = before.progress ?? null;

  const progressFields = (state: Progress | null) => ({
    progress: state,
    progressDone: state ? state.chunks.filter(Boolean).length + state.failed.length : null,
    progressTotal: state?.chunkCount ?? null,
  });

  /**
   * Überträgt den Zustand auf die Aufnahme. Bei einer nachrangigen
   * Neu-Transkription bleibt die Aufnahme mit ihrem bisherigen Transkript
   * unverändert, bis das neue gespeichert ist (`always`).
   */
  const mirror = async (fields: Record<string, unknown>, always = false) => {
    if (!background || always) await db.recordings.updateOne({ _id: id }, { $set: fields });
    await bumpStatusVersion(db);
  };

  /** Endzustand: abgeschlossen, ohne Sprache oder endgültig fehlgeschlagen. */
  const finish = async (status: string, lastError: string | null = null) => {
    const closedAt = iso();
    const done = await db.jobs.updateOne(own, {
      $set: {
        status, finishedAt: closedAt, nextAttemptAt: null, lastError, permanent: status === "fehlgeschlagen",
        lockedAt: null, lockId: null, paused: null, staleClaims: 0, progressAt: null, priority: null,
        progressRunAt: null, progressRunDone: null,
        ...progressFields(null),
      },
    });
    if (done.matchedCount === 0) throw new LockLost();
    // Eine fertige Neu-Transkription gilt auch für die Aufnahme; ein Fehlschlag
    // betrifft nur den Auftrag, das bisherige Transkript bleibt.
    await mirror(
      {
        transcriptionStatus: status,
        transcriptionError: lastError,
        transcriptionFinishedAt: closedAt,
        transcriptionNextAttemptAt: null,
        transcriptionAttempts: attempts,
      },
      status === "abgeschlossen",
    );
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
          return;
        }
        // Die Anzeige „zuletzt aktualisiert vor …“ folgt dem Lebenszeichen.
        return bumpStatusVersion(db);
      })
      .catch((error) => log(`${id}: Lebenszeichen nicht geschrieben (${errorText(error)})`));
  }, HEARTBEAT_MS);
  const interrupted = () => stopping || lost;

  const dir = await mkdtemp(join(tmpdir(), "transkription-"));
  try {
    const bytes = await download(recording.audioUrl, signal);
    if (before.kind === "neu_ausrichten") {
      const label = await retimeTranscript(db, recording, bytes);
      await finish("abgeschlossen");
      return { label, ok: true };
    }
    const file = join(dir, "audio");
    await writeFile(file, bytes);
    const measuredMs = await probeAudio(file);
    const durationMs = measuredMs ?? recording.durationMs ?? CHUNK_MS;
    const { model, vocabulary } = await readTranscriptionConfig(db, before.model);
    // gemini-3.5-transcribe (Transcribe-API); Prompt-Modelle gehen über `requestTranscript`.
    const direct = model.path === "transkription";
    const mime = recording.mimeType as AudioMime;
    // gemini-3.5-transcribe: lange Abschnitte, in einer Pause geschnitten; Flash: feste Minute.
    const bounds = direct
      ? boundsAtPauses(durationMs, DIRECT_CHUNK_MAX_MS, speechRegions(bytes, mime))
      : fixedBounds(durationMs, CHUNK_MS);
    const chunkCount = bounds.length;
    const vocabularyText = vocabularyPrompt(vocabulary);

    // Ein Zwischenstand ohne Modellangabe stammt vom bisherigen Modell.
    const state: Progress =
      progress && progress.chunkCount === chunkCount && (progress.model ?? "gemini-2.5-flash") === model.id
        ? progress
        : { chunkCount, chunks: new Array(chunkCount).fill(null), failed: [], model: model.id, usage: { ...EMPTY_USAGE } };
    state.model = model.id;
    state.bounds = bounds;
    state.usage ??= { ...EMPTY_USAGE };
    progress = state;
    const pending = state.chunks
      .map((chunk, index) => (chunk === null && !state.failed.includes(index) ? index : -1))
      .filter((index) => index >= 0);
    // Beginn des Durchgangs: daraus misst die Anzeige die Zeit je Abschnitt.
    await db.jobs.updateOne(own, {
      $set: {
        ...progressFields(state),
        // Bleibt nach dem Lauf stehen: Die Auftragsliste zeigt und filtert danach.
        usedModel: model.id,
        progressRunAt: iso(),
        progressRunDone: state.chunks.filter(Boolean).length + state.failed.length,
      },
    });
    await bumpStatusVersion(db);

    /** Letzte Störung eines Abschnitts; beendet den Lauf und stellt den Auftrag zurück. */
    let deferredBy: string | null = null;
    /** Pause oder Sperre: Lauf endet, der Auftrag geht ohne gezählten Versuch zurück. */
    let haltedBy: QueueHalted["kind"] | null = null;
    const stopRun = () => interrupted() || deferredBy !== null || haltedBy !== null;

    let next = 0;
    const chunkWorker = async () => {
      while (next < pending.length && !stopRun()) {
        const index = pending[next++];
        const chunk = bounds[index];
        const startMs = chunk.startMs;
        // Prompt-Modelle laufen der Reihe nach und erhalten die Sprecher des vorigen Abschnitts.
        const context = direct || index === 0 ? null : chunkContext(state.chunks[index - 1]);
        const prompt = (chunkCount === 1 ? PROMPT : chunkPrompt(index, chunkCount, context)) + vocabularyText;
        let result: NormalizedTranscript | null = null;
        let transientError: string | null = null;
        let invalid = 0;
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !result && !stopRun(); attempt += 1) {
          try {
            let answer: ChunkAnswer;
            if (direct) {
              const audio = await encodeChunk(file, chunk, DIRECT_BITRATE);
              // Wortzeiten kommen schon auf die Gesprächszeit verschoben zurück.
              answer = await throttled(() => requestDirectTranscript(audio, startMs, vocabulary, signal), signal, id);
            } else {
              // Jeder Anlauf mit anderer Bitrate: Eine Wiederholung mit identischer
              // Anfrage blieb in der Messung beim Dienst wiederholt hängen.
              const bitrate = BITRATES[attempt - 1] ?? "12k";
              let audio = (await encodeChunk(file, chunk, bitrate)).toString("base64");
              if (audio.length > MAX_INLINE_CHARS) audio = (await encodeChunk(file, chunk, "10k")).toString("base64");
              answer = await throttled(() => requestTranscript(model, prompt, audio, signal), signal, id);
              answer = { ...answer, transcript: { ...answer.transcript, segments: shiftSegments(answer.transcript.segments, startMs) } };
            }
            // Jede beantwortete Anfrage wird berechnet, auch wenn ein späterer Anlauf sie ersetzt.
            state.usage = addUsage(state.usage ?? EMPTY_USAGE, answer.usage);
            state.modelVersion = answer.modelVersion ?? state.modelVersion ?? null;
            state.corrections = (state.corrections ?? 0) + (answer.corrections ?? 0);
            result = answer.transcript;
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
            if (error instanceof InvalidReplyError) {
              // Berechnet und gezählt; einmal wiederholen, danach Abschnitt offen lassen statt Lücke.
              const billed = (error as InvalidReplyError & { usage?: TokenUsage }).usage;
              if (billed) state.usage = addUsage(state.usage ?? EMPTY_USAGE, billed);
              state.invalidReplies = (state.invalidReplies ?? 0) + 1;
              invalid += 1;
              if (invalid >= 2) {
                transientError = "Das Modell hat zweimal kein gültiges JSON geliefert.";
                break;
              }
              continue;
            }
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
        await bumpStatusVersion(db);
      }
    };
    // Prompt-Modelle nacheinander, damit jeder Abschnitt die Sprecher des vorigen kennt.
    const concurrency = direct ? CHUNK_CONCURRENCY : 1;
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, chunkWorker));
    if (lost) throw new LockLost();
    if (stopping) return await pause();
    if (haltedBy) return await requeueHalted(haltedBy);
    if (deferredBy) return await defer(deferredBy);

    const done = state.chunks.filter((chunk): chunk is NormalizedTranscript => chunk !== null);
    if (background && done.length > 0 && done.every((chunk) => chunk.segments.length === 0)) {
      return await fail("Die Neu-Transkription hat keinen Text ergeben. Das bisherige Transkript bleibt.");
    }
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
      .map((index) => ({ startMs: bounds[index].startMs, endMs: bounds[index].endMs }));

    // Wortzeiten des Modells bleiben; geschätzte Zeiten werden an der Aufnahme ausgerichtet.
    const aligned =
      model.timing === "schaetzung" && (mime === "audio/wav" || mime === "audio/mpeg")
        ? alignTranscript(merged.segments, bytes, mime, { gaps })
        : null;
    const segments = aligned?.segments ?? merged.segments;

    await saveTranscript(db, id, segments, merged.speakerLabels, recording.transcript?.at ?? recording.transcriptionFinishedAt ?? null);
    const endMs = segments.length > 0 ? segments[segments.length - 1].endMs : 0;
    const duration = measuredMs ?? recording.durationMs ?? endMs;
    const at = iso();
    const usage = state.usage ?? EMPTY_USAGE;
    const meta: TranscriptMeta = {
      model: model.id,
      modelVersion: state.modelVersion ?? null,
      timing: model.timing,
      at,
      usage,
      costUsd: costUsd(model, usage),
      audioMs: duration > 0 ? duration : null,
    };
    await db.recordings.updateOne(
      { _id: id },
      [
        {
          $set: {
            speakerCount: merged.speakerLabels.length,
            wordCount: merged.wordCount,
            transcriptionChunks: chunkCount,
            transcriptionGaps: gaps.length > 0 ? gaps : null,
            transcriptionAlignment: aligned || model.timing === "modell" ? "akustisch" : "geschaetzt",
            ...(duration > 0 ? { durationMs: duration } : {}),
            transcript: { $literal: meta },
            // Bisheriges Transkript in die Historie; fehlt seine Herkunft, war es gemini-2.5-flash.
            transcriptHistory: previousTranscripts(recording),
          },
        },
      ],
    );
    await db.runs.insertOne({
      _id: `${id}:${at}`,
      recordingId: id,
      model: model.id,
      modelVersion: meta.modelVersion,
      kind: "transkription",
      background,
      at,
      audioMs: meta.audioMs,
      usage,
      costUsd: meta.costUsd ?? 0,
      invalidReplies: state.invalidReplies ?? 0,
    });
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

/** Bisherige Einträge plus das abgelöste Transkript als Wert für `$set` (Aggregations-Pipeline). */
function previousTranscripts(recording: RecordingDoc): unknown {
  const status = recording.transcriptionStatus;
  const replaced =
    recording.transcript ??
    (status === "abgeschlossen" ? legacyTranscriptMeta(recording.transcriptionFinishedAt ?? null, recording.durationMs) : null);
  const history = { $ifNull: ["$transcriptHistory", []] };
  if (!replaced) return history;
  return { $slice: [{ $concatArrays: [history, [{ $literal: replaced }]] }, -TRANSCRIPT_HISTORY_MAX] };
}

/**
 * Bestimmt die Zeiten eines vorhandenen Transkripts neu (Forced Alignment),
 * ohne Anfrage an den Dienst. Transkripte mit Wortzeiten des Modells bleiben,
 * wie sie sind.
 */
async function retimeTranscript(db: Db, recording: RecordingDoc, bytes: Uint8Array): Promise<string> {
  if (recording.transcript?.timing === "modell") return "Wortzeiten des Modells, nicht neu ausgerichtet";
  const parts = await db.parts
    .find({ recordingId: recording._id } as Record<string, unknown>)
    .toArray() as unknown as { partIndex: number; segments: TranscriptSegment[] }[];
  const segments = parts.sort((a, b) => a.partIndex - b.partIndex).flatMap((part) => part.segments ?? []);
  if (segments.length === 0) throw new PermanentError("Kein Transkript vorhanden, das neu ausgerichtet werden kann.");
  const mime = recording.mimeType as AudioMime;
  const aligned =
    mime === "audio/wav" || mime === "audio/mpeg"
      ? alignTranscript(segments, bytes, mime, {
          gaps: recording.transcriptionGaps ?? [],
        })
      : null;
  if (!aligned) throw new PermanentError("Die Aufnahme trägt zu wenig verwertbare Sprache für eine Ausrichtung.");
  const labels = [...new Set(aligned.segments.map((segment) => segment.speakerLabel))];
  await saveTranscript(db, recording._id, aligned.segments, labels);
  const meta = recording.transcript ?? legacyTranscriptMeta(recording.transcriptionFinishedAt ?? null, recording.durationMs);
  await db.recordings.updateOne(
    { _id: recording._id },
    { $set: { transcriptionAlignment: "akustisch", transcript: { ...meta, retimedAt: iso() } } },
  );
  return `neu ausgerichtet, ${aligned.regionCount} Sprachbereiche`;
}

/**
 * Gleiche Ablage wie `saveTranscript` in `src/lib/transcription.ts`. Ersetzt
 * eine neue Transkription ein vorhandenes Transkript, wird dessen Text samt
 * Zeiten vorher nach `transcript_history_parts` kopiert (`replacedAt` setzt
 * die Fassung mit ihrem Eintrag in `transcriptHistory` in Beziehung).
 */
async function saveTranscript(
  db: Db,
  recordingId: string,
  segments: TranscriptSegment[],
  speakerLabels: string[],
  archiveVersion?: string | null,
) {
  if (archiveVersion !== undefined) {
    const replacedAt = iso();
    const old = await db.parts.find({ recordingId } as Record<string, unknown>).toArray();
    for (const part of old) {
      await db.historyParts.replaceOne(
        { _id: `${part._id}@${archiveVersion ?? replacedAt}` },
        { ...part, _id: `${part._id}@${archiveVersion ?? replacedAt}`, partId: part._id, version: archiveVersion, replacedAt },
        { upsert: true },
      );
    }
  }
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
    // Platz 1 bleibt für neue Uploads frei, sobald es mehr als einen Platz gibt;
    // nachrangige Neu-Transkriptionen laufen nur auf den übrigen Plätzen.
    const allowBackground = index > 0 || current.jobsPerInstance === 1;
    let job: JobDoc | null;
    try {
      job = await claimNext(db, lockId, newestFirst, allowBackground);
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
  await bumpStatusVersion(db);
  log(`${ids.length} wegen vorübergehender Fehler beendete Aufträge wieder eingereiht.`);
}

async function main() {
  env("CLAWCORP_API_KEY");
  log(hasDirectKey() ? "Gemini API direkt: eingerichtet." : "Gemini API direkt: nicht eingerichtet, gemini-3.5-transcribe nicht verfügbar.");
  const client = await new MongoClient(env("MONGODB_URI"), { maxPoolSize: 5 }).connect();
  const database = client.db();
  const db: Db = {
    jobs: database.collection<JobDoc>("jobs"),
    recordings: database.collection<RecordingDoc>("recordings"),
    parts: database.collection("transcript_parts"),
    historyParts: database.collection(HISTORY_PARTS_COLLECTION),
    index: database.collection("transcript_index"),
    workers: database.collection<WorkerDoc>(WORKERS_COLLECTION),
    limiter: database.collection<LimiterDoc>(LIMITER_COLLECTION),
    settings: database.collection(STATUS_VERSION_COLLECTION),
    config: database.collection<TranscriptionSettings>(STATUS_VERSION_COLLECTION),
    runs: database.collection<RunDoc>(RUNS_COLLECTION),
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
        // Die Anwendung reiht nachrangige Aufträge erst ein, wenn jede laufende Instanz sie kennt.
        features: WORKER_FEATURES,
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
