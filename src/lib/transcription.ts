import "server-only";
import {
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
  scheduledRetryFilter,
  type LimiterDoc,
  type QueueErrorEntry,
  type QueueSettings,
  type SpendingBlock,
} from "../../transcriber/shared/queue";
import { buildTranscriptIndex, splitIntoParts } from "../../transcriber/shared/transcript";
import { readFileBytes } from "./storage";
import { invalidateRecordingCache } from "./recordings";
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
  invalidateRecordingCache();

  return {
    ok: true,
    message: `${aligned.speechMs} ms Sprache in ${aligned.regionCount} Abschnitten.`,
  };
}

/** Setzt einen Auftrag auf „wartend“ zurück und gibt alle Versuche wieder frei. */
export async function resetJob(recordingId: string): Promise<void> {
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
        paused: null,
        permanent: null,
        staleClaims: 0,
      },
    },
  );
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
  invalidateRecordingCache();
}

/* ------------------------------------------------------------ Laufender Stand für die Anzeige */

/** Fortschritt laufender Aufträge, ohne die gespeicherten Teiltranskripte zu laden. */
export type JobProgress = {
  progressDone: number | null;
  progressTotal: number | null;
  /** Letzter gesicherter Abschnitt, sonst Beginn des Laufs. */
  updatedAt: string | null;
};

export async function jobProgress(ids: string[]): Promise<Map<string, JobProgress>> {
  if (ids.length === 0) return new Map();
  const jobs = await findMany<Job & { progressDone?: number; progressTotal?: number; progressAt?: string }>(
    Collections.jobs,
    { _id: { $in: ids.slice(0, 100) } },
    { projection: { progressDone: 1, progressTotal: 1, progressAt: 1, startedAt: 1, lockedAt: 1 } },
  );
  return new Map(
    jobs.map((job) => [
      job._id,
      {
        progressDone: job.progressDone ?? null,
        progressTotal: job.progressTotal ?? null,
        updatedAt: job.progressAt ?? job.startedAt ?? job.lockedAt ?? null,
      },
    ]),
  );
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
    invalidateRecordingCache();
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
  invalidateRecordingCache();
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
    invalidateRecordingCache();
    return { ok: true, message: "Der nächste Versuch ist sofort fällig.", state: "gestartet" };
  }
  return requeueTranscription(recordingId, { allowCompleted: true });
}

/** Reiht alle fehlgeschlagenen Aufträge neu ein; liefert die Anzahl. */
export async function requeueAllFailed(): Promise<number> {
  const failed = await findMany<Job>(Collections.jobs, { status: "fehlgeschlagen" }, { projection: { _id: 1 } });
  for (const job of failed) await resetJob(job._id);
  return failed.length;
}

/* ------------------------------------------------------------ Übersicht für das Dashboard */

export type QueueJobRow = Pick<
  Job,
  "_id" | "status" | "attempts" | "lastError" | "createdAt" | "startedAt" | "finishedAt" | "nextAttemptAt" | "originalFilename" | "priority"
>;

export type QueueOverview = {
  counts: Record<TranscriptionStatus, number>;
  oldestWaiting: QueueJobRow | null;
  /** Laufend, dann wartend in der Reihenfolge der Übernahme (Vorrang, dann älteste zuerst). */
  waiting: QueueJobRow[];
  /** Geplante Wiederholungen, früheste zuerst. */
  nextAttempts: QueueJobRow[];
  failed: QueueJobRow[];
  recentlyFinished: QueueJobRow[];
  errors: (QueueErrorEntry & { filename: string | null })[];
  manualPause: { at: string; by: string } | null;
  spendingBlock: SpendingBlock | null;
  lastBlock: (SpendingBlock & { liftedAt: string; liftedBy: string }) | null;
  /** Gespeicherte Grenzen; `null` = Standardwerte des Dienstes. */
  settings: QueueSettings | null;
  /** Aktuell angewandte Werte (gespeichert oder Standard des Dienstes). */
  effective: { maxConcurrent: number; minGapMs: number; jobsPerInstance: number };
};

const JOB_FIELDS = {
  status: 1, attempts: 1, lastError: 1, createdAt: 1, startedAt: 1, finishedAt: 1,
  nextAttemptAt: 1, originalFilename: 1, priority: 1,
} as const;

export async function queueOverview(health: QueueHealth): Promise<QueueOverview> {
  const statuses: TranscriptionStatus[] = ["wartend", "in_arbeit", "abgeschlossen", "ohne_sprache", "fehlgeschlagen"];
  const now = iso();
  const [countList, waiting, nextAttempts, failed, recentlyFinished, oldest, doc] = await Promise.all([
    Promise.all(statuses.map((status) => countDocuments(Collections.jobs, { status }))),
    findMany<QueueJobRow>(Collections.jobs, { status: { $in: ["in_arbeit", "wartend"] } }, {
      projection: JOB_FIELDS, sort: { status: 1, priority: -1, createdAt: 1 }, limit: 25,
    }),
    findMany<QueueJobRow>(Collections.jobs, { status: "wartend", nextAttemptAt: { $gt: now } }, {
      projection: JOB_FIELDS, sort: { nextAttemptAt: 1 }, limit: 10,
    }),
    findMany<QueueJobRow>(Collections.jobs, { status: "fehlgeschlagen" }, {
      projection: JOB_FIELDS, sort: { finishedAt: -1 }, limit: 50,
    }),
    findMany<QueueJobRow>(Collections.jobs, { status: { $in: ["abgeschlossen", "ohne_sprache"] } }, {
      projection: JOB_FIELDS, sort: { finishedAt: -1 }, limit: 10,
    }),
    findMany<QueueJobRow>(Collections.jobs, { status: "wartend" }, {
      projection: JOB_FIELDS, sort: { createdAt: 1 }, limit: 1,
    }),
    findById<LimiterDoc & { lastBlock?: QueueOverview["lastBlock"] }>(LIMITER_COLLECTION, LIMITER_ID),
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
    oldestWaiting: oldest[0] ?? null,
    waiting,
    nextAttempts,
    failed,
    recentlyFinished,
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
  };
}
