import { after, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  MAX_UPLOAD_BYTES,
  detectAudioSignature,
  fingerprintOf,
  mimeFromExtension,
  wavDurationMs,
} from "@/lib/audio";
import { parseFilename } from "@/lib/filename-template";
import { platformUploadAudio } from "@/lib/platform";
import { createRecording, invalidateRecordingCache } from "@/lib/recordings";
import { getTemplateSettings } from "@/lib/settings";
import { runPendingJobs } from "@/lib/transcription";

export const runtime = "nodejs";
export const maxDuration = 120;

type UploadMetadata = {
  callerName?: string;
  callerFirstName?: string;
  callerLastName?: string;
  phoneNumber?: string;
  callNumber?: string;
  callAtUtc?: string;
  metadataSource?: "dateiname" | "manuell";
  durationMs?: number | null;
};

function fail(message: string, status = 400) {
  return Response.json({ status: "fehler", message }, { status });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return fail("Nicht angemeldet. Bitte melden Sie sich erneut an.", 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Die Datei konnte nicht gelesen werden.");
  }

  const file = form.get("datei");
  const rawMetadata = form.get("metadaten");
  if (!(file instanceof File)) return fail("Es wurde keine Datei übermittelt.");

  let metadata: UploadMetadata = {};
  if (typeof rawMetadata === "string" && rawMetadata.trim()) {
    try {
      metadata = JSON.parse(rawMetadata) as UploadMetadata;
    } catch {
      return fail("Die übermittelten Metadaten sind fehlerhaft.");
    }
  }

  const filename = file.name.trim();
  const mimeByExtension = mimeFromExtension(filename);
  if (!mimeByExtension) {
    return fail("Nicht unterstütztes Dateiformat. Zulässig sind ausschliesslich WAV und MP3.");
  }
  if (file.size === 0) return fail("Die Datei ist leer.");
  if (file.size > MAX_UPLOAD_BYTES) return fail("Die Datei ist grösser als 50 MB.");

  const fingerprint = fingerprintOf(filename, file.size);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = detectAudioSignature(bytes);
  if (!signature) {
    return fail(
      "Der Inhalt der Datei ist weder eine gültige WAV- noch eine gültige MP3-Datei.",
    );
  }
  if (signature !== mimeByExtension) {
    return fail(
      `Der Dateiinhalt (${signature === "audio/wav" ? "WAV" : "MP3"}) passt nicht zur Dateiendung.`,
    );
  }

  const settings = await getTemplateSettings();
  let resolved: {
    callerName: string;
    callerFirstName: string;
    callerLastName: string;
    phoneNumber: string;
    callNumber: string;
    callAtUtc: string;
    metadataSource: "dateiname" | "manuell";
    templateVersion: number | null;
  };

  if (metadata.metadataSource === "manuell") {
    const callerName = (metadata.callerName ?? "").trim();
    const callAt = new Date(metadata.callAtUtc ?? "");
    if (!callerName) return fail("Bitte erfassen Sie den Namen der anrufenden Person.");
    if (Number.isNaN(callAt.getTime())) return fail("Bitte erfassen Sie einen gültigen Gesprächszeitpunkt.");
    const parts = callerName.split(/\s+/);
    resolved = {
      callerName,
      callerFirstName: (metadata.callerFirstName ?? parts.slice(0, -1).join(" ")).trim(),
      callerLastName: (metadata.callerLastName ?? parts[parts.length - 1] ?? "").trim(),
      phoneNumber: (metadata.phoneNumber ?? "").trim(),
      callNumber: (metadata.callNumber ?? "").trim(),
      callAtUtc: callAt.toISOString(),
      metadataSource: "manuell",
      templateVersion: null,
    };
  } else {
    const parsed = parseFilename(filename, settings.template);
    if (!parsed.ok) return fail(parsed.error);
    resolved = { ...parsed.data, metadataSource: "dateiname", templateVersion: settings.version };
  }

  const durationFromFile =
    signature === "audio/wav"
      ? wavDurationMs(bytes)
      : typeof metadata.durationMs === "number" && metadata.durationMs > 0
        ? Math.round(metadata.durationMs)
        : null;

  try {
    const uploaded = await platformUploadAudio(bytes);
    const { created, recording } = await createRecording({
      originalFilename: filename,
      audioUrl: uploaded.url,
      mimeType: signature,
      byteSize: file.size,
      durationMs: durationFromFile,
      callerName: resolved.callerName,
      callerFirstName: resolved.callerFirstName,
      callerLastName: resolved.callerLastName,
      phoneNumber: resolved.phoneNumber,
      callNumber: resolved.callNumber,
      callAtUtc: resolved.callAtUtc,
      metadataSource: resolved.metadataSource,
      templateVersion: resolved.templateVersion,
      uploadedByEmail: user.email,
      uploadedByName: user.name,
      fingerprint,
    });
    invalidateRecordingCache();

    if (created) {
      after(async () => {
        try {
          await runPendingJobs(1);
        } catch {
          /* Fehler werden im Auftrag festgehalten */
        }
      });
    }

    return Response.json({
      status: created ? "ok" : "vorhanden",
      id: recording._id,
      message: created
        ? "Hochgeladen. Die Transkription wurde gestartet."
        : "Diese Datei ist bereits vorhanden und wurde nicht erneut angelegt.",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Der Upload ist unerwartet fehlgeschlagen.";
    return Response.json({ status: "fehler", message }, { status: 502 });
  }
}
