"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  hardDeleteRecordingAction,
  retryTranscriptionAction,
  runQueueAction,
} from "@/app/actions/admin";

export function RetryButton({ recordingId }: { recordingId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await retryTranscriptionAction(recordingId);
            setMessage(result.message);
            router.refresh();
          })
        }
      >
        {pending ? "Wird gestartet …" : "Erneut starten"}
      </button>
      {message && <p className="mt-1 text-[11px] text-ink-faint">{message}</p>}
    </div>
  );
}

export function RunQueueButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await runQueueAction();
            setMessage(result.message);
            router.refresh();
          })
        }
      >
        {pending ? "Warteschlange läuft …" : "Warteschlange jetzt abarbeiten"}
      </button>
      {message && <span className="text-[12px] text-ink-soft">{message}</span>}
    </div>
  );
}

export function HardDeleteButton({
  recordingId,
  filename,
  callerName,
  commentCount,
  ratingCount,
}: {
  recordingId: string;
  filename: string;
  callerName: string;
  commentCount: number;
  ratingCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function remove() {
    if (pending) return;
    startTransition(async () => {
      const result = await hardDeleteRecordingAction(recordingId);
      setMessage(result.message);
      setOpen(false);
      setConfirmText("");
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn btn-danger" disabled={pending} onClick={() => setOpen(true)}>
        Endgültig löschen
      </button>
      {message && <p className="mt-1 text-[11px] text-ink-faint">{message}</p>}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`loeschen-${recordingId}`}
        >
          <div className="card w-full max-w-lg p-6">
            <h2 id={`loeschen-${recordingId}`} className="text-[16px] font-semibold text-bad">
              Aufnahme endgültig löschen
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink">
              Gelöscht werden die Audiodatei, das vollständige Transkript, {commentCount}{" "}
              {commentCount === 1 ? "Kommentar" : "Kommentare"} und {ratingCount}{" "}
              {ratingCount === 1 ? "Bewertung" : "Bewertungen"} der Aufnahme von {callerName}.
            </p>
            <p className="mt-2 font-mono text-[12px] text-ink-faint">{filename}</p>
            <p className="mt-3 text-[13px] text-ink">
              Dieser Schritt kann nicht rückgängig gemacht werden. Geben Sie zur Bestätigung{" "}
              <strong>LÖSCHEN</strong> ein.
            </p>
            <input
              className="field mt-2"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="LÖSCHEN"
              aria-label="Löschung bestätigen"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setOpen(false);
                  setConfirmText("");
                }}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending || confirmText.trim().toUpperCase() !== "LÖSCHEN"}
                onClick={remove}
              >
                {pending ? "Wird gelöscht …" : "Endgültig löschen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
