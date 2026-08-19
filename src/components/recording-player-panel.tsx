"use client";

import { useCallback, useRef, useState } from "react";
import { WaveformPlayer, type PlayerHandle } from "@/components/waveform-player";
import { TranscriptView } from "@/components/transcript-view";
import { RetryTranscriptionButton } from "@/components/retry-transcription-button";
import { describeTranscriptionError, retryHint } from "@/lib/transcription-errors";
import type { TranscriptSegment, TranscriptionStatus } from "@/lib/types";

export function RecordingPlayerPanel({
  audioSrc,
  recordingId,
  segments,
  status,
  errorMessage,
  nextAttemptLabel,
  lastAttemptAt,
  startMs,
  initialQuery,
}: {
  audioSrc: string;
  recordingId: string;
  segments: TranscriptSegment[];
  status: TranscriptionStatus;
  errorMessage: string | null;
  nextAttemptLabel: string | null;
  /** Zeitpunkt des letzten Versuchs – setzt die Schaltfläche nach einem neuen Fehlschlag zurück. */
  lastAttemptAt: string | null;
  startMs: number;
  initialQuery: string;
}) {
  const playerRef = useRef<PlayerHandle>(null);
  const [currentMs, setCurrentMs] = useState(startMs);

  const handleTime = useCallback((ms: number) => setCurrentMs(ms), []);
  const handleSeek = useCallback((ms: number) => playerRef.current?.playFromMs(ms), []);

  return (
    <div className="space-y-4">
      <WaveformPlayer ref={playerRef} src={audioSrc} startMs={startMs} onTime={handleTime} />

      {/* Ziel des Sprunglinks „Zum Transkript“ – auch dann vorhanden, wenn statt
          des Transkripts noch der Verarbeitungszustand steht. */}
      <div id="transkript" tabIndex={-1} className="scroll-mt-20">
        {status === "abgeschlossen" && segments.length > 0 ? (
          <TranscriptView
            segments={segments}
            currentMs={currentMs}
            onSeek={handleSeek}
            initialQuery={initialQuery}
          />
        ) : (
          <TranscriptPlaceholder
            recordingId={recordingId}
            status={status}
            errorMessage={errorMessage}
            nextAttemptLabel={nextAttemptLabel}
            lastAttemptAt={lastAttemptAt}
          />
        )}
      </div>
    </div>
  );
}

function TranscriptPlaceholder({
  recordingId,
  status,
  errorMessage,
  nextAttemptLabel,
  lastAttemptAt,
}: {
  recordingId: string;
  status: TranscriptionStatus;
  errorMessage: string | null;
  nextAttemptLabel: string | null;
  lastAttemptAt: string | null;
}) {
  if (status === "fehlgeschlagen") {
    const failure = describeTranscriptionError(errorMessage);
    return (
      <section className="card border-[#eab8b1] bg-bad-soft p-5" role="alert">
        <h2 className="text-[14px] font-semibold text-bad">Transkription fehlgeschlagen</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-bad">
          {failure.message} Für diese Aufnahme liegt deshalb kein Transkript vor. Die Audiodatei
          lässt sich weiterhin abspielen.
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-bad">
          {retryHint(nextAttemptLabel)}
        </p>

        <div className="mt-3">
          {/* Ein neuer Fehlschlag erzeugt einen neuen Schlüssel und gibt die
              Schaltfläche damit wieder frei. */}
          <RetryTranscriptionButton
            key={lastAttemptAt ?? "neu"}
            recordingId={recordingId}
            variant="voll"
          />
        </div>

        {failure.technical && (
          <details className="mt-3 rounded-[4px] border border-[#eab8b1] bg-white/60">
            <summary className="cursor-pointer px-2 py-1.5 text-[12px] font-medium text-bad">
              Technische Details
            </summary>
            <p className="border-t border-[#eab8b1] px-2 py-1.5 font-mono text-[11.5px] break-words text-bad">
              {failure.technical}
            </p>
          </details>
        )}
      </section>
    );
  }

  return (
    <section className="card border-[#c6d9df] bg-petrol-soft p-5" role="status">
      <h2 className="text-[14px] font-semibold text-petrol">
        {status === "in_arbeit" ? "Transkription läuft" : "Transkription in der Warteschlange"}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-petrol">
        Das deutsche Transkript mit Sprechertrennung und Zeitstempeln wird erstellt. Die Ansicht
        aktualisiert sich automatisch, sobald es verfügbar ist. Die Aufnahme kann bereits jetzt
        angehört werden.
      </p>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/70">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-petrol" />
      </div>
    </section>
  );
}
