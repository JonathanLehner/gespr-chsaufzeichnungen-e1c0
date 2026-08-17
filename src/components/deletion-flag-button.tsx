"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toggleDeletionFlagAction } from "@/app/actions/recordings";

export function DeletionFlagButton({
  recordingId,
  flagged,
  variant = "kompakt",
}: {
  recordingId: string;
  flagged: boolean;
  variant?: "kompakt" | "voll";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function submit(nextFlagged: boolean, nextReason: string) {
    if (pending) return;
    startTransition(async () => {
      const result = await toggleDeletionFlagAction(recordingId, nextFlagged, nextReason);
      setMessage(result.message);
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  if (flagged) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending}
          onClick={() => submit(false, "")}
        >
          {pending ? "Wird gespeichert …" : "Markierung aufheben"}
        </button>
        {variant === "voll" && message && <p className="text-[12px] text-ink-faint">{message}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={variant === "voll" ? "btn btn-secondary" : "btn btn-ghost text-bad"}
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Zur Löschung markieren
      </button>
      {open && (
        <div className="card space-y-2 border-line-strong p-3">
          <p className="text-[12px] leading-snug text-ink-soft">
            Die Aufnahme wird lediglich markiert. Audio, Transkript, Kommentare und Bewertungen
            bleiben erhalten, bis die Administration die Löschung bestätigt.
          </p>
          <label className="label" htmlFor={`grund-${recordingId}`}>
            Begründung (optional)
          </label>
          <input
            id={`grund-${recordingId}`}
            className="field"
            value={reason}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            placeholder="z. B. Fehlaufnahme, Testanruf"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => submit(true, reason)}
            >
              {pending ? "Wird gespeichert …" : "Markierung setzen"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
      {variant === "voll" && message && <p className="text-[12px] text-ink-faint">{message}</p>}
    </div>
  );
}
