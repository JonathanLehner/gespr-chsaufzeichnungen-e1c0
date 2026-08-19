"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toggleDeletionFlagAction } from "@/app/actions/recordings";
import { DeletionBadge } from "@/components/status";

/**
 * Die Löschmarkierung wird optimistisch geführt: Badge und Beschriftung der
 * Schaltfläche wechseln unmittelbar nach dem Klick, während der Serveraufruf
 * noch läuft. Das erneute Laden der Liste gleicht den Zustand danach ab.
 */
type FlagState = {
  flagged: boolean;
  saving: boolean;
  message: string | null;
  failed: boolean;
  apply: (nextFlagged: boolean, reason: string) => void;
};

const DeletionFlagContext = createContext<FlagState | null>(null);

function useDeletionFlagState(recordingId: string, serverFlagged: boolean): FlagState {
  const router = useRouter();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState({
    server: serverFlagged,
    flagged: serverFlagged,
    message: null as string | null,
    failed: false,
    nonce: 0,
  });

  // Nach dem erneuten Laden gilt wieder der Serverwert; die Rückmeldung bleibt.
  if (state.server !== serverFlagged) {
    setState((prev) => ({ ...prev, server: serverFlagged, flagged: serverFlagged }));
  }

  // Die Bestätigung wird nur kurz eingeblendet, Fehler bleiben stehen.
  useEffect(() => {
    if (!state.message || state.failed) return;
    const timer = setTimeout(
      () => setState((prev) => (prev.nonce === state.nonce ? { ...prev, message: null } : prev)),
      8000,
    );
    return () => clearTimeout(timer);
  }, [state.message, state.failed, state.nonce]);

  const apply = useCallback(
    (nextFlagged: boolean, reason: string) => {
      // Sofort sperren, damit ein zweiter Klick keinen weiteren Aufruf auslöst.
      if (busy.current) return;
      busy.current = true;
      setSaving(true);
      setState((prev) => ({
        ...prev,
        flagged: nextFlagged,
        message: null,
        failed: false,
        nonce: prev.nonce + 1,
      }));

      void (async () => {
        try {
          const result = await toggleDeletionFlagAction(recordingId, nextFlagged, reason);
          setState((prev) => ({
            ...prev,
            flagged: result.ok ? nextFlagged : prev.server,
            message: result.message,
            failed: !result.ok,
            nonce: prev.nonce + 1,
          }));
          if (result.ok) router.refresh();
        } catch {
          setState((prev) => ({
            ...prev,
            flagged: prev.server,
            message: "Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.",
            failed: true,
            nonce: prev.nonce + 1,
          }));
        } finally {
          busy.current = false;
          setSaving(false);
        }
      })();
    },
    [recordingId, router],
  );

  return { flagged: state.flagged, saving, message: state.message, failed: state.failed, apply };
}

export function DeletionFlagProvider({
  recordingId,
  flagged,
  children,
}: {
  recordingId: string;
  flagged: boolean;
  children: ReactNode;
}) {
  const state = useDeletionFlagState(recordingId, flagged);
  return <DeletionFlagContext.Provider value={state}>{children}</DeletionFlagContext.Provider>;
}

/**
 * Badge der Spalte „Löschmarkierung“. Innerhalb des Providers folgt sie dem
 * optimistischen Zustand, ausserhalb dem übergebenen Serverwert.
 */
export function DeletionFlagBadge({
  flagged,
  flaggedBy,
}: {
  flagged: boolean;
  flaggedBy?: string | null;
}) {
  const state = useContext(DeletionFlagContext);
  const current = state ? state.flagged : flagged;
  return (
    <>
      <DeletionBadge flagged={current} />
      {current && flagged && flaggedBy && !state?.saving && (
        <span className="mt-0.5 block text-[11px] text-ink-faint">{flaggedBy}</span>
      )}
      {state?.saving && (
        <span className="mt-0.5 block text-[11px] text-ink-faint">Wird gespeichert …</span>
      )}
    </>
  );
}

/**
 * Kurze Rückmeldung nach dem Speichern. Sie liegt über der Seite, weil die
 * schmale Spalte „Aktion“ einen längeren Satz sonst in Einzelwörter umbricht.
 */
function FlagToast({ message, failed }: { message: string; failed: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-4 sm:justify-end">
      <p
        role="status"
        className={`notice ${failed ? "notice-error" : "notice-ok"} max-w-[26rem] shadow-lg`}
      >
        {message}
      </p>
    </div>
  );
}

export function DeletionFlagButton({
  recordingId,
  flagged,
  variant = "kompakt",
}: {
  recordingId: string;
  flagged: boolean;
  variant?: "kompakt" | "voll";
}) {
  const shared = useContext(DeletionFlagContext);
  if (shared) return <FlagControls state={shared} recordingId={recordingId} variant={variant} />;
  return <StandaloneFlagButton recordingId={recordingId} flagged={flagged} variant={variant} />;
}

function StandaloneFlagButton({
  recordingId,
  flagged,
  variant,
}: {
  recordingId: string;
  flagged: boolean;
  variant: "kompakt" | "voll";
}) {
  const state = useDeletionFlagState(recordingId, flagged);
  return <FlagControls state={state} recordingId={recordingId} variant={variant} />;
}

function FlagControls({
  state,
  recordingId,
  variant,
}: {
  state: FlagState;
  recordingId: string;
  variant: "kompakt" | "voll";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { flagged, saving, message, failed, apply } = state;

  function confirm(nextFlagged: boolean, nextReason: string) {
    apply(nextFlagged, nextReason);
    setOpen(false);
    setReason("");
  }

  // Während des Speicherns trägt die Schaltfläche bereits die neue Beschriftung.
  // In der Tabelle steht der Wartehinweis in der Spalte „Löschmarkierung“, in
  // der Detailansicht direkt unter der Schaltfläche.
  const feedback = (
    <>
      {saving && variant === "voll" && (
        <p role="status" className="text-[12px] leading-snug text-ink-faint">
          Wird gespeichert …
        </p>
      )}
      {message && !saving && <FlagToast message={message} failed={failed} />}
    </>
  );

  if (flagged) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={saving}
          aria-busy={saving}
          onClick={() => confirm(false, "")}
        >
          Markierung aufheben
        </button>
        {feedback}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={variant === "voll" ? "btn btn-secondary" : "btn btn-ghost text-bad"}
        disabled={saving}
        aria-busy={saving}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Zur Löschung markieren
      </button>
      {open && (
        <div className="card space-y-2 border-line-strong p-3">
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
              disabled={saving}
              onClick={() => confirm(true, reason)}
            >
              Markierung bestätigen
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
      {feedback}
    </div>
  );
}
