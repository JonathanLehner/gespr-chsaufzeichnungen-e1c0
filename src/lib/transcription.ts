import "server-only";
import {
  Collections,
  deleteMany,
  findById,
  findMany,
  insertMany,
  updateOne,
  upsertById,
} from "./db";
import { platformGemini } from "./platform";
import { invalidateRecordingCache } from "./recordings";
import type {
  Job,
  Recording,
  TranscriptIndexDoc,
  TranscriptPartDoc,
  TranscriptSegment,
  TranscriptSentence,
  TranscriptWord,
} from "./types";

const MODEL = "gemini-2.5-flash";
export const MAX_ATTEMPTS = 3;
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_PART_BYTES = 350 * 1024; // Grenze des Datenbank-Endpunkts ist 1 MB

/**
 * Wartezeit bis zur nächsten automatischen Wiederholung, gemessen an der Zahl
 * der bisherigen Versuche. Ein sofortiger zweiter Anlauf hilft bei einer
 * Zeitüberschreitung des Dienstes nicht weiter, deshalb der zeitliche Abstand.
 */
const RETRY_DELAYS_MS = [3 * 60 * 1000, 15 * 60 * 1000];
/** Mindestabstand zwischen zwei Warteschlangenläufen je Serverinstanz. */
const SWEEP_INTERVAL_MS = 30 * 1000;

const PROMPT = `Du bist ein professioneller Transkriptionsdienst für deutschsprachige Verkaufsgespräche einer Immobilienfirma.

Aufgabe: Transkribiere die beigefügte Audioaufnahme vollständig und wortgetreu auf Deutsch.

Regeln:
- Ausgabesprache ist immer Deutsch, unabhängig von Dialekt oder Akzent. Schweizerdeutsche Passagen werden in deutscher Standardsprache wiedergegeben.
- Trenne die Sprecher. Vergib stabile Kennungen S1, S2, S3 in der Reihenfolge des ersten Auftretens.
- Wenn im Gespräch ein Name genannt wird, verwende ihn als Bezeichnung des Sprechers, sonst "Sprecher 1", "Sprecher 2".
- Gliedere jeden Sprecherbeitrag in einzelne Sätze und jeden Satz in einzelne Wörter.
- Alle Zeitangaben in ganzen Millisekunden ab Beginn der Aufnahme, aufsteigend und ohne Überlappung.
- Erfinde nichts. Unverständliche Stellen als [unverständlich] kennzeichnen.

Antworte ausschliesslich mit JSON in genau dieser Struktur:
{"speakers":[{"id":"S1","label":"Samir Weber"}],
 "segments":[{"speaker":"S1","startMs":0,"endMs":4200,
   "sentences":[{"text":"Guten Tag Frau Bachmann.","startMs":0,"endMs":1600,
     "words":[{"text":"Guten","startMs":0,"endMs":320}]}]}]}`;

type RawWord = { text?: string; startMs?: number; endMs?: number };
type RawSentence = { text?: string; startMs?: number; endMs?: number; words?: RawWord[] };
type RawSegment = { speaker?: string; startMs?: number; endMs?: number; sentences?: RawSentence[] };
type RawTranscript = { speakers?: { id?: string; label?: string }[]; segments?: RawSegment[] };

function parseJsonLoosely(text: string): RawTranscript {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate) as RawTranscript;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as RawTranscript;
    }
    throw new Error("Die Antwort des Transkriptionsdienstes war kein gültiges JSON.");
  }
}

function toMs(value: unknown, fallback: number): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric);
}

/** Bringt die Modellantwort in eine lückenlose, aufsteigende Struktur. */
export function normalizeTranscript(raw: RawTranscript): {
  segments: TranscriptSegment[];
  speakerLabels: string[];
  wordCount: number;
  endMs: number;
} {
  const labels = new Map<string, string>();
  (raw.speakers ?? []).forEach((speaker, index) => {
    const id = (speaker.id ?? `S${index + 1}`).trim();
    labels.set(id, (speaker.label ?? "").trim() || `Sprecher ${index + 1}`);
  });

  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  let wordCount = 0;

  for (const rawSegment of raw.segments ?? []) {
    const speaker = (rawSegment.speaker ?? "S1").trim() || "S1";
    if (!labels.has(speaker)) labels.set(speaker, `Sprecher ${labels.size + 1}`);

    const sentences: TranscriptSentence[] = [];
    for (const rawSentence of rawSegment.sentences ?? []) {
      const text = (rawSentence.text ?? "").trim();
      if (!text) continue;
      const startMs = Math.max(toMs(rawSentence.startMs, cursor), cursor);
      let endMs = toMs(rawSentence.endMs, startMs + Math.max(800, text.length * 60));
      if (endMs <= startMs) endMs = startMs + Math.max(800, text.length * 60);

      const rawWords = (rawSentence.words ?? []).filter((word) => (word.text ?? "").trim().length > 0);
      let words: TranscriptWord[];
      if (rawWords.length > 0) {
        let wordCursor = startMs;
        words = rawWords.map((word, index) => {
          const wordStart = Math.max(toMs(word.startMs, wordCursor), wordCursor);
          const evenly = startMs + ((endMs - startMs) * (index + 1)) / rawWords.length;
          let wordEnd = toMs(word.endMs, Math.round(evenly));
          if (wordEnd <= wordStart) wordEnd = Math.min(endMs, wordStart + 200);
          wordCursor = wordEnd;
          return { text: (word.text ?? "").trim(), startMs: wordStart, endMs: wordEnd };
        });
      } else {
        const tokens = text.split(/\s+/).filter(Boolean);
        const step = (endMs - startMs) / Math.max(tokens.length, 1);
        words = tokens.map((token, index) => ({
          text: token,
          startMs: Math.round(startMs + step * index),
          endMs: Math.round(startMs + step * (index + 1)),
        }));
      }
      wordCount += words.length;
      const last = words[words.length - 1];
      if (last && last.endMs > endMs) endMs = last.endMs;
      sentences.push({ text, startMs, endMs, words });
      cursor = endMs;
    }
    if (sentences.length === 0) continue;
    segments.push({
      speaker,
      speakerLabel: labels.get(speaker) ?? speaker,
      startMs: sentences[0].startMs,
      endMs: sentences[sentences.length - 1].endMs,
      sentences,
    });
  }

  if (segments.length === 0) {
    throw new Error("Der Transkriptionsdienst hat keinen verwertbaren Text geliefert.");
  }

  const usedSpeakers = new Set(segments.map((segment) => segment.speaker));
  return {
    segments,
    speakerLabels: [...usedSpeakers].map((id) => labels.get(id) ?? id),
    wordCount,
    endMs: segments[segments.length - 1].endMs,
  };
}

function splitIntoParts(recordingId: string, segments: TranscriptSegment[]): TranscriptPartDoc[] {
  const parts: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const segmentSize = JSON.stringify(segment).length;
    if (current.length > 0 && size + segmentSize > MAX_PART_BYTES) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += segmentSize;
  }
  if (current.length > 0) parts.push(current);
  return parts.map((partSegments, index) => ({
    _id: `${recordingId}:${index}`,
    recordingId,
    partIndex: index,
    partCount: parts.length,
    segments: partSegments,
  }));
}

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

  const sentences = segments.flatMap((segment) =>
    segment.sentences.map((sentence) => ({
      t: sentence.startMs,
      e: sentence.endMs,
      s: segment.speakerLabel,
      x: sentence.text,
    })),
  );
  const index: TranscriptIndexDoc = {
    _id: recordingId,
    recordingId,
    fullText: sentences.map((sentence) => sentence.x).join(" "),
    sentences,
    speakerLabels,
    updatedAt: new Date().toISOString(),
  };
  await upsertById(Collections.transcriptIndex, recordingId, index as unknown as Record<string, unknown>);
}

export async function loadTranscript(recordingId: string): Promise<TranscriptSegment[]> {
  const parts = await findMany<TranscriptPartDoc>(Collections.transcriptParts, { recordingId });
  return parts
    .sort((a, b) => a.partIndex - b.partIndex)
    .flatMap((part) => part.segments ?? []);
}

/* --------------------------------------------------------------- Auftrags-Lauf */

/**
 * Übernimmt einen Auftrag exklusiv. Fehlgeschlagene Aufträge werden nur so
 * lange wieder aufgenommen, wie noch Versuche offen sind; die Fälligkeit der
 * Wiederholung prüft der Aufrufer.
 */
async function claimJob(recordingId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const lock = { status: "in_arbeit", startedAt: now, lockedAt: now, nextAttemptAt: null };

  const waiting = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "wartend" },
    { $set: lock, $inc: { attempts: 1 } },
  );
  if (waiting.modified === 1) return true;

  const failed = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "fehlgeschlagen", attempts: { $lt: MAX_ATTEMPTS } },
    { $set: lock, $inc: { attempts: 1 } },
  );
  if (failed.modified === 1) return true;

  const recovered = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "in_arbeit", lockedAt: { $lt: stale } },
    { $set: lock, $inc: { attempts: 1 } },
  );
  return recovered.modified === 1;
}

type StatusExtras = {
  lastError?: string | null;
  attempts?: number;
  nextAttemptAt?: string | null;
};

async function setStatus(
  recordingId: string,
  status: Job["status"],
  extras: StatusExtras = {},
): Promise<void> {
  const now = new Date().toISOString();
  const closed = status === "abgeschlossen" || status === "fehlgeschlagen";
  const nextAttemptAt = extras.nextAttemptAt ?? null;

  const jobFields: Record<string, unknown> = {
    status,
    finishedAt: closed ? now : null,
    nextAttemptAt,
  };
  if (extras.lastError !== undefined) jobFields.lastError = extras.lastError;

  await Promise.all([
    updateOne(Collections.jobs, { _id: recordingId }, { $set: jobFields }),
    updateOne(
      Collections.recordings,
      { _id: recordingId },
      {
        $set: {
          transcriptionStatus: status,
          transcriptionError: extras.lastError ?? null,
          transcriptionFinishedAt: closed ? now : null,
          transcriptionNextAttemptAt: nextAttemptAt,
          ...(extras.attempts !== undefined ? { transcriptionAttempts: extras.attempts } : {}),
          ...(status === "in_arbeit" ? { transcriptionStartedAt: now } : {}),
        },
      },
    ),
  ]);
  invalidateRecordingCache();
}

/** Fälligkeit der nächsten automatischen Wiederholung nach `attempts` Versuchen. */
function nextAttemptAfter(attempts: number): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
  return new Date(Date.now() + delay).toISOString();
}

/** Ein fehlgeschlagener Auftrag darf laufen, sobald die Wartezeit abgelaufen ist. */
function retryIsDue(job: Job, now: string): boolean {
  if (job.attempts >= MAX_ATTEMPTS) return false;
  return !job.nextAttemptAt || job.nextAttemptAt <= now;
}

/**
 * Führt die Transkription einer Aufnahme aus. Der Auftrag wird vorher
 * gesperrt, damit parallele Aufrufe keine doppelten Läufe erzeugen.
 */
export async function transcribeRecording(recordingId: string): Promise<
  { ok: true } | { ok: false; error: string; skipped?: boolean }
> {
  const recording = await findById<Recording>(Collections.recordings, recordingId);
  if (!recording) return { ok: false, error: "Aufnahme nicht gefunden." };

  const job = await findById<Job>(Collections.jobs, recordingId);
  if (job && job.status === "abgeschlossen") return { ok: true };
  if (job && job.status === "fehlgeschlagen" && !retryIsDue(job, new Date().toISOString())) {
    return {
      ok: false,
      error:
        job.attempts >= MAX_ATTEMPTS
          ? job.lastError ?? "Maximale Anzahl Versuche erreicht."
          : "Die automatische Wiederholung ist noch nicht fällig.",
      skipped: true,
    };
  }
  if (!(await claimJob(recordingId))) {
    return { ok: false, error: "Der Auftrag wird bereits bearbeitet.", skipped: true };
  }

  const attempts = (await findById<Job>(Collections.jobs, recordingId))?.attempts ?? 1;
  await setStatus(recordingId, "in_arbeit", { attempts });

  try {
    const response = await platformGemini({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT },
            { fileData: { fileUri: recording.audioUrl, mimeType: recording.mimeType } },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });
    const normalized = normalizeTranscript(parseJsonLoosely(response.text ?? ""));
    await saveTranscript(recordingId, normalized.segments, normalized.speakerLabels);
    await updateOne(
      Collections.recordings,
      { _id: recordingId },
      {
        $set: {
          speakerCount: normalized.speakerLabels.length,
          wordCount: normalized.wordCount,
          ...(recording.durationMs ? {} : { durationMs: normalized.endMs }),
        },
      },
    );
    await setStatus(recordingId, "abgeschlossen", { lastError: null, attempts });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unbekannter Fehler bei der Transkription.";
    await setStatus(recordingId, "fehlgeschlagen", {
      lastError: message.slice(0, 400),
      attempts,
      nextAttemptAt: nextAttemptAfter(attempts),
    });
    return { ok: false, error: message };
  }
}

/**
 * Arbeitet offene Aufträge ab: wartende, hängengebliebene und fehlgeschlagene,
 * deren Wartezeit abgelaufen ist. Wird nach dem Upload, beim Statusabruf und
 * beim Aufruf der Aufnahmeseiten angestossen.
 */
export async function runPendingJobs(limit = 2): Promise<number> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const [waiting, stuck, failed] = await Promise.all([
    findMany<Job>(Collections.jobs, { status: "wartend" }),
    findMany<Job>(Collections.jobs, { status: "in_arbeit", lockedAt: { $lt: stale } }),
    findMany<Job>(Collections.jobs, {
      status: "fehlgeschlagen",
      attempts: { $lt: MAX_ATTEMPTS },
    }),
  ]);
  const queue = [...waiting, ...stuck, ...failed.filter((job) => retryIsDue(job, now))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  let done = 0;
  for (const job of queue) {
    const result = await transcribeRecording(job.recordingId);
    if (result.ok) done += 1;
  }
  return done;
}

let lastSweepAt = 0;

/**
 * Stösst fällige Aufträge im Hintergrund an, höchstens alle 30 Sekunden je
 * Serverinstanz. So werden fehlgeschlagene Aufträge auch dann wiederholt, wenn
 * niemand eine laufende Transkription beobachtet.
 */
export async function sweepQueue(limit = 1): Promise<number> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;
  try {
    return await runPendingJobs(limit);
  } catch {
    return 0;
  }
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
        startedAt: null,
        finishedAt: null,
        nextAttemptAt: null,
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
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();

  if (job && job.status === "in_arbeit" && (job.lockedAt ?? "") > stale) {
    return { ok: true, message: "Die Transkription läuft bereits.", state: "laeuft" };
  }
  if (job && job.status === "wartend") {
    return { ok: true, message: "Der Auftrag steht bereits in der Warteschlange.", state: "laeuft" };
  }
  if (job && job.status === "abgeschlossen" && !options.allowCompleted) {
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
    await setStatus(recordingId, "wartend", { lastError: null, attempts: 0 });
  }

  return { ok: true, message: "Die Transkription wurde neu eingereiht.", state: "gestartet" };
}
