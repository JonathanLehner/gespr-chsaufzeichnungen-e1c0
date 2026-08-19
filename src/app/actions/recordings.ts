"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { normalizeEmail, requireUser } from "@/lib/auth";
import {
  Collections,
  deleteById,
  findById,
  findMany,
  insertOne,
  updateOne,
  upsertById,
} from "@/lib/db";
import {
  getRecording,
  invalidateRecordingCache,
  recordingIdFor,
  refreshRatingSummary,
  setDeletionFlag,
} from "@/lib/recordings";
import {
  requeueTranscription,
  runPendingJobs,
  transcribeRecording,
  type RequeueResult,
} from "@/lib/transcription";
import { getTemplateSettings } from "@/lib/settings";
import { parseFilename } from "@/lib/filename-template";
import { mimeFromExtension, fingerprintOf, MAX_UPLOAD_BYTES } from "@/lib/audio";
import type { Comment, Rating, Recording, TranscriptionStatus } from "@/lib/types";

export type ActionResult = { ok: boolean; message: string };

/* ------------------------------------------------------- Upload-Vorbereitung */

export type FileCandidate = { name: string; size: number };

/**
 * Grund einer Beanstandung. „format“, „zu-gross“ und „leer“ sind harte
 * Ausschlüsse: Sie lassen sich im Korrektur-Modal nicht beheben, weil nicht die
 * Metadaten, sondern die Datei selbst das Problem ist.
 */
export type PreparedProblem = "format" | "zu-gross" | "leer" | "dateiname" | "vorhanden";

export type PreparedFile = {
  name: string;
  size: number;
  ok: boolean;
  problem: string | null;
  /** Auslöser der Beanstandung, damit die Übersicht den Grund benennen kann. */
  reason: PreparedProblem | null;
  /** Datei ist grundsätzlich untauglich – auch mit korrigierten Metadaten. */
  blocked: boolean;
  duplicate: boolean;
  metadata: {
    callerName: string;
    callerFirstName: string;
    callerLastName: string;
    phoneNumber: string;
    callNumber: string;
    callAtUtc: string;
  } | null;
};

export type PreparedUpload = {
  template: string;
  templateVersion: number;
  files: PreparedFile[];
};

/** Liest die Metadaten aller ausgewählten Dateien aus den Dateinamen. */
export async function prepareUploadAction(candidates: FileCandidate[]): Promise<PreparedUpload> {
  await requireUser();
  const settings = await getTemplateSettings();

  const ids = candidates.map((candidate) => recordingIdFor(fingerprintOf(candidate.name, candidate.size)));
  const existing =
    ids.length > 0 ? await findMany<Recording>(Collections.recordings, { _id: { $in: ids } }) : [];
  const existingIds = new Set(existing.map((row) => row._id));

  const files: PreparedFile[] = candidates.map((candidate) => {
    const id = recordingIdFor(fingerprintOf(candidate.name, candidate.size));
    const duplicate = existingIds.has(id);
    const mime = mimeFromExtension(candidate.name);
    if (!mime) {
      return {
        name: candidate.name,
        size: candidate.size,
        ok: false,
        problem: "Nicht unterstütztes Dateiformat. Zulässig sind ausschliesslich WAV und MP3.",
        reason: "format",
        blocked: true,
        duplicate,
        metadata: null,
      };
    }
    if (candidate.size > MAX_UPLOAD_BYTES) {
      return {
        name: candidate.name,
        size: candidate.size,
        ok: false,
        problem: "Die Datei ist grösser als 50 MB und kann nicht hochgeladen werden.",
        reason: "zu-gross",
        blocked: true,
        duplicate,
        metadata: null,
      };
    }
    if (candidate.size === 0) {
      return {
        name: candidate.name,
        size: candidate.size,
        ok: false,
        problem: "Die Datei ist leer.",
        reason: "leer",
        blocked: true,
        duplicate,
        metadata: null,
      };
    }
    const parsed = parseFilename(candidate.name, settings.template);
    if (!parsed.ok) {
      return {
        name: candidate.name,
        size: candidate.size,
        ok: false,
        problem: parsed.error,
        reason: "dateiname",
        blocked: false,
        duplicate,
        metadata: null,
      };
    }
    return {
      name: candidate.name,
      size: candidate.size,
      ok: !duplicate,
      problem: duplicate ? "Diese Datei wurde bereits hochgeladen." : null,
      reason: duplicate ? "vorhanden" : null,
      blocked: false,
      duplicate,
      metadata: parsed.data,
    };
  });

  return { template: settings.template, templateVersion: settings.version, files };
}

/* --------------------------------------------------------------- Statusabruf */

export type StatusUpdate = {
  id: string;
  status: TranscriptionStatus;
  error: string | null;
  nextAttemptAt: string | null;
  wordCount: number | null;
  speakerCount: number | null;
};

/**
 * Liefert den aktuellen Transkriptionsstatus und stösst dabei offene sowie
 * fällige Aufträge an. Die Oberfläche fragt nur so lange nach, wie Aufträge
 * offen sind oder eine automatische Wiederholung aussteht.
 */
export async function transcriptionStatusAction(ids: string[]): Promise<StatusUpdate[]> {
  await requireUser();
  if (ids.length === 0) return [];
  const rows = await findMany<Recording>(Collections.recordings, { _id: { $in: ids.slice(0, 100) } });
  const now = new Date().toISOString();
  const pending = rows.some(
    (row) => row.transcriptionStatus === "wartend" || row.transcriptionStatus === "in_arbeit",
  );
  const retryDue = rows.some(
    (row) =>
      row.transcriptionStatus === "fehlgeschlagen" &&
      !!row.transcriptionNextAttemptAt &&
      row.transcriptionNextAttemptAt <= now,
  );
  if (pending || retryDue) {
    await runPendingJobs(1);
    const refreshed = await findMany<Recording>(Collections.recordings, {
      _id: { $in: ids.slice(0, 100) },
    });
    return refreshed.map(toStatusUpdate);
  }
  return rows.map(toStatusUpdate);
}

function toStatusUpdate(row: Recording): StatusUpdate {
  return {
    id: row._id,
    status: row.transcriptionStatus,
    error: row.transcriptionError,
    nextAttemptAt: row.transcriptionNextAttemptAt ?? null,
    wordCount: row.wordCount,
    speakerCount: row.speakerCount,
  };
}

/* ------------------------------------------------------- Transkription neu starten */

/**
 * Startet die Transkription einer Aufnahme neu. Die Funktion steht allen
 * angemeldeten Mitarbeitenden offen und ist idempotent – ein zweiter Aufruf
 * meldet lediglich, dass der Auftrag bereits läuft.
 */
export async function restartTranscriptionAction(recordingId: string): Promise<RequeueResult> {
  await requireUser();
  const result = await requeueTranscription(recordingId);

  if (result.state === "gestartet") {
    after(async () => {
      try {
        await transcribeRecording(recordingId);
      } catch {
        /* Der Fehler wird am Auftrag festgehalten. */
      }
    });
  }

  revalidatePath("/aufnahmen");
  revalidatePath(`/aufnahmen/${recordingId}`);
  revalidatePath("/admin");
  return result;
}

/* ----------------------------------------------------------- Löschmarkierung */

export async function toggleDeletionFlagAction(
  recordingId: string,
  flagged: boolean,
  reason: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  await setDeletionFlag(recordingId, flagged, user.email, reason);
  revalidatePath("/aufnahmen");
  revalidatePath(`/aufnahmen/${recordingId}`);
  revalidatePath("/admin");
  return {
    ok: true,
    message: flagged
      ? "Zur Löschung vorgemerkt – über die endgültige Löschung entscheidet die Administration."
      : "Die Löschmarkierung wurde aufgehoben.",
  };
}

/* ------------------------------------------------------------- Kommentare */

export async function addCommentAction(recordingId: string, text: string): Promise<ActionResult> {
  const user = await requireUser();
  const trimmed = text.trim();
  if (trimmed.length < 2) return { ok: false, message: "Bitte geben Sie einen Kommentartext ein." };
  if (trimmed.length > 4000) return { ok: false, message: "Der Kommentar ist zu lang (max. 4000 Zeichen)." };

  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  await insertOne(Collections.comments, {
    _id: randomUUID(),
    recordingId,
    text: trimmed,
    authorEmail: user.email,
    authorName: user.name,
    createdAt: new Date().toISOString(),
    editedAt: null,
  });
  revalidatePath(`/aufnahmen/${recordingId}`);
  revalidatePath("/admin");
  return { ok: true, message: "Kommentar gespeichert." };
}

/**
 * Ändert den Text eines eigenen Kommentars. Fremde Kommentare bleiben
 * unantastbar – sie entfernt ausschliesslich der Superuser im Admin-Dashboard.
 */
export async function updateCommentAction(commentId: string, text: string): Promise<ActionResult> {
  const user = await requireUser();
  const trimmed = text.trim();
  if (trimmed.length < 2) return { ok: false, message: "Bitte geben Sie einen Kommentartext ein." };
  if (trimmed.length > 4000) return { ok: false, message: "Der Kommentar ist zu lang (max. 4000 Zeichen)." };

  const comment = await findById<Comment>(Collections.comments, commentId);
  if (!comment) return { ok: false, message: "Der Kommentar besteht nicht mehr." };
  if (normalizeEmail(comment.authorEmail) !== normalizeEmail(user.email)) {
    return { ok: false, message: "Sie können ausschliesslich Ihre eigenen Kommentare bearbeiten." };
  }
  if (trimmed === comment.text) {
    return { ok: true, message: "Der Kommentar wurde nicht verändert." };
  }

  await updateOne(
    Collections.comments,
    { _id: commentId },
    { $set: { text: trimmed, editedAt: new Date().toISOString() } },
  );
  revalidatePath(`/aufnahmen/${comment.recordingId}`);
  revalidatePath("/admin");
  return { ok: true, message: "Kommentar geändert." };
}

/** Löscht einen eigenen Kommentar. Ein zweiter Aufruf meldet denselben Erfolg. */
export async function deleteCommentAction(commentId: string): Promise<ActionResult> {
  const user = await requireUser();
  const comment = await findById<Comment>(Collections.comments, commentId);
  if (!comment) return { ok: true, message: "Der Kommentar wurde bereits gelöscht." };
  if (normalizeEmail(comment.authorEmail) !== normalizeEmail(user.email)) {
    return { ok: false, message: "Sie können ausschliesslich Ihre eigenen Kommentare löschen." };
  }

  await deleteById(Collections.comments, commentId);
  revalidatePath(`/aufnahmen/${comment.recordingId}`);
  revalidatePath("/admin");
  return { ok: true, message: "Kommentar gelöscht." };
}

/* ------------------------------------------------------------ Bewertungen */

export async function setRatingAction(recordingId: string, score: number): Promise<ActionResult> {
  const user = await requireUser();
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    return { ok: false, message: "Bitte wählen Sie eine Bewertung zwischen 1 und 10." };
  }
  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  const id = `${recordingId}:${user.email}`;
  const existing = await findById<Rating>(Collections.ratings, id);
  const now = new Date().toISOString();
  await upsertById(Collections.ratings, id, {
    recordingId,
    score,
    authorEmail: user.email,
    authorName: user.name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await refreshRatingSummary(recordingId);
  invalidateRecordingCache();
  revalidatePath(`/aufnahmen/${recordingId}`);
  revalidatePath("/aufnahmen");
  return {
    ok: true,
    message: existing ? "Ihre Bewertung wurde aktualisiert." : "Bewertung gespeichert.",
  };
}
