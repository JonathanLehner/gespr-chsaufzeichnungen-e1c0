import "server-only";
import { Collections, deleteMany, findById, findMany, insertMany, updateOne, upsertById } from "./db";
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

async function claimJob(recordingId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const fresh = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: { $in: ["wartend", "fehlgeschlagen"] } },
    { $set: { status: "in_arbeit", startedAt: now, lockedAt: now }, $inc: { attempts: 1 } },
  );
  if (fresh.modified === 1) return true;
  const recovered = await updateOne(
    Collections.jobs,
    { _id: recordingId, status: "in_arbeit", lockedAt: { $lt: stale } },
    { $set: { status: "in_arbeit", startedAt: now, lockedAt: now }, $inc: { attempts: 1 } },
  );
  return recovered.modified === 1;
}

async function setStatus(
  recordingId: string,
  status: Job["status"],
  extras: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all([
    updateOne(Collections.jobs, { _id: recordingId }, { $set: { status, ...extras, finishedAt: status === "abgeschlossen" || status === "fehlgeschlagen" ? now : null } }),
    updateOne(
      Collections.recordings,
      { _id: recordingId },
      {
        $set: {
          transcriptionStatus: status,
          transcriptionError: (extras.lastError as string | null) ?? null,
          transcriptionFinishedAt:
            status === "abgeschlossen" || status === "fehlgeschlagen" ? now : null,
          ...(status === "in_arbeit" ? { transcriptionStartedAt: now } : {}),
        },
      },
    ),
  ]);
  invalidateRecordingCache();
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
  if (job && job.attempts >= MAX_ATTEMPTS && job.status === "fehlgeschlagen") {
    return { ok: false, error: job.lastError ?? "Maximale Anzahl Versuche erreicht.", skipped: true };
  }
  if (!(await claimJob(recordingId))) {
    return { ok: false, error: "Der Auftrag wird bereits bearbeitet.", skipped: true };
  }

  await setStatus(recordingId, "in_arbeit");

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
    await setStatus(recordingId, "abgeschlossen", { lastError: null });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unbekannter Fehler bei der Transkription.";
    await setStatus(recordingId, "fehlgeschlagen", { lastError: message.slice(0, 400) });
    return { ok: false, error: message };
  }
}

/** Arbeitet offene Aufträge ab. Wird nach dem Upload und beim Statusabruf aufgerufen. */
export async function runPendingJobs(limit = 2): Promise<number> {
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const waiting = await findMany<Job>(Collections.jobs, { status: "wartend" });
  const stuck = await findMany<Job>(Collections.jobs, {
    status: "in_arbeit",
    lockedAt: { $lt: stale },
  });
  const queue = [...waiting, ...stuck]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  let done = 0;
  for (const job of queue) {
    const result = await transcribeRecording(job.recordingId);
    if (result.ok) done += 1;
  }
  return done;
}

/** Setzt einen fehlgeschlagenen Auftrag zurück (Admin-Funktion). */
export async function resetJob(recordingId: string): Promise<void> {
  await updateOne(
    Collections.jobs,
    { _id: recordingId },
    { $set: { status: "wartend", attempts: 0, lastError: null, lockedAt: null, finishedAt: null } },
  );
  await updateOne(
    Collections.recordings,
    { _id: recordingId },
    { $set: { transcriptionStatus: "wartend", transcriptionError: null } },
  );
  invalidateRecordingCache();
}
