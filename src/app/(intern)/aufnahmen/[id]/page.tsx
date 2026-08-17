import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { signPlaybackToken } from "@/lib/audio";
import { Collections, findById } from "@/lib/db";
import { getRecording, listComments, listRatings } from "@/lib/recordings";
import { loadTranscript } from "@/lib/transcription";
import { formatDateTime, formatDateTimeWithSeconds, formatDuration } from "@/lib/time";
import { StatusBadge } from "@/components/status";
import { RecordingPlayerPanel } from "@/components/recording-player-panel";
import { CommentsPanel } from "@/components/comments-panel";
import { RatingPanel } from "@/components/rating-panel";
import { DeletionFlagButton } from "@/components/deletion-flag-button";
import { TranscriptionWatcher } from "@/components/transcription-watcher";
import type { Job } from "@/lib/types";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const recording = await getRecording(id);
  return {
    title: recording ? `${recording.callerName} · ${formatDateTime(recording.callAtUtc)}` : "Aufnahme",
  };
}

export default async function AufnahmeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;

  const recording = await getRecording(id);
  if (!recording) notFound();

  const [segments, comments, ratings, job] = await Promise.all([
    recording.transcriptionStatus === "abgeschlossen" ? loadTranscript(id) : Promise.resolve([]),
    listComments(id),
    listRatings(id),
    findById<Job>(Collections.jobs, id),
  ]);

  const token = signPlaybackToken(id, user.email);
  const audioSrc = `/api/audio/${id}?token=${encodeURIComponent(token)}`;
  const startMs = Number(Array.isArray(query.t) ? query.t[0] : query.t) || 0;
  const initialQuery = String((Array.isArray(query.q) ? query.q[0] : query.q) ?? "");
  const pending =
    recording.transcriptionStatus === "wartend" || recording.transcriptionStatus === "in_arbeit";

  const metadata: [string, React.ReactNode][] = [
    ["Anrufer", recording.callerName],
    ["Telefonnummer", recording.phoneNumber || "–"],
    ["Anrufnummer", recording.callNumber || "–"],
    ["Gesprächszeitpunkt (CET)", formatDateTimeWithSeconds(recording.callAtUtc)],
    ["Dauer", formatDuration(recording.durationMs)],
    ["Originaldateiname", <span key="f" className="font-mono text-[12px]">{recording.originalFilename}</span>],
    ["Dateiformat", recording.mimeType === "audio/wav" ? "WAV" : "MP3"],
    ["Dateigrösse", `${(recording.byteSize / (1024 * 1024)).toFixed(1)} MB`],
    [
      "Metadatenquelle",
      recording.metadataSource === "manuell"
        ? "Manuell erfasst"
        : `Dateiname, Vorlage Version ${recording.templateVersion ?? "–"}`,
    ],
    ["Hochgeladen von", `${recording.uploadedByName} (${recording.uploadedByEmail})`],
    ["Upload-Zeitpunkt", formatDateTimeWithSeconds(recording.uploadedAt)],
    ["Transkription", <StatusBadge key="s" status={recording.transcriptionStatus} />],
    [
      "Transkription abgeschlossen",
      recording.transcriptionFinishedAt
        ? formatDateTimeWithSeconds(recording.transcriptionFinishedAt)
        : "–",
    ],
    ["Versuche", String(job?.attempts ?? 0)],
    [
      "Sprecher / Wörter",
      recording.speakerCount
        ? `${recording.speakerCount} / ${recording.wordCount?.toLocaleString("de-CH") ?? "–"}`
        : "–",
    ],
  ];

  return (
    <div className="space-y-4">
      <nav className="text-[12px] text-ink-faint">
        <Link href="/aufnahmen" className="hover:text-petrol hover:underline">
          Aufnahmen
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-soft">{recording.callerName}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {recording.callerName}
            <span className="ml-2 text-[15px] font-normal text-ink-soft">
              {formatDateTime(recording.callAtUtc)} Uhr
            </span>
          </h1>
          <p className="mt-1 font-mono text-[12px] text-ink-faint">{recording.originalFilename}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={recording.transcriptionStatus} />
          <DeletionFlagButton
            recordingId={recording._id}
            flagged={recording.deletionFlagged}
            variant="voll"
          />
        </div>
      </div>

      {recording.deletionFlagged && (
        <div className="notice notice-warn" role="status">
          Diese Aufnahme ist seit {formatDateTimeWithSeconds(recording.deletionFlaggedAt)} durch{" "}
          {recording.deletionFlaggedBy} zur Löschung markiert
          {recording.deletionReason ? ` (Grund: ${recording.deletionReason})` : ""}. Sämtliche Daten
          bleiben erhalten, bis die Administration die Löschung bestätigt.
        </div>
      )}

      {pending && <TranscriptionWatcher ids={[recording._id]} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <RecordingPlayerPanel
          audioSrc={audioSrc}
          segments={segments}
          status={recording.transcriptionStatus}
          errorMessage={recording.transcriptionError}
          startMs={startMs}
          initialQuery={initialQuery}
        />

        <div className="space-y-4">
          <section className="card p-4">
            <h2 className="text-[14px] font-semibold text-ink">Metadaten</h2>
            <dl className="mt-3 space-y-1.5">
              {metadata.map(([term, value]) => (
                <div key={term} className="flex gap-3 border-b border-line/70 pb-1.5 last:border-0">
                  <dt className="w-[46%] shrink-0 text-[12px] text-ink-faint">{term}</dt>
                  <dd className="text-[12.5px] text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <RatingPanel
            recordingId={recording._id}
            ratings={ratings}
            currentEmail={user.email}
            average={recording.ratingAverage}
          />

          <CommentsPanel
            recordingId={recording._id}
            comments={comments}
            currentEmail={user.email}
          />
        </div>
      </div>
    </div>
  );
}
