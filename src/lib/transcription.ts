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
import {
  measureDurationMs,
  splitAudio,
  type AudioChunk,
} from "../../transcriber/shared/audio-split";
import { alignTranscript } from "../../transcriber/shared/forced-alignment";
import {
  PROMPT,
  chunkPrompt,
  mergeChunks,
  normalizeTranscript,
  parseJsonLoosely,
  shiftSegments,
  splitIntoParts,
  type NormalizedTranscript,
} from "../../transcriber/shared/transcript";
import { platformGemini, type GeminiPart } from "./platform";
import { readFileBytes, storeFile } from "./storage";
import { invalidateRecordingCache } from "./recordings";
import type {
  AlignmentSource,
  Job,
  Recording,
  TranscriptIndexDoc,
  TranscriptPartDoc,
  TranscriptSegment,
} from "./types";

const MODEL = "gemini-2.5-flash";
export const MAX_ATTEMPTS = 3;
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Zerlegung langer Aufnahmen.
 *
 * Am Dienst gemessen: Die Antwortzeit hängt vor allem an der Menge des
 * erzeugten JSON, und die wächst mit der Gesprächslänge. Ein zehnminütiges
 * Gespräch in einer Anfrage läuft in die Zeitüberschreitung des vorgelagerten
 * Gateways – bei jedem Versuch gleich. Eine Wiederholung mit derselben Datei
 * hilft deshalb nicht.
 *
 * Ab `DIRECT_LIMIT_MS` wird darum in Abschnitte von `CHUNK_TARGET_MS` geteilt.
 * Jede einzelne Anfrage bleibt dadurch kurz (gemessen 16–31 s je Abschnitt),
 * unabhängig davon, wie lang das Gespräch ist. Zwei Abschnitte laufen
 * gleichzeitig; bei mehr geraten die Anfragen einander in die Quere und
 * einzelne blieben in der Messung hängen.
 *
 * Die Abschnitte werden vorher abgelegt und über `fileData` referenziert: Der
 * Gemini-Endpunkt nimmt höchstens 200 KB Anfragekörper entgegen, Audiodaten
 * passen also nicht als `inlineData` hinein.
 */
const DIRECT_LIMIT_MS = 2 * 60 * 1000;
const CHUNK_TARGET_MS = 60 * 1000;
const CHUNK_CONCURRENCY = 2;
/** Eigene Frist je Anfrage, damit ein hängender Aufruf berechenbar abbricht. */
const GEMINI_TIMEOUT_MS = 120 * 1000;
const TRANSFER_TIMEOUT_MS = 60 * 1000;
/**
 * Der Dienst bleibt gelegentlich bei einer einzelnen Anfrage hängen, während
 * die übrigen Anfragen desselben Laufs in 20 bis 45 Sekunden antworten. Ein
 * Abschnitt wird deshalb bis zu dreimal angefragt.
 */
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_PAUSE_MS = 2000;

/**
 * Wartezeit bis zur nächsten automatischen Wiederholung, gemessen an der Zahl
 * der bisherigen Versuche. Ein sofortiger zweiter Anlauf hilft bei einer
 * Zeitüberschreitung des Dienstes nicht weiter, deshalb der zeitliche Abstand.
 */
const RETRY_DELAYS_MS = [3 * 60 * 1000, 15 * 60 * 1000];

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
  const closed =
    status === "abgeschlossen" || status === "ohne_sprache" || status === "fehlgeschlagen";
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

/* ------------------------------------------------------------ Ausführung */

/** Eine Anfrage an den Dienst, mit eigener Frist und ausgewertetem JSON. */
async function requestTranscript(prompt: string, audio: GeminiPart): Promise<NormalizedTranscript> {
  const response = await platformGemini(
    {
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }, audio] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    },
    { timeoutMs: GEMINI_TIMEOUT_MS },
  );
  return normalizeTranscript(parseJsonLoosely(response.text ?? ""));
}

export type TranscriptGap = { startMs: number; endMs: number };

/**
 * Transkribiert die Abschnitte einer Aufnahme. Es laufen höchstens
 * `CHUNK_CONCURRENCY` Abschnitte gleichzeitig – so bleibt die Zahl offener
 * Anfragen an den Dienst begrenzt und es liegen nie mehr als zwei
 * Abschnittskopien gleichzeitig im Speicher.
 *
 * Bleibt ein Abschnitt auch nach `CHUNK_ATTEMPTS` Anläufen ohne Antwort, kostet
 * das nur diesen Abschnitt: Sein Zeitbereich wird als Lücke gemeldet, der Rest
 * des Gesprächs steht als Transkript zur Verfügung. Genau darin liegt der
 * zweite Gewinn der Zerlegung – vorher fiel bei jedem Aussetzer das ganze
 * Transkript aus.
 */
async function transcribeChunks(
  recording: Recording,
  chunks: AudioChunk[],
): Promise<NormalizedTranscript & { gaps: TranscriptGap[] }> {
  const parts = new Array<NormalizedTranscript | null>(chunks.length).fill(null);
  const gaps: TranscriptGap[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < chunks.length; index = next++) {
      const chunk = chunks[index];
      const prompt = chunkPrompt(index, chunks.length);
      const label = `${recording._id} Abschnitt ${index + 1}/${chunks.length}`;

      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        const started = Date.now();
        try {
          // Jeder Anlauf legt den Abschnitt neu ab und fragt unter der neuen
          // Adresse an. Eine Wiederholung mit unverändertem Verweis lief in der
          // Messung dreimal in dieselbe Zeitüberschreitung, ein neuer Verweis
          // dagegen durch – das Ablegen kostet dabei nur rund eine Sekunde.
          const uploaded = await storeFile(chunk.toBytes(), recording.mimeType);
          const audio: GeminiPart = {
            fileData: { fileUri: uploaded.url, mimeType: recording.mimeType },
          };
          const part = await requestTranscript(prompt, audio);
          parts[index] = { ...part, segments: shiftSegments(part.segments, chunk.startMs) };
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[transkription] ${label}: Anlauf ${attempt} nach ${Date.now() - started} ms ` +
              `fehlgeschlagen – ${message}`,
          );
          if (attempt === CHUNK_ATTEMPTS) {
            gaps.push({ startMs: chunk.startMs, endMs: chunk.endMs });
          } else {
            await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_PAUSE_MS));
          }
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, () => worker()),
  );

  const done = parts.filter((part): part is NormalizedTranscript => part !== null);
  if (done.length === 0) {
    throw new Error("Der Transkriptionsdienst hat auf keinen Abschnitt der Aufnahme geantwortet.");
  }
  gaps.sort((a, b) => a.startMs - b.startMs);
  return { ...mergeChunks(done), gaps };
}

type RunResult = NormalizedTranscript & {
  chunkCount: number;
  measuredDurationMs: number | null;
  gaps: TranscriptGap[];
  alignment: AlignmentSource;
};

/**
 * Wählt den Weg zum Transkript und richtet es anschliessend an der Aufnahme
 * aus.
 *
 * Kurze Aufnahmen gehen unverändert als eine Anfrage an den Dienst; erst für
 * längere lohnt es sich, sie zu zerlegen. Lässt sich das Format nicht
 * verlustfrei schneiden, bleibt es beim einen Aufruf.
 *
 * Die Datei selbst wird in jedem Fall geholt, weil die Zeiten des Dienstes
 * verworfen und aus dem Lautstärkeverlauf neu bestimmt werden (siehe
 * `transcriber/shared/forced-alignment.ts`). Misslingt der Abruf, ist das kein Fehlschlag:
 * Das Transkript entsteht dann mit den geschätzten Zeiten, wie es sie bisher
 * hatte.
 */
async function runTranscription(recording: Recording): Promise<RunResult> {
  let bytes: Uint8Array | null = null;
  try {
    bytes = await readFileBytes(recording.audioUrl, { timeoutMs: TRANSFER_TIMEOUT_MS });
  } catch (error) {
    console.warn(
      `[transkription] ${recording._id}: Audiodatei nicht abrufbar – ` +
        `Wortzeiten bleiben geschätzt (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const measuredDurationMs = bytes ? measureDurationMs(bytes, recording.mimeType) : null;
  const durationMs = measuredDurationMs ?? recording.durationMs;

  const whole = async () => ({
    ...(await requestTranscript(PROMPT, {
      fileData: { fileUri: recording.audioUrl, mimeType: recording.mimeType },
    })),
    chunkCount: 1,
    gaps: [] as TranscriptGap[],
  });

  const chunks =
    bytes && (durationMs === null || durationMs > DIRECT_LIMIT_MS)
      ? splitAudio(bytes, recording.mimeType, CHUNK_TARGET_MS)
      : null;
  const base =
    chunks && chunks.length >= 2
      ? { ...(await transcribeChunks(recording, chunks)), chunkCount: chunks.length }
      : await whole();

  const aligned = bytes
    ? alignTranscript(base.segments, bytes, recording.mimeType, { gaps: base.gaps })
    : null;
  const segments = aligned?.segments ?? base.segments;

  return {
    ...base,
    segments,
    endMs: segments.length > 0 ? segments[segments.length - 1].endMs : 0,
    measuredDurationMs,
    alignment: aligned ? "akustisch" : "geschaetzt",
  };
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
  if (job && (job.status === "abgeschlossen" || job.status === "ohne_sprache")) return { ok: true };
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
    const result = await runTranscription(recording);
    // Auch das leere Ergebnis wird geschrieben: Es räumt ein früheres Transkript
    // ab und hält den Suchindex mit dem Datensatz im Einklang.
    await saveTranscript(recordingId, result.segments, result.speakerLabels);

    const duration = result.measuredDurationMs ?? recording.durationMs ?? result.endMs;
    await updateOne(
      Collections.recordings,
      { _id: recordingId },
      {
        $set: {
          speakerCount: result.speakerLabels.length,
          wordCount: result.wordCount,
          transcriptionChunks: result.chunkCount,
          transcriptionGaps: result.gaps.length > 0 ? result.gaps : null,
          transcriptionAlignment: result.alignment,
          ...(duration > 0 ? { durationMs: duration } : {}),
        },
      },
    );

    // Ein leeres Transkript heisst: Der Dienst hat die Aufnahme gehört und
    // nichts Gesprochenes gefunden. Das ist ein Abschluss, kein Fehlschlag –
    // eine Wiederholung käme zum selben Ergebnis.
    await setStatus(recordingId, result.segments.length === 0 ? "ohne_sprache" : "abgeschlossen", {
      lastError: null,
      attempts,
    });
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
 * deren Wartezeit abgelaufen ist. Nur noch für die Schaltfläche im
 * Adminbereich; regulär arbeitet der Transkriptionsdienst (`transcriber/`) die
 * Warteschlange ab.
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
        // Zwischenstand des Transkriptionsdienstes (`transcriber/`) verwerfen.
        progress: null,
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
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();

  if (job && job.status === "in_arbeit" && (job.lockedAt ?? "") > stale) {
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
    await setStatus(recordingId, "wartend", { lastError: null, attempts: 0 });
  }

  return { ok: true, message: "Die Transkription wurde neu eingereiht.", state: "gestartet" };
}
