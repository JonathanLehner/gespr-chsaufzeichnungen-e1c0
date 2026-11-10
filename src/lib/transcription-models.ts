import "server-only";
import { Collections, aggregate, countDocuments, findById, findMany, findOne, updateMany, upsertById } from "./db";
import { invalidateRecordingCache } from "./recordings";
import {
  BASE_VOCABULARY,
  DEFAULT_MODEL,
  LEGACY_MODEL,
  TRANSCRIPTION_MODELS,
  TRANSCRIPTION_SETTINGS_ID,
  callerVocabulary,
  estimatedCostPerMinute,
  findModel,
  normalizeVocabulary,
  resolveModel,
  type TimingMethod,
  type TokenUsage,
  type TranscriptMeta,
  type TranscriptionModelId,
  type TranscriptionSettings,
} from "../../transcriber/shared/models";
import { HEARTBEAT_MS, REQUIRED_WORKER_FEATURES, WORKERS_COLLECTION } from "../../transcriber/shared/queue";
import type { Job, Recording } from "./types";

/**
 * Modellauswahl, Vokabular, Neu-Transkription bestehender Transkripte und
 * Kostenübersicht für das Admin-Dashboard. Die Arbeit selbst erledigt der
 * Transkriptionsdienst (`transcriber/`); hier werden nur Einstellungen und
 * Aufträge geschrieben.
 */

export type ModelSettingsView = {
  /** Gespeicherte Wahl; `null` = Standard. */
  stored: TranscriptionModelId | null;
  /** Tatsächlich verwendet (nicht verfügbare Wahl fällt zurück). */
  effective: TranscriptionModelId;
  vocabulary: string[];
  vocabularyStored: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

async function readSettings(): Promise<TranscriptionSettings | null> {
  return findById<TranscriptionSettings>(Collections.settings, TRANSCRIPTION_SETTINGS_ID);
}

/** Vorbelegung: feste Begriffe und die Namen aller Anrufer in den Aufnahmen. */
export async function defaultVocabulary(): Promise<string[]> {
  const names = await aggregate<{ _id: { first?: string; last?: string } }>(Collections.recordings, [
    { $group: { _id: { first: "$callerFirstName", last: "$callerLastName" } } },
    { $sort: { "_id.last": 1, "_id.first": 1 } },
  ]);
  return normalizeVocabulary([...BASE_VOCABULARY, ...callerVocabulary(names.map((entry) => entry._id))]);
}

export async function getModelSettings(): Promise<ModelSettingsView> {
  const doc = await readSettings();
  const stored = findModel(doc?.model)?.id ?? null;
  return {
    stored,
    effective: resolveModel(stored).id,
    vocabulary: doc?.vocabulary ?? (await defaultVocabulary()),
    vocabularyStored: !!doc?.vocabulary,
    updatedAt: doc?.updatedAt ?? null,
    updatedBy: doc?.updatedBy ?? null,
  };
}

type Result = { ok: boolean; message: string };

export async function saveModelSetting(id: string, by: string): Promise<Result> {
  const model = findModel(id);
  if (!model) return { ok: false, message: "Unbekanntes Modell." };
  if (!model.available) return { ok: false, message: model.note ?? `${model.id} ist nicht verfügbar.` };
  const current = await readSettings();
  await upsertById(Collections.settings, TRANSCRIPTION_SETTINGS_ID, {
    model: model.id,
    vocabulary: current?.vocabulary ?? (await defaultVocabulary()),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  });
  return { ok: true, message: `Neue Aufnahmen werden mit ${model.id} transkribiert.` };
}

export async function saveVocabulary(text: string, by: string): Promise<Result & { count?: number }> {
  const terms = normalizeVocabulary(text.split(/\r?\n|;/));
  const current = await readSettings();
  await upsertById(Collections.settings, TRANSCRIPTION_SETTINGS_ID, {
    model: current?.model ?? resolveModel(null).id,
    vocabulary: terms,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  });
  return { ok: true, count: terms.length, message: `${terms.length} Begriffe gespeichert. Sie gelten ab dem nächsten Auftrag.` };
}

/* ------------------------------------------------------------ Neu transkribieren */

export type RetranscribeInput = {
  /** Aufnahme-ID, Anrufnummer oder Dateiname; leer bei `alle`. */
  target: string;
  scope: "eine" | "alle";
  model: string;
  kind: "transkription" | "neu_ausrichten";
};

export type RetranscribePlan = {
  ok: boolean;
  message: string;
  count: number;
  audioMinutes: number;
  estimatedUsd: number;
  /** Bereits wartend oder laufend, werden übersprungen. */
  skipped: number;
};

/** Sucht eine Aufnahme über ID, Anrufnummer oder exakten Dateinamen. */
async function findRecording(target: string): Promise<Recording | null> {
  const value = target.trim();
  if (!value) return null;
  return (
    (await findById<Recording>(Collections.recordings, value)) ??
    (await findOne<Recording>(Collections.recordings, { callNumber: value.replace(/^\(|\)$/g, "") })) ??
    (await findOne<Recording>(Collections.recordings, { originalFilename: value }))
  );
}

/**
 * Auswahl für „alle“: abgeschlossene Transkripte, die nicht schon vom
 * gewählten Modell stammen; beim Neu-Ausrichten alle mit geschätzten Zeiten.
 */
function allFilter(input: RetranscribeInput): Record<string, unknown> {
  if (input.kind === "neu_ausrichten") {
    return { transcriptionStatus: "abgeschlossen", "transcript.timing": { $ne: "modell" } };
  }
  const model = input.model === LEGACY_MODEL ? { $nin: [LEGACY_MODEL, null] } : { $ne: input.model };
  return { transcriptionStatus: "abgeschlossen", "transcript.model": model };
}

async function candidates(input: RetranscribeInput): Promise<Result & { recordings: Recording[] }> {
  const model = findModel(input.model);
  if (input.kind === "transkription") {
    if (!model) return { ok: false, message: "Unbekanntes Modell.", recordings: [] };
    if (!model.available) return { ok: false, message: model.note ?? `${model.id} ist nicht verfügbar.`, recordings: [] };
  }
  if (input.scope === "eine") {
    const recording = await findRecording(input.target);
    if (!recording) return { ok: false, message: "Keine Aufnahme mit dieser ID, Anrufnummer oder diesem Dateinamen.", recordings: [] };
    if (recording.transcriptionStatus !== "abgeschlossen") {
      return { ok: false, message: "Für diese Aufnahme liegt noch kein abgeschlossenes Transkript vor.", recordings: [] };
    }
    if (input.kind === "neu_ausrichten" && recording.transcript?.timing === "modell") {
      return { ok: false, message: "Dieses Transkript hat Wortzeiten des Modells.", recordings: [] };
    }
    return { ok: true, message: "", recordings: [recording] };
  }
  const recordings = await findMany<Recording>(Collections.recordings, allFilter(input), {
    projection: { _id: 1, durationMs: 1, originalFilename: 1, uploadedAt: 1 },
  });
  return { ok: true, message: "", recordings };
}

async function openJobIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const open = await findMany<Job>(
    Collections.jobs,
    { _id: { $in: ids }, status: { $in: ["wartend", "in_arbeit"] } },
    { projection: { _id: 1 } },
  );
  return new Set(open.map((job) => job._id));
}

/** Vorschau: Anzahl, Gesprächsdauer und geschätzte Kosten. Schreibt nichts. */
export async function planRetranscription(input: RetranscribeInput): Promise<RetranscribePlan> {
  const found = await candidates(input);
  const empty = { count: 0, audioMinutes: 0, estimatedUsd: 0, skipped: 0 };
  if (!found.ok) return { ok: false, message: found.message, ...empty };
  const open = await openJobIds(found.recordings.map((row) => row._id));
  const rows = found.recordings.filter((row) => !open.has(row._id));
  const audioMinutes = rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) / 60_000;
  const model = findModel(input.model);
  const estimatedUsd = input.kind === "transkription" && model ? audioMinutes * estimatedCostPerMinute(model) : 0;
  return {
    ok: true,
    message: rows.length === 0 ? "Nichts einzureihen." : "",
    count: rows.length,
    audioMinutes,
    estimatedUsd,
    skipped: open.size,
  };
}

/**
 * Reiht nachrangige Aufträge ein. Idempotent: Aufnahmen mit wartendem oder
 * laufendem Auftrag werden übersprungen, ein Doppelklick reiht nichts doppelt ein.
 * Die Aufnahmen behalten Status und Transkript, bis das neue gespeichert ist.
 */
export async function enqueueRetranscription(input: RetranscribeInput, by: string): Promise<RetranscribePlan> {
  const plan = await planRetranscription(input);
  if (!plan.ok || plan.count === 0) return plan;
  if (await outdatedWorkerAlive()) {
    return {
      ...plan,
      ok: false,
      count: 0,
      message: "Ein Transkriptionsdienst läuft noch in einer älteren Fassung. Bitte nach dem nächsten Produktions-Deploy erneut versuchen.",
    };
  }
  const found = await candidates(input);
  const now = new Date().toISOString();
  const fields = {
    type: "transkription",
    status: "wartend",
    background: true,
    kind: input.kind,
    model: input.kind === "transkription" ? input.model : null,
    requestedBy: by,
    attempts: 0,
    lastError: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    lockedAt: null,
    lockId: null,
    workerId: null,
    nextAttemptAt: null,
    priority: null,
    progress: null,
    progressDone: null,
    progressTotal: null,
    progressAt: null,
    progressRunAt: null,
    progressRunDone: null,
    paused: null,
    permanent: null,
    staleClaims: 0,
  };
  let queued = 0;
  for (const chunk of chunked(found.recordings, 200)) {
    const ids = chunk.map((row) => row._id);
    // Nur Aufträge ohne offenen Lauf; der Filter prüft das im selben Schritt.
    const { modified } = await updateMany(
      Collections.jobs,
      { _id: { $in: ids }, status: { $nin: ["wartend", "in_arbeit"] } },
      { $set: fields },
    );
    queued += modified;
    const existing = new Set(
      (await findMany<Job>(Collections.jobs, { _id: { $in: ids } }, { projection: { _id: 1 } })).map((job) => job._id),
    );
    for (const row of chunk.filter((entry) => !existing.has(entry._id))) {
      await upsertById(Collections.jobs, row._id, { ...fields, recordingId: row._id, originalFilename: row.originalFilename });
      queued += 1;
    }
  }
  await invalidateRecordingCache();
  const what = input.kind === "neu_ausrichten" ? "Neu-Ausrichtung" : `Neu-Transkription mit ${input.model}`;
  return {
    ...plan,
    count: queued,
    message: `${queued} ${queued === 1 ? "Aufnahme" : "Aufnahmen"} zur ${what} eingereiht. Neue Uploads haben Vorrang.`,
  };
}

/** Läuft eine Instanz, die nachrangige Aufträge nicht kennt? Sie würde sie als gewöhnliche abarbeiten. */
async function outdatedWorkerAlive(): Promise<boolean> {
  const workers = await findMany<{ features?: string[]; stoppedAt: string | null }>(
    WORKERS_COLLECTION,
    { lastHeartbeatAt: { $gte: new Date(Date.now() - 3 * HEARTBEAT_MS).toISOString() }, stoppedAt: null },
    { projection: { features: 1, stoppedAt: 1 } },
  );
  return workers.some((worker) => !REQUIRED_WORKER_FEATURES.every((feature) => worker.features?.includes(feature)));
}

function chunked<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

/* ------------------------------------------------------------ Transkripte und Kosten */

export const TRANSCRIPT_SORTS = {
  datum: "transcript.at",
  modell: "transcript.model",
  kosten: "transcript.costUsd",
  dauer: "durationMs",
} as const;
export type TranscriptSort = keyof typeof TRANSCRIPT_SORTS;

export type TranscriptRow = {
  _id: string;
  originalFilename: string;
  callNumber: string;
  durationMs: number | null;
  transcript: TranscriptMeta | null;
  historyCount: number;
};

export const TRANSCRIPTS_PAGE_SIZE = 50;

export async function listTranscripts(options: {
  model: string | null;
  timing: TimingMethod | null;
  sort: TranscriptSort;
  direction: 1 | -1;
  page: number;
}): Promise<{ rows: TranscriptRow[]; total: number }> {
  const filter: Record<string, unknown> = { transcriptionStatus: "abgeschlossen" };
  // Ohne Herkunftsangabe (vor dem Nachtrag) stammt ein Transkript von gemini-2.5-flash.
  if (options.model) filter["transcript.model"] = options.model === LEGACY_MODEL ? { $in: [LEGACY_MODEL, null] } : options.model;
  if (options.timing) filter["transcript.timing"] = options.timing === "schaetzung" ? { $in: ["schaetzung", null] } : options.timing;
  const [docs, total] = await Promise.all([
    findMany<Recording>(Collections.recordings, filter, {
      projection: { originalFilename: 1, callNumber: 1, durationMs: 1, transcript: 1, transcriptHistory: 1, transcriptionFinishedAt: 1 },
      sort: { [TRANSCRIPT_SORTS[options.sort]]: options.direction, _id: 1 },
      skip: (options.page - 1) * TRANSCRIPTS_PAGE_SIZE,
      limit: TRANSCRIPTS_PAGE_SIZE,
    }),
    countDocuments(Collections.recordings, filter),
  ]);
  return {
    total,
    rows: docs.map((doc) => ({
      _id: doc._id,
      originalFilename: doc.originalFilename,
      callNumber: doc.callNumber,
      durationMs: doc.durationMs,
      transcript: transcriptMetaOf(doc),
      historyCount: doc.transcriptHistory?.length ?? 0,
    })),
  };
}

/** Herkunft eines Transkripts; ohne Eintrag (vor dem Nachtrag) gemini-2.5-flash mit Schätzung. */
export function transcriptMetaOf(recording: Pick<Recording, "transcript" | "transcriptionFinishedAt" | "durationMs" | "transcriptionStatus">): TranscriptMeta | null {
  if (recording.transcript) return recording.transcript;
  if (recording.transcriptionStatus !== "abgeschlossen") return null;
  return {
    model: LEGACY_MODEL,
    modelVersion: null,
    timing: "schaetzung",
    at: recording.transcriptionFinishedAt ?? "",
    usage: null,
    costUsd: null,
    audioMs: recording.durationMs,
    backfilled: true,
  };
}

export type CostRow = {
  month: string;
  model: string;
  runs: number;
  audioMinutes: number;
  costUsd: number;
  usage: TokenUsage;
};

/** Tatsächliche Kosten aus `transcription_runs`, je Monat (Europe/Zurich) und Modell, neueste zuerst. */
export async function costByMonth(months = 6): Promise<CostRow[]> {
  const rows = await aggregate<{
    _id: { month: string; model: string };
    runs: number;
    audioMs: number;
    costUsd: number;
    audioInput: number;
    textInput: number;
    output: number;
    thinking: number;
    requests: number;
  }>(Collections.transcriptionRuns, [
    { $match: { kind: "transkription" } },
    {
      $group: {
        _id: {
          month: { $dateToString: { format: "%Y-%m", date: { $dateFromString: { dateString: "$at" } }, timezone: "Europe/Zurich" } },
          model: "$model",
        },
        runs: { $sum: 1 },
        audioMs: { $sum: { $ifNull: ["$audioMs", 0] } },
        costUsd: { $sum: "$costUsd" },
        audioInput: { $sum: "$usage.audioInput" },
        textInput: { $sum: "$usage.textInput" },
        output: { $sum: "$usage.output" },
        thinking: { $sum: "$usage.thinking" },
        requests: { $sum: "$usage.requests" },
      },
    },
    { $sort: { "_id.month": -1, "_id.model": 1 } },
    { $limit: months * TRANSCRIPTION_MODELS.length },
  ]);
  return rows.map((row) => ({
    month: row._id.month,
    model: row._id.model,
    runs: row.runs,
    audioMinutes: row.audioMs / 60_000,
    costUsd: row.costUsd,
    usage: {
      audioInput: row.audioInput,
      textInput: row.textInput,
      output: row.output,
      thinking: row.thinking,
      requests: row.requests,
    },
  }));
}

/** Tatsächliche Kosten je Audiominute und Modell über alle Läufe. */
export async function actualCostPerMinute(): Promise<Map<string, number>> {
  const rows = await aggregate<{ _id: string; audioMs: number; costUsd: number }>(Collections.transcriptionRuns, [
    { $match: { kind: "transkription", audioMs: { $gt: 0 } } },
    { $group: { _id: "$model", audioMs: { $sum: "$audioMs" }, costUsd: { $sum: "$costUsd" } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.costUsd / (row.audioMs / 60_000)]));
}

/** Offener nachrangiger Auftrag einer Aufnahme (für die Detailseite). */
export async function pendingRetranscription(recordingId: string): Promise<Job | null> {
  const job = await findById<Job>(Collections.jobs, recordingId);
  return job?.background && (job.status === "wartend" || job.status === "in_arbeit") ? job : null;
}

export { DEFAULT_MODEL };
