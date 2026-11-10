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
  MAX_ATTEMPTS,
  STALE_LOCK_MS,
  WORKERS_COLLECTION,
  claimableFilter,
  iso,
  lockIsFresh,
} from "../../transcriber/shared/queue";
import { buildTranscriptIndex, splitIntoParts } from "../../transcriber/shared/transcript";
import { readFileBytes } from "./storage";
import { invalidateRecordingCache } from "./recordings";
import type { Job, Recording, TranscriptPartDoc, TranscriptSegment } from "./types";

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
        paused: null,
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
};

type WorkerDoc = Omit<WorkerHealth, "id" | "alive">;

/** Zustand der Warteschlange und der Transkriptionsdienste für das Admin-Dashboard. */
export async function queueHealth(): Promise<QueueHealth> {
  const now = Date.now();
  const hourAgo = iso(now - 60 * 60 * 1000);
  const dayAgo = iso(now - 24 * 60 * 60 * 1000);
  const [workerDocs, queued, running, retryScheduled, doneLastHour, failedLastHour] =
    await Promise.all([
      findMany<WorkerDoc>(WORKERS_COLLECTION, { lastHeartbeatAt: { $gte: dayAgo } }),
      countDocuments(Collections.jobs, claimableFilter(now)),
      countDocuments(Collections.jobs, {
        status: "in_arbeit",
        lockedAt: { $gte: iso(now - STALE_LOCK_MS) },
      }),
      countDocuments(Collections.jobs, {
        status: "fehlgeschlagen",
        attempts: { $lt: MAX_ATTEMPTS },
        nextAttemptAt: { $gt: iso(now) },
      }),
      countDocuments(Collections.jobs, {
        status: { $in: ["abgeschlossen", "ohne_sprache"] },
        finishedAt: { $gte: hourAgo },
      }),
      countDocuments(Collections.jobs, { status: "fehlgeschlagen", finishedAt: { $gte: hourAgo } }),
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
  };
}
