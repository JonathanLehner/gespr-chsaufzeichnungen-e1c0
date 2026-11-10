"use server";

import { revalidatePath } from "next/cache";
import { isSuperuser, normalizeEmail, requireAdmin } from "@/lib/auth";
import { Collections, deleteById, findById } from "@/lib/db";
import {
  DEFAULT_TEMPLATE,
  parseFilename,
  validateTemplate,
  type TemplateValidation,
} from "@/lib/filename-template";
import { issueAuthLink, sendTestMail } from "@/lib/mail";
import { DELIVERY_LABELS, EMAIL_PATTERN, type MailSettingsInput } from "@/lib/mail-config";
import { saveMailSettings } from "@/lib/mailer";
import { saveTemplate } from "@/lib/settings";
import { getRecording, hardDeleteRecording } from "@/lib/recordings";
import {
  liftSpendingBlock,
  moveJobToFront,
  requeueAllFailed,
  retryJobNow,
  saveQueueSettings,
  setQueuePaused,
  type SettingsInput,
} from "@/lib/transcription";
import type { Comment, User } from "@/lib/types";

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

/* --------------------------------------------------------------- Transkriptionsdienst */

type ActionResult = { ok: boolean; message: string };

function revalidateQueue(recordingId?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/transkription");
  revalidatePath("/aufnahmen");
  if (recordingId) revalidatePath(`/aufnahmen/${recordingId}`);
}

export async function setQueuePausedAction(paused: boolean): Promise<ActionResult> {
  const admin = await requireAdmin();
  await setQueuePaused(paused, admin.email);
  revalidateQueue();
  return { ok: true, message: paused ? "Warteschlange pausiert." : "Warteschlange läuft wieder." };
}

export async function liftSpendingBlockAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const lifted = await liftSpendingBlock(admin.email);
  revalidateQueue();
  return lifted
    ? { ok: true, message: "Sperre aufgehoben. Die Warteschlange läuft wieder." }
    : { ok: true, message: "Es besteht keine Sperre mehr." };
}

export async function saveQueueSettingsAction(input: SettingsInput): Promise<ActionResult> {
  const admin = await requireAdmin();
  const result = await saveQueueSettings(input, admin.email);
  if (result.ok) revalidateQueue();
  return result;
}

export async function retryJobAction(recordingId: string): Promise<ActionResult> {
  await requireAdmin();
  const recording = await getRecording(recordingId);
  if (!recording) return { ok: false, message: "Aufnahme nicht gefunden." };
  const result = await retryJobNow(recordingId);
  revalidateQueue(recordingId);
  return {
    ok: result.ok,
    message:
      result.state === "gestartet" && result.message.includes("eingereiht")
        ? `Transkription für ${recording.originalFilename} neu gestartet.`
        : result.message,
  };
}

export async function moveJobToFrontAction(recordingId: string): Promise<ActionResult> {
  await requireAdmin();
  const result = await moveJobToFront(recordingId);
  revalidateQueue(recordingId);
  return result;
}

export async function requeueAllFailedAction(): Promise<ActionResult> {
  await requireAdmin();
  const count = await requeueAllFailed();
  revalidateQueue();
  return {
    ok: true,
    message: count === 0 ? "Keine fehlgeschlagenen Aufträge." : `${count} ${count === 1 ? "Auftrag" : "Aufträge"} neu eingereiht.`,
  };
}

/* --------------------------------------------------------------- E-Mail */

/**
 * Reset-Links und die Zugangsdaten des Versanddienstes bleiben allein dem
 * Superuser vorbehalten. `requireAdmin` genügt dafür nicht, weil die Rolle
 * „admin“ grundsätzlich auch an weitere Konten vergeben werden könnte.
 */
async function requireSuperuser() {
  const admin = await requireAdmin();
  if (!isSuperuser(admin.email)) throw new Error("KEINE_BERECHTIGUNG");
  return admin;
}

export type ResetLinkResult =
  | { ok: true; email: string; url: string; expiresAt: string; delivery: string }
  | { ok: false; message: string };

/**
 * Erzeugt einen Link zum Zurücksetzen des Passworts, verschickt ihn und gibt
 * ihn zusätzlich zurück. Angezeigt wird er ausschliesslich dem angemeldeten
 * Superuser und nur unmittelbar nach dem Klick – der Postausgang zeigt ihn
 * weiterhin nie an.
 */
export async function createPasswordResetLinkAction(email: string): Promise<ResetLinkResult> {
  const admin = await requireSuperuser();
  const target = normalizeEmail(email);
  const user = await findById<User>(Collections.users, target);
  if (!user) return { ok: false, message: "Zu dieser Adresse besteht kein Konto." };

  const issued = await issueAuthLink(target, "passwort_reset", { issuedBy: admin.email });
  revalidatePath("/admin");
  return {
    ok: true,
    email: target,
    url: issued.url,
    expiresAt: issued.expiresAt,
    delivery:
      issued.delivery.status === "gesendet"
        ? `Die E-Mail wurde zusätzlich an ${target} zugestellt.`
        : `Die E-Mail konnte nicht zugestellt werden (${DELIVERY_LABELS[issued.delivery.status]}). Bitte geben Sie den Link persönlich weiter.`,
  };
}

export async function saveMailSettingsAction(
  input: MailSettingsInput,
): Promise<{ ok: boolean; message: string }> {
  const admin = await requireSuperuser();
  const result = await saveMailSettings(input, admin.email);
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/admin");
  return { ok: true, message: "Einstellungen für den E-Mail-Versand gespeichert." };
}

export async function sendTestMailAction(to: string): Promise<{ ok: boolean; message: string }> {
  const admin = await requireSuperuser();
  const target = normalizeEmail(to) || admin.email;
  if (!EMAIL_PATTERN.test(target)) {
    return { ok: false, message: "Bitte geben Sie eine gültige E-Mail-Adresse an." };
  }
  const delivery = await sendTestMail(target);
  if (delivery.status === "gesendet") {
    return { ok: true, message: `Testnachricht an ${target} übergeben (${delivery.provider}).` };
  }
  return {
    ok: false,
    message: `${DELIVERY_LABELS[delivery.status]}: ${delivery.error ?? "unbekannter Fehler"}`,
  };
}

/**
 * Entfernt einen beliebigen Kommentar. Mitarbeitende bearbeiten und löschen
 * ausschliesslich ihre eigenen Kommentare (siehe `actions/recordings.ts`);
 * fremde Beiträge entfernt nur der Superuser an dieser Stelle.
 */
export async function deleteForeignCommentAction(
  commentId: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const comment = await findById<Comment>(Collections.comments, commentId);
  if (!comment) return { ok: true, message: "Der Kommentar wurde bereits entfernt." };

  await deleteById(Collections.comments, commentId);
  revalidatePath("/admin");
  revalidatePath(`/aufnahmen/${comment.recordingId}`);
  return { ok: true, message: `Kommentar von ${comment.authorName} entfernt.` };
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
