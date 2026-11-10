import "server-only";
import {
  aggregate,
  Collections,
  countDocuments,
  deleteMany,
  findById,
  findMany,
  insertMany,
  updateOne,
  upsertById,
} from "./db";
import { alignTranscript } from "../../transcriber/shared/forced-alignment";
import {
  HEARTBEAT_MS,
  LIMITER_COLLECTION,
  LIMITER_ID,
  SETTINGS_LIMITS,
  STALE_LOCK_MS,
  WORKERS_COLLECTION,
  activeBlock,
  claimableFilter,
  effectiveConcurrency,
  iso,
  lockIsFresh,
  queuePosition,
  scheduledRetryFilter,
  type LimiterDoc,
  type ProgressFields,
  type QueueErrorEntry,
  type QueueSettings,
  type SpendingBlock,
} from "../../transcriber/shared/queue";
import { buildTranscriptIndex, splitIntoParts } from "../../transcriber/shared/transcript";
import { readFileBytes } from "./storage";
import { invalidateRecordingCache } from "./recordings";
import { cetDayStartUtcIso } from "./time";
import type { JobFilterValues, JobSortKey } from "./job-filter";
import type { Job, QueueHalt, Recording, TranscriptPartDoc, TranscriptSegment, TranscriptionStatus } from "./types";

/**
 * Transkription aus Sicht der Anwendung: Aufträge einreihen, Transkripte
 * lesen und den Zustand der Warteschlange anzeigen. Abgearbeitet wird die
 * Warteschlange ausschliesslich vom Transkriptionsdienst (`transcriber/`).
 */

const TRANSFER_TIMEOUT_MS = 60 * 1000;

export async function saveTranscript(
  recordingId: string,
  segments: TranscriptSegment[],
  speakerLabels: string[],
): Promise<void> {
  await deleteMany(Collections.transcriptParts, { recordingId });
  const parts = splitIntoParts(recordingId, segments);
  for (const part of parts) {
    await insertMany(Collections.transcriptParts, [part as unknown as Record<string, unknown> & { _id: string }]);
  }

  const index = buildTranscriptIndex(recordingId, segments, speakerLabels);
  await upsertById(Collections.transcriptIndex, recordingId, index as unknown as Record<string, unknown>);
}

export async function loadTranscript(recordingId: string): Promise<TranscriptSegment[]> {
  const parts = await findMany<TranscriptPartDoc>(Collections.transcriptParts, { recordingId });
  return parts
    .sort((a, b) => a.partIndex - b.partIndex)
    .flatMap((part) => part.segments ?? []);
}

/**
 * Richtet ein bereits vorhandenes Transkript neu an seiner Aufnahme aus.
 *
 * Das kostet keinen Aufruf des Transkriptionsdienstes – der Text bleibt, nur
 * die Zeiten werden ersetzt. Gedacht für Transkripte, die vor der Einführung
 * der Ausrichtung entstanden sind.
 */
export async function realignRecording(
  recordingId: string,
): Promise<{ ok: boolean; message: string }> {
  const recording = await findById<Recording>(Collections.recordings, recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  const segments = await loadTranscript(recordingId);
  if (segments.length === 0) return { ok: false, message: "Kein Transkript vorhanden." };

  const bytes = await readFileBytes(recording.audioUrl, { timeoutMs: TRANSFER_TIMEOUT_MS });
  const aligned = alignTranscript(segments, bytes, recording.mimeType, {
    gaps: recording.transcriptionGaps ?? [],
  });
  if (!aligned) return { ok: false, message: "Die Aufnahme trägt zu wenig verwertbare Sprache." };

  const speakerLabels = [...new Set(aligned.segments.map((segment) => segment.speakerLabel))];
  await saveTranscript(recordingId, aligned.segments, speakerLabels);
  await updateOne(
    Collections.recordings,
    { _id: recordingId },
    { $set: { transcriptionAlignment: "akustisch" } },
  );
  await invalidateRecordingCache();

  return {
    ok: true,
    message: `${aligned.speechMs} ms Sprache in ${aligned.regionCount} Abschnitten.`,
  };
}

/**
 * Setzt einen Auftrag auf „wartend“ zurück und gibt alle Versuche wieder frei.
 * Eine nachrangige Neu-Transkription (`background`) bleibt nachrangig und lässt
 * die Aufnahme samt bisherigem Transkript unverändert.
 */
export async function resetJob(recordingId: string, options: { background?: boolean } = {}): Promise<void> {
  await updateOne(
    Collections.jobs,
    { _id: recordingId },
    {
      $set: {
        status: "wartend",
        attempts: 0,
        lastError: null,
        lockedAt: null,
        // Ohne `lockId` bemerkt ein Dienst, der den Auftrag noch hält, dass er
        // ihn verloren hat, und bricht ab.
        lockId: null,
        workerId: null,
        startedAt: null,
        finishedAt: null,
        nextAttemptAt: null,
        // Zwischenstand des Transkriptionsdienstes (`transcriber/`) verwerfen.
        progress: null,
        progressDone: null,
        progressTotal: null,
        progressAt: null,
        progressRunAt: null,
        progressRunDone: null,
        paused: null,
        permanent: null,
        staleClaims: 0,
        usedModel: null,
        ...(options.background ? {} : { background: null, kind: null, model: null }),
      },
    },
  );
  if (options.background) {
    await invalidateRecordingCache();
    return;
  }
  await updateOne(
    Collections.recordings,
    { _id: recordingId },
    {
      $set: {
        transcriptionStatus: "wartend",
        transcriptionError: null,
        transcriptionAttempts: 0,
        transcriptionFinishedAt: null,
        transcriptionNextAttemptAt: null,
        transcriptionGaps: null,
      },
    },
  );
  await invalidateRecordingCache();
}

/* ------------------------------------------------------------ Laufender Stand für die Anzeige */

/** Fortschritt laufender Aufträge, ohne die gespeicherten Teiltranskripte zu laden. */
export type JobProgress = ProgressFields & {
  /** Letzter gesicherter Abschnitt, sonst Beginn des Laufs. */
  updatedAt: string | null;
  /** Letztes Lebenszeichen des Auftrags (`lockedAt`, alle 30 s erneuert). */
  heartbeatAt: string | null;
  startedAt: string | null;
};

const PROGRESS_PROJECTION = {
  progressDone: 1, progressTotal: 1, progressAt: 1, progressRunAt: 1, progressRunDone: 1,
  startedAt: 1, lockedAt: 1,
} as const;

type ProgressDoc = Job & Partial<ProgressFields>;

/** BSON-Datum (frühere Aufträge) oder ISO-Text als ISO-Text. */
function isoOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export function toJobProgress(job: ProgressDoc): JobProgress {
  const lockedAt = isoOf(job.lockedAt);
  return {
    progressDone: job.progressDone ?? null,
    progressTotal: job.progressTotal ?? null,
    progressAt: job.progressAt ?? null,
    progressRunAt: job.progressRunAt ?? null,
    progressRunDone: job.progressRunDone ?? null,
    updatedAt: job.progressAt ?? job.startedAt ?? lockedAt,
    heartbeatAt: lockedAt,
    startedAt: job.startedAt ?? null,
  };
}

export async function jobProgress(ids: string[]): Promise<Map<string, JobProgress>> {
  if (ids.length === 0) return new Map();
  const jobs = await findMany<ProgressDoc>(
    Collections.jobs,
    { _id: { $in: ids.slice(0, 100) } },
    { projection: PROGRESS_PROJECTION },
  );
  return new Map(jobs.map((job) => [job._id, toJobProgress(job)]));
}

/**
 * Ungefähre Position eines wartenden, sofort fälligen Auftrags (siehe
 * `queuePosition`); `null`, wenn er nicht (mehr) sofort fällig wartet.
 */
export async function waitingPosition(recordingId: string): Promise<number | null> {
  const job = await findById<Job>(Collections.jobs, recordingId);
  if (!job || job.status !== "wartend") return null;
  const now = iso();
  if (job.nextAttemptAt && job.nextAttemptAt > now) return null;
  const due = { status: "wartend", $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] };
  const priority = job.priority ?? 0;
  const samePriority = priority > 0 ? { priority } : { $or: [{ priority: null }, { priority: { $lte: 0 } }] };
  const [prioritizedAhead, older, newer] = await Promise.all([
    countDocuments(Collections.jobs, { ...due, priority: { $gt: priority } }),
    countDocuments(Collections.jobs, { $and: [due, samePriority, { createdAt: { $lt: job.createdAt } }] }),
    countDocuments(Collections.jobs, { $and: [due, samePriority, { createdAt: { $gt: job.createdAt } }] }),
  ]);
  return queuePosition({ prioritizedAhead, older, newer });
}

export type LiveDetail = {
  status: TranscriptionStatus;
  error: string | null;
  nextAttemptAt: string | null;
  progress: JobProgress | null;
  /** Ungefähre Position eines sofort fälligen wartenden Auftrags. */
  position: number | null;
  halt: QueueHalt;
  /** Uhrzeit des Servers; gleicht eine abweichende Uhr im Browser aus. */
  serverNow: number;
};

/** Stand einer Aufnahme für die Fortschrittsanzeige, ohne Zwischenspeicher. */
export async function liveDetail(row: Recording): Promise<LiveDetail> {
  const id = row._id;
  const waiting = row.transcriptionStatus === "wartend";
  const [progress, position, halt] = await Promise.all([
    jobProgress(waiting || row.transcriptionStatus === "in_arbeit" ? [id] : []),
    waiting ? waitingPosition(id) : Promise.resolve(null),
    waiting ? queueHalt() : Promise.resolve(null),
  ]);
  return {
    status: row.transcriptionStatus,
    error: row.transcriptionError,
    nextAttemptAt: row.transcriptionNextAttemptAt ?? null,
    progress: progress.get(id) ?? null,
    position,
    halt,
    serverNow: Date.now(),
  };
}

/* ------------------------------------------------------------ Neustart durch Nutzende */

export type RequeueState = "gestartet" | "laeuft" | "fehler";
export type RequeueResult = { ok: boolean; message: string; state: RequeueState };

/**
 * Reiht die Transkription einer Aufnahme neu ein. Der Aufruf ist idempotent:
 * Läuft oder wartet der Auftrag bereits, wird er nicht ein zweites Mal
 * eingereiht, damit ein Doppelklick keinen doppelten Lauf erzeugt.
 */
export async function requeueTranscription(
  recordingId: string,
  options: { allowCompleted?: boolean } = {},
): Promise<RequeueResult> {
  const recording = await findById<Recording>(Collections.recordings, recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden.", state: "fehler" };

  const job = await findById<Job>(Collections.jobs, recordingId);

  if (job && job.status === "in_arbeit" && lockIsFresh(job.lockedAt)) {
    return { ok: true, message: "Die Transkription läuft bereits.", state: "laeuft" };
  }
  if (job && job.status === "wartend") {
    return { ok: true, message: "Der Auftrag steht bereits in der Warteschlange.", state: "laeuft" };
  }
  // Ein lückenhaftes Transkript darf jederzeit neu erstellt werden: Der zweite
  // Anlauf kann die fehlenden Abschnitte liefern.
  const incomplete = (recording.transcriptionGaps?.length ?? 0) > 0;
  if (job && job.status === "abgeschlossen" && !options.allowCompleted && !incomplete) {
    return {
      ok: false,
      message: "Für diese Aufnahme liegt bereits ein Transkript vor.",
      state: "fehler",
    };
  }

  if (job) {
    await resetJob(recordingId);
  } else {
    await upsertById(Collections.jobs, recordingId, {
      recordingId,
      type: "transkription",
      status: "wartend",
      attempts: 0,
      lastError: null,
      createdAt: recording.uploadedAt ?? new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      lockedAt: null,
      nextAttemptAt: null,
      originalFilename: recording.originalFilename,
    });
    await updateOne(
      Collections.recordings,
      { _id: recordingId },
      {
        $set: {
          transcriptionStatus: "wartend",
          transcriptionError: null,
          transcriptionAttempts: 0,
          transcriptionFinishedAt: null,
          transcriptionNextAttemptAt: null,
        },
      },
    );
    await invalidateRecordingCache();
  }

  return { ok: true, message: "Die Transkription wurde neu eingereiht.", state: "gestartet" };
}

/* ------------------------------------------------------------ Zustand des Dienstes */

export type WorkerHealth = {
  id: string;
  host: string;
  concurrency: number;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  activeJobs: string[];
  processed: number;
  failed: number;
  deferred?: number;
  /** Gemeldete Fähigkeiten (`REQUIRED_WORKER_FEATURES`); fehlt bei älteren Fassungen. */
  features?: string[];
  /** Lebenszeichen innerhalb von drei Intervallen und nicht beendet. */
  alive: boolean;
};

export type QueueHealth = {
  workers: WorkerHealth[];
  lastHeartbeatAt: string | null;
  /** Sofort übernehmbar: wartend, verwaist oder fällige Wiederholung. */
  queued: number;
  running: number;
  retryScheduled: number;
  doneLastHour: number;
  failedLastHour: number;
  limiter: LimiterHealth | null;
};

/** Zustand der gemeinsamen Drossel für Anfragen an den Transkriptionsdienst. */
export type LimiterHealth = {
  maxConcurrent: number;
  /** Nach einer Störung vorübergehend nur eine Anfrage zugleich. */
  allowedNow: number;
  running: number;
  minGapMs: number;
  pausedUntil: string | null;
  lastPauseReason: string | null;
  /** Abgeschlossene Anfragen pro Minute, gemittelt über zehn Minuten. */
  perMinute: number;
  failedLast10Min: number;
  /** Mittlere Dauer erfolgreicher Anfragen der letzten zehn Minuten. */
  avgMs: number | null;
};

async function limiterHealth(now: number): Promise<LimiterHealth | null> {
  const doc = await findById<LimiterDoc>(LIMITER_COLLECTION, LIMITER_ID);
  if (!doc) return null;
  const since = iso(now - 10 * 60 * 1000);
  const recent = (doc.recent ?? []).filter((event) => event.at >= since);
  const ok = recent.filter((event) => event.ok);
  return {
    maxConcurrent: doc.maxConcurrent,
    allowedNow: effectiveConcurrency(doc),
    running: (doc.leases ?? []).filter((lease) => lease.expiresAt > iso(now)).length,
    minGapMs: doc.minGapMs,
    pausedUntil: doc.pausedUntil && doc.pausedUntil > iso(now) ? doc.pausedUntil : null,
    lastPauseReason: doc.lastPauseReason ?? null,
    perMinute: recent.length / 10,
    failedLast10Min: recent.length - ok.length,
    avgMs: ok.length > 0 ? ok.reduce((sum, event) => sum + event.ms, 0) / ok.length : null,
  };
}

type WorkerDoc = Omit<WorkerHealth, "id" | "alive">;

/** Zustand der Warteschlange und der Transkriptionsdienste für das Admin-Dashboard. */
export async function queueHealth(): Promise<QueueHealth> {
  const now = Date.now();
  const hourAgo = iso(now - 60 * 60 * 1000);
  const dayAgo = iso(now - 24 * 60 * 60 * 1000);
  const [workerDocs, queued, running, retryScheduled, doneLastHour, failedLastHour, limiter] =
    await Promise.all([
      findMany<WorkerDoc>(WORKERS_COLLECTION, { lastHeartbeatAt: { $gte: dayAgo } }),
      countDocuments(Collections.jobs, claimableFilter(now)),
      countDocuments(Collections.jobs, {
        status: "in_arbeit",
        lockedAt: { $gte: iso(now - STALE_LOCK_MS) },
      }),
      countDocuments(Collections.jobs, scheduledRetryFilter(now)),
      countDocuments(Collections.jobs, {
        status: { $in: ["abgeschlossen", "ohne_sprache"] },
        finishedAt: { $gte: hourAgo },
      }),
      countDocuments(Collections.jobs, { status: "fehlgeschlagen", finishedAt: { $gte: hourAgo } }),
      limiterHealth(now),
    ]);

  const aliveSince = iso(now - 3 * HEARTBEAT_MS);
  const workers = workerDocs
    .map(({ _id, ...doc }) => ({
      ...doc,
      id: _id,
      alive: !doc.stoppedAt && doc.lastHeartbeatAt >= aliveSince,
    }))
    .sort((a, b) => b.lastHeartbeatAt.localeCompare(a.lastHeartbeatAt));

  return {
    workers,
    lastHeartbeatAt: workers[0]?.lastHeartbeatAt ?? null,
    queued,
    running,
    retryScheduled,
    doneLastHour,
    failedLastHour,
    limiter,
  };
}

/* ------------------------------------------------------------ Steuerung durch den Admin */

/**
 * Pause, Sperre und Grenzen liegen im Dokument der gemeinsamen Drossel, das
 * der Transkriptionsdienst bei jeder Anfrage atomar prüft. Jede Änderung
 * erhöht `controlVersion`; daran erkennen alle Instanzen sie sofort.
 */
async function updateControl(update: Record<string, unknown>): Promise<void> {
  const { matched } = await updateOne(LIMITER_COLLECTION, { _id: LIMITER_ID }, {
    ...update,
    $inc: { controlVersion: 1 },
  });
  if (matched === 0) {
    await upsertById(LIMITER_COLLECTION, LIMITER_ID, { leases: [], recent: [], controlVersion: 0 });
    await updateOne(LIMITER_COLLECTION, { _id: LIMITER_ID }, { ...update, $inc: { controlVersion: 1 } });
  }
}

/** Zustand für die Anzeige bei wartenden Aufnahmen; `null`, wenn die Warteschlange läuft. */
export async function queueHalt(): Promise<QueueHalt> {
  const doc = await findById<LimiterDoc>(LIMITER_COLLECTION, LIMITER_ID);
  const block = activeBlock(doc);
  if (block) return { kind: "gesperrt", since: block.startedAt, until: block.until };
  if (doc?.manualPause) return { kind: "pausiert", since: doc.manualPause.at };
  return null;
}

export async function setQueuePaused(paused: boolean, by: string): Promise<void> {
  await updateControl({ $set: { manualPause: paused ? { at: iso(), by } : null } });
}

/** Hebt die Sperre nach dem Kostenlimit auf; die Arbeit beginnt sofort wieder. */
export async function liftSpendingBlock(by: string): Promise<boolean> {
  const doc = await findById<LimiterDoc>(LIMITER_COLLECTION, LIMITER_ID);
  const block = activeBlock(doc);
  if (!block) return false;
  await updateControl({
    $set: { spendingBlock: null, lastBlock: { ...block, liftedAt: iso(), liftedBy: by } },
  });
  return true;
}

export type SettingsInput = { maxConcurrent: number; minGapSeconds: number; jobsPerInstance: number };

export async function saveQueueSettings(
  input: SettingsInput,
  by: string,
): Promise<{ ok: boolean; message: string }> {
  const values = {
    maxConcurrent: Number(input.maxConcurrent),
    minGapMs: Math.round(Number(input.minGapSeconds) * 1000),
    jobsPerInstance: Number(input.jobsPerInstance),
  };
  const labels = {
    maxConcurrent: "Gleichzeitige Anfragen",
    minGapMs: "Mindestabstand",
    jobsPerInstance: "Aufträge je Instanz",
  };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    const { min, max } = SETTINGS_LIMITS[key];
    const value = values[key];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      const range = key === "minGapMs" ? `${min / 1000} bis ${max / 1000} s` : `${min} bis ${max}`;
      return { ok: false, message: `${labels[key]}: erlaubt sind ${range}.` };
    }
  }
  const settings: QueueSettings = { ...values, updatedAt: iso(), updatedBy: by };
  await updateControl({ $set: { settings } });
  return { ok: true, message: "Grenzen gespeichert. Sie gelten ab der nächsten Anfrage." };
}

/** Wartenden Auftrag sofort fällig machen und vor alle anderen stellen. */
export async function moveJobToFront(recordingId: string): Promise<{ ok: boolean; message: string }> {
  const { matched } = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "wartend" },
    { $set: { priority: Date.now(), nextAttemptAt: null } },
  );
  if (matched === 0) return { ok: false, message: "Der Auftrag wartet nicht mehr." };
  await updateOne(Collections.recordings, { _id: recordingId }, { $set: { transcriptionNextAttemptAt: null } });
  await invalidateRecordingCache();
  return { ok: true, message: "Steht jetzt an erster Stelle." };
}

/**
 * Wiederholen: Ein wartender Auftrag mit geplantem Versuch wird sofort fällig,
 * alle anderen werden neu eingereiht (auch abgeschlossene).
 */
export async function retryJobNow(recordingId: string): Promise<RequeueResult> {
  const { matched } = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "wartend", nextAttemptAt: { $ne: null } },
    { $set: { nextAttemptAt: null } },
  );
  if (matched > 0) {
    await updateOne(Collections.recordings, { _id: recordingId }, { $set: { transcriptionNextAttemptAt: null } });
    await invalidateRecordingCache();
    return { ok: true, message: "Der nächste Versuch ist sofort fällig.", state: "gestartet" };
  }
  return requeueTranscription(recordingId, { allowCompleted: true });
}

/** Reiht alle fehlgeschlagenen Aufträge neu ein; liefert die Anzahl. */
export async function requeueAllFailed(): Promise<number> {
  const failed = await findMany<Job>(Collections.jobs, { status: "fehlgeschlagen" }, { projection: { _id: 1, background: 1 } });
  for (const job of failed) await resetJob(job._id, { background: !!job.background });
  return failed.length;
}

/* ------------------------------------------------------------ Übersicht für das Dashboard */

export type QueueJobRow = Pick<
  Job,
  "_id" | "status" | "attempts" | "lastError" | "createdAt" | "startedAt" | "finishedAt" | "nextAttemptAt" | "originalFilename" | "priority" | "model" | "kind" | "background"
> & { progress: JobProgress };

export type QueueOverview = {
  counts: Record<TranscriptionStatus, number>;
  oldestWaiting: QueueJobRow | null;
  /** Laufend, dann wartend in der Reihenfolge der Übernahme (Vorrang, dann älteste zuerst). */
  waiting: QueueJobRow[];
  /** Geplante Wiederholungen, früheste zuerst. */
  nextAttempts: QueueJobRow[];
  errors: (QueueErrorEntry & { filename: string | null })[];
  manualPause: { at: string; by: string } | null;
  spendingBlock: SpendingBlock | null;
  lastBlock: (SpendingBlock & { liftedAt: string; liftedBy: string }) | null;
  /** Gespeicherte Grenzen; `null` = Standardwerte des Dienstes. */
  settings: QueueSettings | null;
  /** Aktuell angewandte Werte (gespeichert oder Standard des Dienstes). */
  effective: { maxConcurrent: number; minGapMs: number; jobsPerInstance: number };
  /** In der letzten Stunde fertig gewordene Aufnahmen und ihre Gesprächsdauer. */
  throughput: { recordings: number; audioMs: number };
};

const JOB_FIELDS = {
  ...PROGRESS_PROJECTION,
  status: 1, attempts: 1, lastError: 1, createdAt: 1, startedAt: 1, finishedAt: 1,
  nextAttemptAt: 1, originalFilename: 1, priority: 1, model: 1, kind: 1, background: 1,
} as const;

type JobRowDoc = Omit<QueueJobRow, "progress"> & Partial<ProgressFields> & { lockedAt?: unknown };

function toJobRows(docs: JobRowDoc[]): QueueJobRow[] {
  return docs.map((doc) => ({
    _id: doc._id,
    status: doc.status,
    attempts: doc.attempts,
    lastError: doc.lastError,
    createdAt: doc.createdAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    nextAttemptAt: doc.nextAttemptAt,
    originalFilename: doc.originalFilename,
    priority: doc.priority,
    model: doc.model ?? null,
    kind: doc.kind ?? null,
    background: doc.background ?? null,
    progress: toJobProgress(doc as unknown as ProgressDoc),
  }));
}

export async function queueOverview(health: QueueHealth): Promise<QueueOverview> {
  const statuses: TranscriptionStatus[] = ["wartend", "in_arbeit", "abgeschlossen", "ohne_sprache", "fehlgeschlagen"];
  const now = iso();
  const [countList, waiting, nextAttempts, oldest, doc, finishedLastHour] = await Promise.all([
    Promise.all(statuses.map((status) => countDocuments(Collections.jobs, { status }))),
    findMany<JobRowDoc>(Collections.jobs, { status: { $in: ["in_arbeit", "wartend"] } }, {
      projection: JOB_FIELDS, sort: { status: 1, background: 1, priority: -1, createdAt: 1 }, limit: 25,
    }),
    findMany<JobRowDoc>(Collections.jobs, { status: "wartend", nextAttemptAt: { $gt: now } }, {
      projection: JOB_FIELDS, sort: { nextAttemptAt: 1 }, limit: 10,
    }),
    findMany<JobRowDoc>(Collections.jobs, { status: "wartend" }, {
      projection: JOB_FIELDS, sort: { createdAt: 1 }, limit: 1,
    }),
    findById<LimiterDoc & { lastBlock?: QueueOverview["lastBlock"] }>(LIMITER_COLLECTION, LIMITER_ID),
    findMany<Recording>(
      Collections.recordings,
      {
        transcriptionStatus: { $in: ["abgeschlossen", "ohne_sprache"] },
        transcriptionFinishedAt: { $gte: iso(Date.now() - 60 * 60 * 1000) },
      },
      { projection: { durationMs: 1 } },
    ),
  ]);

  const rawErrors = [...(doc?.errors ?? [])].reverse().slice(0, 25);
  const ids = [...new Set(rawErrors.map((entry) => entry.recordingId).filter((id): id is string => !!id))];
  const names = new Map(
    (ids.length > 0
      ? await findMany<Recording>(Collections.recordings, { _id: { $in: ids } }, { projection: { originalFilename: 1 } })
      : []
    ).map((recording) => [recording._id, recording.originalFilename]),
  );

  const alive = health.workers.filter((worker) => worker.alive);
  return {
    counts: Object.fromEntries(statuses.map((status, index) => [status, countList[index]])) as Record<TranscriptionStatus, number>,
    oldestWaiting: toJobRows(oldest)[0] ?? null,
    waiting: toJobRows(waiting),
    nextAttempts: toJobRows(nextAttempts),
    errors: rawErrors.map((entry) => ({ ...entry, filename: entry.recordingId ? names.get(entry.recordingId) ?? null : null })),
    manualPause: doc?.manualPause ?? null,
    spendingBlock: activeBlock(doc),
    lastBlock: doc?.lastBlock ?? null,
    settings: doc?.settings ?? null,
    effective: {
      maxConcurrent: doc?.settings?.maxConcurrent ?? doc?.maxConcurrent ?? 2,
      minGapMs: doc?.settings?.minGapMs ?? doc?.minGapMs ?? 4000,
      jobsPerInstance: doc?.settings?.jobsPerInstance ?? alive[0]?.concurrency ?? 2,
    },
    throughput: {
      recordings: finishedLastHour.length,
      audioMs: finishedLastHour.reduce((sum, row) => sum + (row.durationMs ?? 0), 0),
    },
  };
}

/* ------------------------------------------------------------ Auftragstabelle (alle Aufträge) */

export type JobListRow = QueueJobRow & {
  uploaderName: string | null;
  /** Verwendetes Modell; vor dem ersten Lauf das für den Auftrag gewählte. */
  modelUsed: string | null;
};

export type JobList = {
  rows: JobListRow[];
  total: number;
  totalAll: number;
  page: number;
  pageSize: number;
  pageCount: number;
  uploaders: { email: string; name: string }[];
  models: string[];
};

const STATUS_RANK = ["in_arbeit", "wartend", "fehlgeschlagen", "abgeschlossen", "ohne_sprache"];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bereich auf einem ISO-Textfeld aus zwei Kalendertagen (CET). */
function dayRange(von: string, bis: string): Record<string, string> | null {
  const range: Record<string, string> = {};
  const from = von ? cetDayStartUtcIso(von) : null;
  const to = bis ? cetDayStartUtcIso(bis, true) : null;
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return Object.keys(range).length > 0 ? range : null;
}

const JOB_SORT_FIELDS: Record<JobSortKey, string> = {
  datei: "_fileKey",
  status: "_statusRank",
  erstellt: "createdAt",
  gestartet: "startedAt",
  beendet: "finishedAt",
  versuche: "_attempts",
  meldung: "lastError",
};

/**
 * Alle Aufträge, direkt aus der Auftragssammlung gelesen (kein
 * Zwischenspeicher): gefiltert, sortiert und geblättert in der Datenbank.
 * Ohne gewählte Sortierung: laufend, dann wartend in Bearbeitungsreihenfolge
 * (sofort fällige nach Vorrang und Alter, danach geplante nach Zeitpunkt),
 * dann die neusten.
 */
export async function listJobs(values: JobFilterValues): Promise<JobList> {
  const now = iso();
  const match: Record<string, unknown>[] = [];
  if (values.status.length > 0) match.push({ status: { $in: values.status } });
  if (values.datei) match.push({ originalFilename: { $regex: escapeRegex(values.datei), $options: "i" } });
  if (values.uploader) match.push({ _uploaderEmail: values.uploader });
  for (const [field, von, bis] of [
    ["createdAt", values.erstelltVon, values.erstelltBis],
    ["startedAt", values.gestartetVon, values.gestartetBis],
    ["finishedAt", values.beendetVon, values.beendetBis],
  ] as const) {
    const range = dayRange(von, bis);
    if (range) match.push({ [field]: range });
  }
  if (values.versucheMin) match.push({ _attempts: { $gte: Number(values.versucheMin) } });
  if (values.meldung) match.push({ lastError: { $nin: [null, ""] } });
  if (values.modell) match.push({ _model: values.modell });
  const filter = match.length > 0 ? { $and: match } : {};

  let order: Record<string, unknown>[];
  if (values.sort) {
    const field = JOB_SORT_FIELDS[values.sort.key];
    const dir = values.sort.dir === "asc" ? 1 : -1;
    order = [
      // Fehlende Werte stehen in beiden Richtungen am Ende.
      { $addFields: { _missing: { $cond: [{ $in: [{ $ifNull: [`$${field}`, null] }, [null, ""]] }, 1, 0] } } },
      { $sort: { _missing: 1, [field]: dir, createdAt: -1, _id: 1 } },
    ];
  } else {
    const waiting = { $eq: ["$status", "wartend"] };
    const scheduled = { $and: [waiting, { $gt: [{ $ifNull: ["$nextAttemptAt", ""] }, now] }] };
    const open = { $in: ["$status", ["wartend", "in_arbeit"]] };
    order = [
      {
        $addFields: {
          _group: {
            $switch: {
              branches: [
                { case: { $eq: ["$status", "in_arbeit"] }, then: 0 },
                { case: waiting, then: 1 },
              ],
              default: 2,
            },
          },
          _scheduled: { $cond: [scheduled, 1, 0] },
          _nextAt: { $cond: [scheduled, "$nextAttemptAt", null] },
          _background: { $cond: [{ $and: [open, { $eq: ["$background", true] }] }, 1, 0] },
          _priority: { $cond: [open, { $ifNull: ["$priority", 0] }, 0] },
          _openSince: { $cond: [open, { $ifNull: ["$startedAt", "$createdAt"] }, null] },
          _recent: { $cond: [open, null, { $ifNull: ["$finishedAt", "$createdAt"] }] },
        },
      },
      {
        $sort: {
          _group: 1, _scheduled: 1, _nextAt: 1, _background: 1, _priority: -1, _openSince: 1,
          _recent: -1, createdAt: -1, _id: 1,
        },
      },
    ];
  }

  const pageSize = Number(values.pageSize);
  type Facet = {
    rows: (JobRowDoc & { _uploaderName?: string | null; _model?: string | null })[];
    total: { n: number }[];
    totalAll: { n: number }[];
    uploaders: { _id: string | null; name: string | null }[];
    models: { _id: string | null }[];
  };
  const pipeline = (skip: number) => [
    {
      $lookup: {
        from: Collections.recordings,
        localField: "_id",
        foreignField: "_id",
        as: "_rec",
        pipeline: [{ $project: { uploadedByEmail: 1, uploadedByName: 1, "transcript.model": 1 } }],
      },
    },
    {
      $addFields: {
        _uploaderEmail: { $first: "$_rec.uploadedByEmail" },
        _uploaderName: { $first: "$_rec.uploadedByName" },
        // Das verwendete Modell: vom Dienst vermerkt, sonst aus dem laufenden
        // Zwischenstand oder dem fertigen Transkript, vor dem ersten Lauf das gewählte.
        _model: {
          $ifNull: [
            "$usedModel",
            "$progress.model",
            {
              $cond: [
                { $in: ["$status", ["abgeschlossen", "ohne_sprache"]] },
                { $first: "$_rec.transcript.model" },
                null,
              ],
            },
            "$model",
          ],
        },
        _statusRank: { $indexOfArray: [STATUS_RANK, "$status"] },
        _fileKey: { $toLower: { $ifNull: ["$originalFilename", ""] } },
        _attempts: { $ifNull: ["$attempts", 0] },
      },
    },
    {
      $facet: {
        rows: [
          { $match: filter },
          ...order,
          { $skip: skip },
          { $limit: pageSize },
          { $project: { ...JOB_FIELDS, _uploaderName: 1, _model: 1 } },
        ],
        total: [{ $match: filter }, { $count: "n" }],
        totalAll: [{ $count: "n" }],
        uploaders: [
          { $match: { _uploaderEmail: { $ne: null } } },
          { $group: { _id: "$_uploaderEmail", name: { $first: "$_uploaderName" } } },
          { $sort: { name: 1 } },
        ],
        models: [{ $match: { _model: { $ne: null } } }, { $group: { _id: "$_model" } }, { $sort: { _id: 1 } }],
      },
    },
  ];

  let page = values.page;
  let [facet] = await aggregate<Facet>(Collections.jobs, pipeline((page - 1) * pageSize));
  const total = facet.total[0]?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // Eine Seite hinter dem Ende (etwa nach einem engeren Filter) zeigt die letzte.
  if (page > pageCount) {
    page = pageCount;
    [facet] = await aggregate<Facet>(Collections.jobs, pipeline((page - 1) * pageSize));
  }

  return {
    rows: facet.rows.map((doc) => ({
      ...toJobRows([doc])[0],
      uploaderName: doc._uploaderName ?? null,
      modelUsed: doc._model ?? null,
    })),
    total,
    totalAll: facet.totalAll[0]?.n ?? 0,
    page,
    pageSize,
    pageCount,
    uploaders: facet.uploaders
      .filter((entry): entry is { _id: string; name: string | null } => !!entry._id)
      .map((entry) => ({ email: entry._id, name: entry.name || entry._id })),
    models: facet.models.map((entry) => entry._id).filter((id): id is string => !!id),
  };
}
