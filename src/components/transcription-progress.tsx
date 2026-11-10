"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { transcriptionLiveAction, type LiveDetail } from "@/app/actions/recordings";
import { liveFailures, subscribeLive, type LiveState } from "@/lib/live-client";
import { haltText } from "@/lib/queue-halt";
import {
  currentChunk,
  formatElapsed,
  formatRemaining,
  formatSecondsAgo,
  hasChunkProgress,
  remainingMs,
} from "@/lib/progress-text";
import { describeTranscriptionError } from "@/lib/transcription-errors";
import { formatDateTimeWithSeconds } from "@/lib/time";
import { STALE_LOCK_MS } from "../../transcriber/shared/queue";

const isOpen = (detail: LiveDetail | null) =>
  detail?.status === "wartend" || detail?.status === "in_arbeit";

/**
 * Fortschritt einer offenen Transkription auf der Detailseite. Der Stand
 * kommt bei jeder Meldung des Live-Kanals frisch aus der Datenbank; ändert
 * sich der Status oder ein Abschnitt wird fertig, lädt die Seite ihre Daten
 * neu (fertig: das Transkript erscheint ohne manuelles Neuladen). Ist der
 * Auftrag abgeschlossen, endet die Verbindung.
 */
export function TranscriptionProgress({
  recordingId,
  initial,
  renderedAt,
}: {
  recordingId: string;
  initial: LiveDetail;
  renderedAt: number;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<LiveDetail>(initial);
  const [skew, setSkew] = useState(initial.serverNow - renderedAt);
  const [now, setNow] = useState(renderedAt);
  const [liveState, setLiveState] = useState<LiveState>("verbindet");
  const [source, setSource] = useState(initial);
  const latest = useRef(initial);

  // Neuer Server-Render (router.refresh): dessen Stand übernehmen.
  if (source !== initial) {
    setSource(initial);
    setDetail(initial);
  }
  useEffect(() => {
    latest.current = detail;
  }, [detail]);

  const open = isOpen(detail);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let running = false;
    let again = false;

    const check = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const next = await transcriptionLiveAction(recordingId);
        if (cancelled || !next) return;
        const before = latest.current;
        latest.current = next;
        setDetail(next);
        setSkew(next.serverNow - Date.now());
        if (
          next.status !== before.status ||
          (next.progress?.progressDone ?? null) !== (before.progress?.progressDone ?? null)
        ) {
          router.refresh();
        }
      } catch {
        // Der nächste Hinweis des Live-Kanals versucht es erneut.
      } finally {
        running = false;
        if (again && !cancelled) {
          again = false;
          void check();
        }
      }
    };

    const unsubscribe = subscribeLive(() => void check(), setLiveState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, recordingId, router]);

  // Nur die Anzeige „vor X s“ zählt weiter; dabei wird nichts abgefragt.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  if (!open) {
    return (
      <section className="card p-5" role="status">
        <p className="text-[13px] text-ink-soft">Stand wird aktualisiert …</p>
      </section>
    );
  }
  const serverNow = Math.max(now, renderedAt) + skew;
  const disconnected = liveState === "getrennt" && liveFailures() >= 3;

  return detail.status === "in_arbeit" ? (
    <Running detail={detail} nowMs={serverNow} disconnected={disconnected} />
  ) : (
    <Waiting detail={detail} disconnected={disconnected} />
  );
}

function Running({ detail, nowMs, disconnected }: { detail: LiveDetail; nowMs: number; disconnected: boolean }) {
  const progress = detail.progress;
  const chunked = !!progress && hasChunkProgress(progress);
  const total = progress?.progressTotal ?? 0;
  const done = Math.min(progress?.progressDone ?? 0, total);
  const percent = chunked ? Math.round((done / total) * 100) : null;
  const remaining = chunked && progress ? remainingMs(progress) : null;
  const heartbeat = progress?.heartbeatAt ?? null;
  const silentMs = heartbeat ? nowMs - Date.parse(heartbeat) : 0;
  const stale = silentMs > STALE_LOCK_MS;
  const startedAt = progress?.startedAt ?? null;

  const headline = chunked
    ? [
        `Abschnitt ${currentChunk(progress!)} von ${total}`,
        remaining !== null ? formatRemaining(remaining) : "Restzeit wird ermittelt",
      ].join(" · ")
    : [
        "Fortschritt unbestimmt",
        startedAt ? `läuft seit ${formatElapsed(nowMs - Date.parse(startedAt))}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section className="card border-[#c6d9df] bg-petrol-soft p-5" aria-labelledby="fortschritt-titel">
      <h2 id="fortschritt-titel" className="text-[14px] font-semibold text-petrol">
        Transkription läuft
      </h2>
      <p className="mt-1.5 text-[13px] tabular-nums text-petrol" aria-live="polite">
        {headline}
      </p>
      <div
        className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/80"
        role="progressbar"
        aria-labelledby="fortschritt-titel"
        aria-valuemin={chunked ? 0 : undefined}
        aria-valuemax={chunked ? 100 : undefined}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={chunked ? `${done} von ${total} Abschnitten fertig` : "Fortschritt unbestimmt"}
      >
        {chunked ? (
          <div
            className="h-full rounded-full bg-petrol transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="progress-indeterminate" />
        )}
      </div>
      <p className={`mt-2 text-[12px] tabular-nums ${stale ? "text-warn" : "text-petrol/80"}`}>
        {stale
          ? `Seit ${formatElapsed(silentMs)} keine Rückmeldung. Der Auftrag wird automatisch neu gestartet.`
          : heartbeat
            ? `Zuletzt aktualisiert ${formatSecondsAgo(heartbeat, nowMs)}`
            : null}
      </p>
      <Footer disconnected={disconnected} />
    </section>
  );
}

function Waiting({ detail, disconnected }: { detail: LiveDetail; disconnected: boolean }) {
  const saved = detail.progress && hasChunkProgress(detail.progress) ? detail.progress : null;
  const savedLine = saved?.progressDone
    ? `${saved.progressDone} von ${saved.progressTotal} Abschnitten bereits fertig.`
    : null;

  if (detail.halt) {
    return (
      <section className="card border-[#e6d3a4] bg-warn-soft p-5" role="status">
        <h2 className="text-[14px] font-semibold text-warn">Transkription in der Warteschlange</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-warn">
          {haltText(detail.halt)}. Die Aufnahme behält ihren Platz
          {detail.position ? ` (Position ${detail.position.toLocaleString("de-CH")})` : ""} und wird
          danach automatisch transkribiert.
        </p>
        {savedLine && <p className="mt-1 text-[12.5px] text-warn">{savedLine}</p>}
        <Footer disconnected={disconnected} tone="warn" />
      </section>
    );
  }

  const retryAt = detail.nextAttemptAt && Date.parse(detail.nextAttemptAt) > detail.serverNow ? detail.nextAttemptAt : null;
  return (
    <section className="card border-[#c6d9df] bg-petrol-soft p-5" role="status">
      <h2 className="text-[14px] font-semibold text-petrol">Transkription in der Warteschlange</h2>
      <p className="mt-1.5 text-[13px] tabular-nums text-petrol">
        {retryAt
          ? `Nächster automatischer Versuch am ${formatDateTimeWithSeconds(retryAt)} Uhr`
          : detail.position
            ? `Position ${detail.position.toLocaleString("de-CH")} in der Warteschlange`
            : "Startet in Kürze"}
      </p>
      {detail.error && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-petrol">
          Letzter Versuch nicht gelungen: {describeTranscriptionError(detail.error).message}
        </p>
      )}
      {savedLine && <p className="mt-1 text-[12.5px] text-petrol">{savedLine}</p>}
      <Footer disconnected={disconnected} />
    </section>
  );
}

function Footer({ disconnected, tone = "petrol" }: { disconnected: boolean; tone?: "petrol" | "warn" }) {
  return (
    <p className={`mt-3 text-[12px] leading-relaxed ${tone === "warn" ? "text-warn" : "text-petrol/80"}`}>
      {disconnected
        ? "Die Live-Aktualisierung ist unterbrochen. Laden Sie die Seite neu, um den aktuellen Stand zu sehen."
        : "Das Transkript erscheint hier automatisch, sobald es fertig ist. Anhören ist bereits möglich."}
    </p>
  );
}
