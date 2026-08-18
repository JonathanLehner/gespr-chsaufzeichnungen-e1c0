"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  DEFAULT_TEMPLATE,
  parseFilename,
  validateTemplate,
  type TemplateValidation,
} from "@/lib/filename-template";
import { saveTemplate } from "@/lib/settings";
import { getRecording, hardDeleteRecording } from "@/lib/recordings";
import { requeueTranscription, runPendingJobs, transcribeRecording } from "@/lib/transcription";

export type TemplatePreview = {
  validation: TemplateValidation;
  parsed:
    | { ok: true; callerName: string; phoneNumber: string; callNumber: string; callAtUtc: string }
    | { ok: false; error: string }
    | null;
};

export async function previewTemplateAction(
  template: string,
  testFilename: string,
): Promise<TemplatePreview> {
  await requireAdmin();
  const validation = validateTemplate(template);
  if (!validation.valid) return { validation, parsed: null };
  if (!testFilename.trim()) return { validation, parsed: null };

  const result = parseFilename(testFilename, template);
  if (!result.ok) return { validation, parsed: { ok: false, error: result.error } };
  return {
    validation,
    parsed: {
      ok: true,
      callerName: result.data.callerName,
      phoneNumber: result.data.phoneNumber,
      callNumber: result.data.callNumber,
      callAtUtc: result.data.callAtUtc,
    },
  };
}

export async function saveTemplateAction(
  template: string,
): Promise<{ ok: boolean; message: string; version?: number }> {
  const admin = await requireAdmin();
  const validation = validateTemplate(template);
  if (!validation.valid) {
    return { ok: false, message: validation.errors[0] ?? "Die Vorlage ist ungültig." };
  }
  const saved = await saveTemplate(template.trim(), admin.email);
  revalidatePath("/admin");
  revalidatePath("/upload");
  return {
    ok: true,
    version: saved.version,
    message: `Vorlage gespeichert (Version ${saved.version}). Bestehende Aufnahmen behalten ihre bisherigen Metadaten.`,
  };
}

export async function resetToDefaultTemplateAction(): Promise<{
  ok: boolean;
  message: string;
  template: string;
}> {
  const admin = await requireAdmin();
  const saved = await saveTemplate(DEFAULT_TEMPLATE, admin.email);
  revalidatePath("/admin");
  revalidatePath("/upload");
  return {
    ok: true,
    template: saved.template,
    message: `Standardvorlage wiederhergestellt (Version ${saved.version}).`,
  };
}

export async function retryTranscriptionAction(
  recordingId: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  const result = await requeueTranscription(recordingId, { allowCompleted: true });
  if (result.state === "gestartet") {
    after(async () => {
      try {
        await transcribeRecording(recordingId);
      } catch {
        /* Der Fehler wird am Auftrag festgehalten. */
      }
    });
  }
  revalidatePath("/admin");
  revalidatePath("/aufnahmen");
  revalidatePath(`/aufnahmen/${recordingId}`);
  return {
    ok: result.ok,
    message:
      result.state === "gestartet"
        ? `Transkription für ${recording.originalFilename} neu gestartet.`
        : result.message,
  };
}

export async function runQueueAction(): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const done = await runPendingJobs(2);
  revalidatePath("/admin");
  revalidatePath("/aufnahmen");
  return {
    ok: true,
    message:
      done > 0
        ? `${done} ${done === 1 ? "Auftrag wurde" : "Aufträge wurden"} abgearbeitet.`
        : "Es waren keine offenen Aufträge vorhanden oder sie werden bereits bearbeitet.",
  };
}

export async function hardDeleteRecordingAction(
  recordingId: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };

  await hardDeleteRecording(recordingId);
  revalidatePath("/admin");
  revalidatePath("/aufnahmen");
  return {
    ok: true,
    message: `„${recording.originalFilename}“ wurde mit Transkript, Kommentaren und Bewertungen endgültig gelöscht.`,
  };
}
