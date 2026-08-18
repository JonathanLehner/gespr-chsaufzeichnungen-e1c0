"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restartTranscriptionAction } from "@/app/actions/recordings";

type Phase = "bereit" | "wird_gestartet" | "in_arbeit" | "fehler";

const LABEL: Record<Phase, string> = {
  bereit: "Transkription erneut starten",
  wird_gestartet: "Wird gestartet …",
  in_arbeit: "In Arbeit …",
  fehler: "Transkription erneut starten",
};

/**
 * Startet die Transkription einer fehlgeschlagenen Aufnahme neu. Die
 * Schaltfläche steht allen angemeldeten Mitarbeitenden offen und sperrt sich
 * sofort beim Klick, damit kein zweiter Auftrag entsteht. Der Verlauf ist am
 * Beschriftungstext ablesbar: „Wird gestartet …“ und danach „In Arbeit …“.
 */
export function RetryTranscriptionButton({
  recordingId,
  variant = "kompakt",
}: {
  recordingId: string;
  variant?: "voll" | "kompakt";
}) {
  const router = useRouter();
  const [transitionPending, startTransition] = useTransition();
  const [phase, setPhase] = useState<Phase>("bereit");
  const [message, setMessage] = useState<string | null>(null);
  const lockRef = useRef(false);

  const busy = transitionPending || phase === "wird_gestartet" || phase === "in_arbeit";

  function start() {
    if (lockRef.current) return;
    lockRef.current = true;
    setPhase("wird_gestartet");
    setMessage(null);

    startTransition(async () => {
      const result = await restartTranscriptionAction(recordingId);
      setMessage(result.message);
      if (result.ok) {
        // Die Sperre bleibt bestehen: Der Auftrag läuft, bis die aktualisierte
        // Ansicht die Schaltfläche selbst entfernt.
        setPhase("in_arbeit");
      } else {
        lockRef.current = false;
        setPhase("fehler");
      }
      router.refresh();
    });
  }

  const full = variant === "voll";

  return (
    <div className={full ? "" : "w-full"}>
      <button
        type="button"
        className={`btn ${full ? "btn-primary" : "btn-ghost"} ${busy ? "opacity-70" : ""}`}
        disabled={busy}
        aria-busy={busy}
        onClick={start}
      >
        {LABEL[phase]}
      </button>
      {message && (
        <p
          className={`mt-1 text-[11px] leading-snug ${phase === "fehler" ? "text-bad" : "text-ink-faint"}`}
          role="status"
        >
          {message}
        </p>
      )}
    </div>
  );
}
