/**
 * Regeln der Warteschlange `jobs`, gemeinsam genutzt vom Transkriptionsdienst
 * (`transcriber/worker.ts`, übernimmt Aufträge) und der Anwendung (reiht ein,
 * zeigt den Zustand an). Reine Konstanten und Filter, ohne Datenbankzugriff.
 */

export const MAX_ATTEMPTS = 3;
/** Wartezeit vor der zweiten und dritten automatischen Wiederholung. */
export const RETRY_DELAYS_MS = [3 * 60 * 1000, 15 * 60 * 1000];
/** Abstand, in dem ein laufender Auftrag und jeder Dienst ihr Lebenszeichen schreiben. */
export const HEARTBEAT_MS = 30 * 1000;
/** Ohne Lebenszeichen seit dieser Zeit gilt die Sperre als verwaist und wird übernommen. */
export const STALE_LOCK_MS = 3 * 60 * 1000;
/** Sammlung, in der jeder laufende Dienst sein Lebenszeichen ablegt. */
export const WORKERS_COLLECTION = "transcriber_workers";

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Fälligkeit der nächsten automatischen Wiederholung nach `attempts` Versuchen. */
export function nextAttemptAfter(attempts: number, now = Date.now()): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return iso(now + RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]);
}

/** Läuft der Auftrag noch, gemessen am letzten Lebenszeichen? */
export function lockIsFresh(lockedAt: string | null | undefined, now = Date.now()): boolean {
  return !!lockedAt && lockedAt >= iso(now - STALE_LOCK_MS);
}

/**
 * Alle Aufträge, die ein Dienst jetzt übernehmen darf: wartende, fällige
 * Wiederholungen und laufende ohne frisches Lebenszeichen (abgebrochener
 * Container) oder ohne Sperre (ältere, pausierte Aufträge).
 */
export function claimableFilter(now = Date.now()): Record<string, unknown> {
  const at = iso(now);
  return {
    $or: [
      { status: "wartend" },
      {
        status: "fehlgeschlagen",
        attempts: { $lt: MAX_ATTEMPTS },
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }],
      },
      {
        status: "in_arbeit",
        $or: [{ lockedAt: null }, { lockedAt: { $lt: iso(now - STALE_LOCK_MS) } }],
      },
    ],
  };
}
