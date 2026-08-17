"use client";

import { useCallback, useRef, useState } from "react";
import { WaveformPlayer, type PlayerHandle } from "@/components/waveform-player";
import { TranscriptView } from "@/components/transcript-view";
import type { TranscriptSegment, TranscriptionStatus } from "@/lib/types";

export function RecordingPlayerPanel({
  audioSrc,
  segments,
  status,
  errorMessage,
  startMs,
  initialQuery,
}: {
  audioSrc: string;
  segments: TranscriptSegment[];
  status: TranscriptionStatus;
  errorMessage: string | null;
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

      {status === "abgeschlossen" && segments.length > 0 ? (
        <TranscriptView
          segments={segments}
          currentMs={currentMs}
          onSeek={handleSeek}
          initialQuery={initialQuery}
        />
      ) : (
        <TranscriptPlaceholder status={status} errorMessage={errorMessage} />
      )}
    </div>
  );
}

function TranscriptPlaceholder({
  status,
  errorMessage,
}: {
  status: TranscriptionStatus;
  errorMessage: string | null;
}) {
  if (status === "fehlgeschlagen") {
    return (
      <section className="card border-[#eab8b1] bg-bad-soft p-5" role="alert">
        <h2 className="text-[14px] font-semibold text-bad">Transkription fehlgeschlagen</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-bad">
          Für diese Aufnahme liegt kein Transkript vor. Die Audiodatei lässt sich weiterhin
          abspielen. Die Administration kann die Transkription im Admin-Dashboard erneut starten.
        </p>
        {errorMessage && (
          <p className="mt-2 rounded-[4px] bg-white/60 p-2 font-mono text-[11.5px] text-bad">
            {errorMessage}
          </p>
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
