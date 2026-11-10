"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  liftSpendingBlockAction,
  moveJobToFrontAction,
  requeueAllFailedAction,
  retryJobAction,
  saveQueueSettingsAction,
  setQueuePausedAction,
} from "@/app/actions/admin";

type Result = { ok: boolean; message: string };

/**
 * Schaltfläche, die sich beim Klick sofort sperrt und erst nach der Antwort
 * des Servers wieder freigibt; ein Doppelklick löst die Aktion nur einmal aus.
 */
function useLockedAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const lock = useRef(false);

  function run(action: () => Promise<Result>) {
    if (lock.current) return;
    lock.current = true;
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await action());
      } catch {
        setResult({ ok: false, message: "Die Aktion ist fehlgeschlagen. Bitte erneut versuchen." });
      } finally {
        lock.current = false;
        router.refresh();
      }
    });
  }

  return { pending, result, run };
}

/**
 * Rückmeldung zu Aktionen an einzelnen Aufträgen. Die Zeile wandert nach der
 * Aktion oft in eine andere Tabelle; die Meldung steht deshalb seitenweit.
 */
let flash: (Result & { id: number }) | null = null;
const listeners = new Set<() => void>();
function showFlash(result: Result) {
  flash = { ...result, id: Date.now() };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function QueueFlash() {
  const current = useSyncExternalStore(subscribe, () => flash, () => null);
  const [hiddenId, setHiddenId] = useState<number | null>(null);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setHiddenId(current.id), 6000);
    return () => clearTimeout(timer);
  }, [current]);
  const visible = current && current.id !== hiddenId;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {visible && (
        <p
          className={`pointer-events-auto max-w-lg rounded-md border px-3 py-2 text-[13px] shadow-sm ${
            current.ok ? "border-line-strong bg-surface text-ink" : "border-[#eab8b1] bg-bad-soft text-bad"
          }`}
        >
          {current.message}
        </p>
      )}
    </div>
  );
}

function ResultText({ result }: { result: Result | null }) {
  if (!result) return null;
  return (
    <p role="status" className={`mt-1 text-[12px] leading-snug ${result.ok ? "text-ink-faint" : "text-bad"}`}>
      {result.message}
    </p>
  );
}

export function PauseQueueButton({ paused }: { paused: boolean }) {
  const { pending, result, run } = useLockedAction();
  return (
    <div>
      <button
        type="button"
        className={`btn ${paused ? "btn-primary" : "btn-secondary"}`}
        disabled={pending}
        onClick={() => run(() => setQueuePausedAction(!paused))}
      >
        {pending ? "Wird gespeichert …" : paused ? "Fortsetzen" : "Warteschlange pausieren"}
      </button>
      <ResultText result={result} />
    </div>
  );
}

export function LiftBlockButton() {
  const { pending, result, run } = useLockedAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div>
        <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>
          Sperre aufheben
        </button>
        <ResultText result={result} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] text-ink">
        Nur aufheben, wenn das Kostenlimit erhöht wurde. Sonst sperrt die nächste Anfrage erneut.
      </span>
      <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirming(false)}>
        Abbrechen
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() => run(liftSpendingBlockAction)}
      >
        {pending ? "Wird aufgehoben …" : "Aufheben"}
      </button>
    </div>
  );
}

export function JobActionButton({
  recordingId,
  action,
  label,
}: {
  recordingId: string;
  action: "vorne" | "wiederholen";
  label: string;
}) {
  const { pending, run } = useLockedAction();
  return (
    <button
      type="button"
      className="btn btn-ghost whitespace-nowrap"
      disabled={pending}
      onClick={() =>
        run(async () => {
          const result = await (action === "vorne" ? moveJobToFrontAction(recordingId) : retryJobAction(recordingId));
          showFlash(result);
          return result;
        })
      }
    >
      {pending ? "Wird ausgeführt …" : label}
    </button>
  );
}

export function RequeueAllFailedButton({ count }: { count: number }) {
  const { pending, result, run } = useLockedAction();
  const [confirming, setConfirming] = useState(false);

  if (count === 0 && !result) return null;
  if (!confirming) {
    return (
      <div>
        {count > 0 && (
          <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
            Alle fehlgeschlagenen neu einreihen
          </button>
        )}
        <ResultText result={result} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] text-ink">
        {count} {count === 1 ? "Auftrag" : "Aufträge"} neu einreihen?
      </span>
      <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirming(false)}>
        Abbrechen
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() => {
          setConfirming(false);
          run(requeueAllFailedAction);
        }}
      >
        Neu einreihen
      </button>
    </div>
  );
}

export function QueueSettingsForm({
  initial,
}: {
  initial: { maxConcurrent: number; minGapSeconds: number; jobsPerInstance: number };
}) {
  const { pending, result, run } = useLockedAction();
  const [values, setValues] = useState({
    maxConcurrent: String(initial.maxConcurrent),
    minGapSeconds: String(initial.minGapSeconds),
    jobsPerInstance: String(initial.jobsPerInstance),
  });
  const fields: { key: keyof typeof values; label: string; hint: string; min: number; max: number; step: number }[] = [
    { key: "maxConcurrent", label: "Gleichzeitige Anfragen", hint: "Alle Instanzen zusammen, 1 bis 8", min: 1, max: 8, step: 1 },
    { key: "minGapSeconds", label: "Mindestabstand (Sekunden)", hint: "Zwischen zwei Anfragen, 0 bis 120", min: 0, max: 120, step: 1 },
    { key: "jobsPerInstance", label: "Aufträge je Instanz", hint: "Gleichzeitig bearbeitet, 1 bis 8", min: 1, max: 8, step: 1 },
  ];

  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        run(() =>
          saveQueueSettingsAction({
            maxConcurrent: Number(values.maxConcurrent),
            minGapSeconds: Number(values.minGapSeconds),
            jobsPerInstance: Number(values.jobsPerInstance),
          }),
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map((field) => (
          <label key={field.key} className="block">
            <span className="block text-[12px] font-semibold text-ink-soft">{field.label}</span>
            <input
              type="number"
              inputMode="numeric"
              required
              min={field.min}
              max={field.max}
              step={field.step}
              value={values[field.key]}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              className="field mt-1 tabular-nums"
            />
            <span className="mt-0.5 block text-[11.5px] text-ink-faint">{field.hint}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Wird gespeichert …" : "Grenzen speichern"}
        </button>
      </div>
      <ResultText result={result} />
    </form>
  );
}
