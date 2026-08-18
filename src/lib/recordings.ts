import "server-only";
import { createHash } from "node:crypto";
import {
  Collections,
  countDocuments,
  deleteById,
  deleteMany,
  findById,
  findMany,
  insertUnique,
  nextCounter,
  readCounter,
  updateOne,
} from "./db";
import type {
  Comment,
  Job,
  Rating,
  Recording,
  TranscriptIndexDoc,
  TranscriptionStatus,
} from "./types";

export const BUCKET_SIZE = 50;
const MAX_BUCKET_SCAN = 200; // deckt 10'000 Aufnahmen ab

export function recordingIdFor(fingerprint: string): string {
  return `rec_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ----------------------------------------------------------------- Anlegen */

export type NewRecordingInput = {
  originalFilename: string;
  audioUrl: string;
  mimeType: "audio/wav" | "audio/mpeg";
  byteSize: number;
  durationMs: number | null;
  callerName: string;
  callerFirstName: string;
  callerLastName: string;
  phoneNumber: string;
  callNumber: string;
  callAtUtc: string;
  metadataSource: "dateiname" | "manuell";
  templateVersion: number | null;
  uploadedByEmail: string;
  uploadedByName: string;
  fingerprint: string;
};

export async function createRecording(
  input: NewRecordingInput,
): Promise<{ created: boolean; recording: Recording }> {
  const id = recordingIdFor(input.fingerprint);
  const existing = await findById<Recording>(Collections.recordings, id);
  if (existing) return { created: false, recording: existing };

  const counter = await nextCounter("recordings");
  const now = new Date().toISOString();
  const doc: Recording & { bucket: number } = {
    _id: id,
    ...input,
    uploadedAt: now,
    transcriptionStatus: "wartend",
    transcriptionError: null,
    transcriptionStartedAt: null,
    transcriptionFinishedAt: null,
    transcriptionNextAttemptAt: null,
    transcriptionAttempts: 0,
    speakerCount: null,
    wordCount: null,
    deletionFlagged: false,
    deletionFlaggedBy: null,
    deletionFlaggedAt: null,
    deletionReason: null,
    ratingAverage: null,
    ratingCount: 0,
    bucket: Math.floor((counter - 1) / BUCKET_SIZE),
  };
  const created = await insertUnique(Collections.recordings, { ...doc });
  if (!created) {
    const current = await findById<Recording>(Collections.recordings, id);
    if (current) return { created: false, recording: current };
  }
  await insertUnique(Collections.jobs, {
    _id: id,
    recordingId: id,
    type: "transkription",
    status: "wartend",
    attempts: 0,
    lastError: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    lockedAt: null,
    nextAttemptAt: null,
    originalFilename: input.originalFilename,
  });
  return { created: true, recording: doc };
}

/* ------------------------------------------------------------------- Lesen */

type CacheEntry = { at: number; rows: Recording[] };
const listCache = new Map<string, CacheEntry>();
const CACHE_MS = 5_000;

export function invalidateRecordingCache(): void {
  listCache.clear();
}

/**
 * Liest alle Aufnahmen. Der Plattform-Endpunkt liefert höchstens 100
 * Dokumente pro Abfrage und kann nicht sortieren, deshalb werden die Daten
 * über die beim Anlegen vergebenen Lesefenster (`bucket`) vollständig geholt
 * und anschliessend serverseitig gefiltert, sortiert und paginiert.
 */
async function loadAllRecordings(): Promise<Recording[]> {
  const cached = listCache.get("all");
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rows;

  const total = await readCounter("recordings");
  const buckets = Math.min(Math.floor(Math.max(total - 1, 0) / BUCKET_SIZE) + 1, MAX_BUCKET_SCAN);
  const pages = await Promise.all(
    Array.from({ length: buckets }, (_, bucket) =>
      findMany<Recording>(Collections.recordings, { bucket }),
    ),
  );
  const rows = pages.flat();
  listCache.set("all", { at: Date.now(), rows });
  return rows;
}

export type SortKey =
  | "gespraech_neu"
  | "gespraech_alt"
  | "hochgeladen_neu"
  | "name_az"
  | "bewertung_hoch"
  | "bewertung_tief";

export type RecordingQuery = {
  q?: string;
  von?: string; // ISO
  bis?: string; // ISO
  uploader?: string;
  status?: TranscriptionStatus | "alle";
  bewertungVon?: number;
  bewertungBis?: number;
  loeschstatus?: "alle" | "nur_markiert" | "ohne_markiert";
  sort?: SortKey;
  page?: number;
  pageSize?: number;
};

export type TranscriptHit = {
  startMs: number;
  speaker: string;
  before: string;
  match: string;
  after: string;
};

export type RecordingRow = Recording & {
  hits: TranscriptHit[];
  hitCount: number;
  matchedFields: string[];
};

export type RecordingListResult = {
  rows: RecordingRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  uploaders: { email: string; name: string }[];
  totalAll: number;
};

function buildHits(doc: TranscriptIndexDoc, needle: string, limit = 3): TranscriptHit[] {
  const hits: TranscriptHit[] = [];
  const lowered = needle.toLowerCase();
  for (const sentence of doc.sentences ?? []) {
    const position = sentence.x.toLowerCase().indexOf(lowered);
    if (position === -1) continue;
    const start = Math.max(0, position - 60);
    hits.push({
      startMs: sentence.t,
      speaker: sentence.s,
      before: (start > 0 ? "… " : "") + sentence.x.slice(start, position),
      match: sentence.x.slice(position, position + needle.length),
      after: sentence.x.slice(position + needle.length, position + needle.length + 80),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function listRecordings(query: RecordingQuery): Promise<RecordingListResult> {
  const all = await loadAllRecordings();
  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 5), 100);
  const needle = (query.q ?? "").trim();

  let transcriptHits = new Map<string, TranscriptHit[]>();
  if (needle.length >= 2) {
    const docs = await findMany<TranscriptIndexDoc>(Collections.transcriptIndex, {
      fullText: { $regex: escapeRegex(needle), $options: "i" },
    });
    transcriptHits = new Map(docs.map((doc) => [doc.recordingId, buildHits(doc, needle)]));
  }

  const loweredNeedle = needle.toLowerCase();
  const rows: RecordingRow[] = [];
  for (const recording of all) {
    if (query.von && recording.callAtUtc < query.von) continue;
    if (query.bis && recording.callAtUtc > query.bis) continue;
    if (query.uploader && recording.uploadedByEmail !== query.uploader) continue;
    if (query.status && query.status !== "alle" && recording.transcriptionStatus !== query.status) continue;
    if (query.loeschstatus === "nur_markiert" && !recording.deletionFlagged) continue;
    if (query.loeschstatus === "ohne_markiert" && recording.deletionFlagged) continue;
    if (query.bewertungVon !== undefined || query.bewertungBis !== undefined) {
      if (recording.ratingAverage === null) continue;
      if (query.bewertungVon !== undefined && recording.ratingAverage < query.bewertungVon) continue;
      if (query.bewertungBis !== undefined && recording.ratingAverage > query.bewertungBis) continue;
    }

    const matchedFields: string[] = [];
    if (needle) {
      const fields: [string, string][] = [
        ["Name", recording.callerName],
        ["Telefonnummer", recording.phoneNumber],
        ["Anrufnummer", recording.callNumber],
        ["Dateiname", recording.originalFilename],
        ["Hochgeladen von", recording.uploadedByName],
      ];
      for (const [label, value] of fields) {
        if (value && value.toLowerCase().includes(loweredNeedle)) matchedFields.push(label);
      }
      const hits = transcriptHits.get(recording._id) ?? [];
      if (matchedFields.length === 0 && hits.length === 0) continue;
      rows.push({ ...recording, hits, hitCount: hits.length, matchedFields });
      continue;
    }
    rows.push({ ...recording, hits: [], hitCount: 0, matchedFields });
  }

  const sort = query.sort ?? "gespraech_neu";
  rows.sort((a, b) => {
    switch (sort) {
      case "gespraech_alt":
        return a.callAtUtc.localeCompare(b.callAtUtc);
      case "hochgeladen_neu":
        return b.uploadedAt.localeCompare(a.uploadedAt);
      case "name_az":
        return a.callerName.localeCompare(b.callerName, "de-CH");
      case "bewertung_hoch":
        return (b.ratingAverage ?? -1) - (a.ratingAverage ?? -1);
      case "bewertung_tief":
        return (a.ratingAverage ?? 11) - (b.ratingAverage ?? 11);
      default:
        return b.callAtUtc.localeCompare(a.callAtUtc);
    }
  });

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);
  const start = (page - 1) * pageSize;

  const uploaderMap = new Map<string, string>();
  for (const recording of all) uploaderMap.set(recording.uploadedByEmail, recording.uploadedByName);

  return {
    rows: rows.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    pageCount,
    totalAll: all.length,
    uploaders: [...uploaderMap.entries()]
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de-CH")),
  };
}

export async function getRecording(id: string): Promise<Recording | null> {
  return findById<Recording>(Collections.recordings, id);
}

/* -------------------------------------------------------- Löschmarkierungen */

export async function setDeletionFlag(
  recordingId: string,
  flagged: boolean,
  byEmail: string,
  reason: string,
): Promise<void> {
  await updateOne(
    Collections.recordings,
    { _id: recordingId },
    {
      $set: {
        deletionFlagged: flagged,
        deletionFlaggedBy: flagged ? byEmail : null,
        deletionFlaggedAt: flagged ? new Date().toISOString() : null,
        deletionReason: flagged ? reason.trim().slice(0, 300) : null,
      },
    },
  );
  invalidateRecordingCache();
}

/** Endgültiges Löschen: Aufnahme, Transkript, Kommentare, Bewertungen, Auftrag. */
export async function hardDeleteRecording(recordingId: string): Promise<void> {
  await Promise.all([
    deleteById(Collections.recordings, recordingId),
    deleteById(Collections.transcriptIndex, recordingId),
    deleteMany(Collections.transcriptParts, { recordingId }),
    deleteMany(Collections.comments, { recordingId }),
    deleteMany(Collections.ratings, { recordingId }),
    deleteById(Collections.jobs, recordingId),
  ]);
  invalidateRecordingCache();
}

/* ------------------------------------------------- Kommentare & Bewertungen */

export async function listComments(recordingId: string): Promise<Comment[]> {
  const rows = await findMany<Comment>(Collections.comments, { recordingId });
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listRatings(recordingId: string): Promise<Rating[]> {
  const rows = await findMany<Rating>(Collections.ratings, { recordingId });
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function refreshRatingSummary(recordingId: string): Promise<void> {
  const ratings = await listRatings(recordingId);
  const count = ratings.length;
  const average =
    count === 0 ? null : Math.round((ratings.reduce((sum, r) => sum + r.score, 0) / count) * 10) / 10;
  await updateOne(
    Collections.recordings,
    { _id: recordingId },
    { $set: { ratingAverage: average, ratingCount: count } },
  );
  invalidateRecordingCache();
}

/* ---------------------------------------------------------------- Aufträge */

export async function listJobs(): Promise<Job[]> {
  const rows = await findMany<Job>(Collections.jobs, {});
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function countByStatus(): Promise<Record<TranscriptionStatus, number>> {
  const [wartend, inArbeit, abgeschlossen, fehlgeschlagen] = await Promise.all([
    countDocuments(Collections.recordings, { transcriptionStatus: "wartend" }),
    countDocuments(Collections.recordings, { transcriptionStatus: "in_arbeit" }),
    countDocuments(Collections.recordings, { transcriptionStatus: "abgeschlossen" }),
    countDocuments(Collections.recordings, { transcriptionStatus: "fehlgeschlagen" }),
  ]);
  return { wartend, in_arbeit: inArbeit, abgeschlossen, fehlgeschlagen };
}
