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
/**
 * Fähigkeiten, die ein Dienst in seinem Lebenszeichen meldet. Nachrangige
 * Neu-Transkriptionen, Neu-Ausrichtung und das Modell je Auftrag versteht nur
 * ein Dienst mit diesen Einträgen; eine ältere Instanz würde solche Aufträge
 * wie gewöhnliche behandeln.
 */
export const REQUIRED_WORKER_FEATURES = ["nachrangig", "modell-je-auftrag", "neu-ausrichten", "gemini-direkt"] as const;

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
 * Laufende Aufträge ohne frisches Lebenszeichen: abgebrochener Container,
 * fehlende Sperre oder Aufträge aus der früheren Verarbeitung in der Anfrage
 * (ohne `workerId` und `lockId`). Massgeblich ist allein `lockedAt`, auch
 * wenn es als BSON-Datum statt als ISO-Text gespeichert ist.
 */
export function staleLockFilter(now = Date.now()): Record<string, unknown> {
  return {
    status: "in_arbeit",
    $or: [
      { lockedAt: null },
      { lockedAt: { $type: "string", $lt: iso(now - STALE_LOCK_MS) } },
      { lockedAt: { $type: "date", $lt: new Date(now - STALE_LOCK_MS) } },
    ],
  };
}

/**
 * Alle Aufträge, die ein Dienst jetzt übernehmen darf: wartende, deren
 * nächster Versuch fällig ist, und verwaiste laufende (`staleLockFilter`).
 * „fehlgeschlagen“ ist endgültig und wird nie automatisch übernommen.
 */
export function claimableFilter(now = Date.now()): Record<string, unknown> {
  const at = iso(now);
  return {
    $or: [
      { status: "wartend", $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }] },
      staleLockFilter(now),
    ],
  };
}

/* ------------------------------------------------------------ Stand für die Anzeige */

/**
 * Versionsstempel in `settings`: Jede Änderung an Status oder Fortschritt
 * eines Auftrags erhöht `value` (Transkriptionsdienst und Anwendung). Die
 * Anwendung verwirft daran ihren Zwischenspeicher und meldet Änderungen live
 * an geöffnete Seiten.
 */
export const STATUS_VERSION_COLLECTION = "settings";
export const STATUS_VERSION_ID = "status_version";

/**
 * Ungefähre Position eines wartenden Auftrags. Vorgezogene Aufträge kommen
 * zuerst; danach wechseln die Plätze zwischen neuestem und ältestem fälligen
 * Auftrag, die Warteschlange schrumpft also von beiden Enden.
 */
export function queuePosition(counts: { prioritizedAhead: number; older: number; newer: number }): number {
  return counts.prioritizedAhead + 2 * Math.min(counts.older, counts.newer) + 1;
}

/** Fortschrittsfelder eines Auftrags, wie sie der Transkriptionsdienst schreibt. */
export type ProgressFields = {
  progressDone: number | null;
  progressTotal: number | null;
  /** Letzter gesicherter Abschnitt. */
  progressAt: string | null;
  /** Beginn des laufenden Durchgangs und bis dahin fertige Abschnitte. */
  progressRunAt: string | null;
  progressRunDone: number | null;
};

/** Gemessene Zeit je Abschnitt im laufenden Durchgang; `null`, solange keiner fertig ist. */
export function msPerChunk(fields: ProgressFields): number | null {
  const { progressDone, progressRunDone, progressAt, progressRunAt } = fields;
  if (progressDone === null || progressRunDone === null || !progressAt || !progressRunAt) return null;
  const chunks = progressDone - progressRunDone;
  const ms = Date.parse(progressAt) - Date.parse(progressRunAt);
  return chunks > 0 && ms > 0 ? ms / chunks : null;
}

/** Geschätzte Restzeit aus der gemessenen Zeit je Abschnitt. */
export function remainingMs(fields: ProgressFields): number | null {
  const perChunk = msPerChunk(fields);
  if (perChunk === null || fields.progressTotal === null || fields.progressDone === null) return null;
  return Math.max(0, fields.progressTotal - fields.progressDone) * perChunk;
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

export type LimiterDoc = ControlFields & {
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

/* ------------------------------------------------------------ Steuerung durch den Admin */

/**
 * Die Steuerung liegt im selben Dokument wie die Drossel (`LIMITER_ID`), damit
 * `acquire` Pause und Sperre im selben atomaren Schritt prüft, in dem es einen
 * Platz vergibt: Nach dem Setzen der Sperre startet keine Instanz mehr eine
 * Anfrage.
 */
export type QueueSettings = {
  /** Gleichzeitige Anfragen an den Dienst, alle Instanzen zusammen. */
  maxConcurrent: number;
  /** Mindestabstand zwischen zwei Anfragestarts. */
  minGapMs: number;
  /** Aufträge, die jede Instanz gleichzeitig bearbeitet. */
  jobsPerInstance: number;
  updatedAt: string;
  updatedBy: string;
};

export const SETTINGS_LIMITS = {
  maxConcurrent: { min: 1, max: 8 },
  minGapMs: { min: 0, max: 120_000 },
  jobsPerInstance: { min: 1, max: 8 },
} as const;

export type ManualPause = { at: string; by: string };

/** Kostenlimit des Dienstes erreicht: keine Anfragen bis `until` oder bis zur Freigabe. */
export type SpendingBlock = {
  startedAt: string;
  until: string;
  reason: string;
  recordingId: string | null;
  workerId: string | null;
};

export type QueueErrorEntry = { at: string; recordingId: string | null; message: string };

export type ControlFields = {
  manualPause?: ManualPause | null;
  spendingBlock?: SpendingBlock | null;
  settings?: QueueSettings | null;
  /** Wird bei jeder Änderung der Steuerung erhöht; weckt alle Instanzen (Change Stream). */
  controlVersion?: number;
  /** Die letzten Fehler aller Instanzen, neueste zuletzt. */
  errors?: QueueErrorEntry[];
};

export const RECENT_ERRORS = 50;

/** Meldung des Dienstes, wenn das monatliche Kostenlimit des Kontos erreicht ist. */
export function isSpendingLimitError(message: string): boolean {
  // Plattform: „monthly spending limit“. Google direkt: Ausgabenobergrenze des
  // Projekts, aufgebrauchtes Guthaben oder Kontingent ohne Abrechnung. Die
  // Minutengrenze („Rate limit exceeded … per minute“) ist keine Sperre.
  return /spending (limit|cap)|check your plan and billing|billing (account|details|is not enabled)|credits? (are |is )?(depleted|exhausted)|prepa(id|yment) (balance|credits?)/i.test(
    message,
  );
}

/** Erster Tag des Folgemonats, 00:00 Uhr in Europe/Zurich, als UTC-Zeitpunkt. */
export function nextMonthStartZurich(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(now));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value); // 1–12
  const naive = Date.UTC(year, month, 1); // Monat ist 0-basiert: `month` = Folgemonat
  // Zürich liegt 1 h (Winter) oder 2 h (Sommer) vor UTC; am Monatsersten gilt die Zeit dieses Tages.
  const offsetAt = (utc: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Zurich", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(utc));
    const get = (type: string) => Number(p.find((x) => x.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - utc;
  };
  return naive - offsetAt(naive - offsetAt(naive));
}

/** Beginn des laufenden Monats in Europe/Zurich. */
function monthStartZurich(now: number): number {
  // Der Monatserste dieses Monats ist der Folgemonatsbeginn, von 32 Tagen davor aus gerechnet.
  const next = nextMonthStartZurich(now);
  return nextMonthStartZurich(next - 32 * 24 * 60 * 60 * 1000);
}

/**
 * Ende einer Sperre wegen Kostenlimit: Beginn des nächsten Kalendermonats
 * (Europe/Zurich). Tritt der Fehler am ersten Tag eines Monats auf, hat der
 * Dienst seinen Monat womöglich noch nicht gewechselt (andere Zeitzone);
 * dann wird nach einer Stunde erneut versucht statt einen Monat zu warten.
 */
export function spendingBlockUntil(now = Date.now()): string {
  if (now < monthStartZurich(now) + 24 * 60 * 60 * 1000) return iso(now + 60 * 60 * 1000);
  return iso(nextMonthStartZurich(now));
}

/** Aktive Sperre (abgelaufene zählen nicht mehr). */
export function activeBlock(doc: ControlFields | null | undefined, now = Date.now()): SpendingBlock | null {
  const block = doc?.spendingBlock;
  return block && block.until > iso(now) ? block : null;
}
