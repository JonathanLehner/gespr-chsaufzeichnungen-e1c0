/**
 * Regeln der Warteschlange `jobs`, gemeinsam genutzt vom Transkriptionsdienst
 * (`transcriber/worker.ts`, übernimmt Aufträge) und der Anwendung (reiht ein,
 * zeigt den Zustand an). Reine Konstanten und Filter, ohne Datenbankzugriff.
 */

/**
 * Wartezeit vor dem nächsten Versuch nach einem vorübergehenden Fehler:
 * verdoppelt sich ab zwei Minuten und bleibt bei 30 Minuten stehen. Einen
 * endgültigen Abbruch wegen zu vieler Versuche gibt es nicht.
 */
export const RETRY_BASE_MS = 2 * 60 * 1000;
export const RETRY_MAX_MS = 30 * 60 * 1000;
/** Abstand, in dem ein laufender Auftrag und jeder Dienst ihr Lebenszeichen schreiben. */
export const HEARTBEAT_MS = 30 * 1000;
/** Ohne Lebenszeichen seit dieser Zeit gilt die Sperre als verwaist und wird übernommen. */
export const STALE_LOCK_MS = 3 * 60 * 1000;
/** Sammlung, in der jeder laufende Dienst sein Lebenszeichen ablegt. */
export const WORKERS_COLLECTION = "transcriber_workers";

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Wartezeit nach dem `attempts`-ten erfolglosen Versuch, mit ±10 % Streuung. */
export function retryDelayMs(attempts: number, random = Math.random()): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  const base = Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
  return Math.round(base * (0.9 + 0.2 * random));
}

/** Fälligkeit des nächsten Versuchs nach `attempts` erfolglosen Versuchen. */
export function nextAttemptAfter(attempts: number, now = Date.now()): string {
  return iso(now + retryDelayMs(attempts));
}

/**
 * Fehler, die ein späterer Versuch beheben kann: Zeitüberschreitung,
 * Serverfehler, Netzwerk, Überlastung, Zugangs- oder Kostenlimit beim Dienst.
 */
export function isTransientError(message: string): boolean {
  return /zeitüberschreitung|timeout|timed out|aborted|\b(408|425|429|5\d\d)\b|fetch failed|network|socket|econn|enotfound|eai_again|und_err|keinen abschnitt|nicht geantwortet|nicht erreichbar|unavailable|overloaded|rate limit|quota|resource exhausted|spending limit|billing|wiederholt unterbrochen/i.test(
    message,
  );
}

/** Läuft der Auftrag noch, gemessen am letzten Lebenszeichen? */
export function lockIsFresh(lockedAt: string | null | undefined, now = Date.now()): boolean {
  return !!lockedAt && lockedAt >= iso(now - STALE_LOCK_MS);
}

/**
 * Alle Aufträge, die ein Dienst jetzt übernehmen darf: wartende, deren
 * nächster Versuch fällig ist, und laufende ohne frisches Lebenszeichen
 * (abgebrochener Container) oder ohne Sperre (ältere, pausierte Aufträge).
 * „fehlgeschlagen“ ist endgültig und wird nie automatisch übernommen.
 */
export function claimableFilter(now = Date.now()): Record<string, unknown> {
  const at = iso(now);
  return {
    $or: [
      { status: "wartend", $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }] },
      {
        status: "in_arbeit",
        $or: [{ lockedAt: null }, { lockedAt: { $lt: iso(now - STALE_LOCK_MS) } }],
      },
    ],
  };
}

/** Wartende Aufträge, deren nächster Versuch erst später fällig ist. */
export function scheduledRetryFilter(now = Date.now()): Record<string, unknown> {
  return { status: "wartend", nextAttemptAt: { $gt: iso(now) } };
}

/* ------------------------------------------------------------ Gemeinsame Drossel */

/**
 * Ein Dokument in dieser Sammlung regelt alle Anfragen an den
 * Transkriptionsdienst über alle Instanzen hinweg (Staging und Produktion
 * teilen sich die Datenbank und damit dieselbe Grenze).
 */
export const LIMITER_COLLECTION = "transcriber_limiter";
export const LIMITER_ID = "gemini";
/** Erfolgreiche Anfragen in Folge, bis nach einer Störung wieder volle Parallelität gilt. */
export const LIMITER_RAMP_SUCCESSES = 3;

export type LimiterLease = { id: string; workerId: string; startedAt: string; expiresAt: string };
export type LimiterEvent = { at: string; ok: boolean; ms: number; transient?: boolean };

export type LimiterDoc = {
  _id: string;
  /** Laufende Anfragen; abgelaufene Einträge (abgestürzter Dienst) zählen nicht. */
  leases: LimiterLease[];
  /** Frühester Start der nächsten Anfrage (Mindestabstand). */
  nextStartAt: string | null;
  /** Nach Zeitüberschreitung oder Serverfehler: keine neuen Anfragen bis dahin. */
  pausedUntil: string | null;
  /** Vorübergehende Fehler in Folge; bestimmt die Länge der Pause. */
  failureStreak: number;
  /** Erfolge in Folge; darunter gilt nur eine Anfrage zugleich. */
  successStreak: number;
  /** Zuletzt eingetragene Grenzen (Anzeige im Admin-Dashboard). */
  maxConcurrent: number;
  minGapMs: number;
  lastPauseReason: string | null;
  /** Die letzten Anfragen, für die Anzeige der tatsächlichen Rate. */
  recent: LimiterEvent[];
};

/** Gleichzeitig erlaubte Anfragen nach dem aktuellen Stand der Erholung. */
export function effectiveConcurrency(doc: Pick<LimiterDoc, "successStreak" | "maxConcurrent">): number {
  return (doc.successStreak ?? LIMITER_RAMP_SUCCESSES) < LIMITER_RAMP_SUCCESSES ? 1 : doc.maxConcurrent;
}

/** Pause der ganzen Spur nach `streak` vorübergehenden Fehlern in Folge: 30 s, danach 60 s. */
export function lanePauseMs(streak: number): number {
  return streak <= 1 ? 30_000 : 60_000;
}
