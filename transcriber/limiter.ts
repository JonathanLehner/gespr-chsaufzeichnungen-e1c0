/**
 * Gemeinsame Drossel für alle Anfragen an den Transkriptionsdienst.
 *
 * Alle Instanzen (Staging und Produktion teilen sich die Datenbank) stimmen
 * sich über ein einziges Dokument in `transcriber_limiter` ab:
 *  - höchstens `maxConcurrent` Anfragen laufen gleichzeitig (Einträge in
 *    `leases`; ein abgestürzter Dienst blockiert nur bis `expiresAt`),
 *  - zwischen zwei Starts liegen mindestens `minGapMs` (`nextStartAt`),
 *  - nach einer Zeitüberschreitung oder einem Serverfehler ruht die ganze Spur
 *    (`pausedUntil`, 30 s, bei anhaltender Störung je 60 s) und läuft danach mit einer
 *    Anfrage zugleich wieder an, bis drei Anfragen in Folge gelungen sind.
 *
 * Die Vergabe ist ein einziges `findOneAndUpdate` mit Aggregations-Pipeline:
 * Prüfen und Eintragen geschehen atomar, zwei Instanzen können die Grenze also
 * nicht gemeinsam überschreiten.
 */
import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import {
  LIMITER_ID,
  LIMITER_RAMP_SUCCESSES,
  iso,
  lanePauseMs,
  type LimiterDoc,
  type LimiterLease,
} from "./shared/queue";

/** Längste Wartezeit zwischen zwei Vergabeversuchen, wenn alle Plätze belegt sind. */
const FULL_RETRY_MS = 2000;
const RECENT_EVENTS = 200;

export type LimiterOptions = {
  maxConcurrent: number;
  minGapMs: number;
  /** Höchstdauer einer Anfrage; danach verfällt der Platz von selbst. */
  leaseMs: number;
  log: (message: string) => void;
};

export class AbortedWhileWaiting extends Error {}

export class GeminiLimiter {
  private wakeLocal: (() => void)[] = [];

  constructor(
    private readonly collection: Collection<LimiterDoc>,
    private readonly workerId: string,
    readonly options: LimiterOptions,
  ) {}

  /** Wartet, bis eine Anfrage starten darf, und belegt dafür einen Platz. */
  async acquire(signal: AbortSignal): Promise<LimiterLease> {
    const { maxConcurrent, minGapMs, leaseMs } = this.options;
    for (;;) {
      if (signal.aborted) throw new AbortedWhileWaiting("Abgebrochen beim Warten auf einen freien Platz.");
      const now = Date.now();
      const nowIso = iso(now);
      const lease: LimiterLease = {
        id: randomUUID(),
        workerId: this.workerId,
        startedAt: nowIso,
        expiresAt: iso(now + leaseMs),
      };
      const limit = {
        $cond: [
          { $lt: [{ $ifNull: ["$successStreak", LIMITER_RAMP_SUCCESSES] }, LIMITER_RAMP_SUCCESSES] },
          1,
          maxConcurrent,
        ],
      };
      const doc = await this.collection.findOneAndUpdate(
        { _id: LIMITER_ID },
        [
          {
            $set: {
              leases: {
                $filter: { input: { $ifNull: ["$leases", []] }, cond: { $gt: ["$$this.expiresAt", nowIso] } },
              },
              maxConcurrent,
              minGapMs,
            },
          },
          {
            $set: {
              granted: {
                $and: [
                  { $lt: [{ $size: "$leases" }, limit] },
                  { $lte: [{ $ifNull: ["$nextStartAt", ""] }, nowIso] },
                  { $lte: [{ $ifNull: ["$pausedUntil", ""] }, nowIso] },
                ],
              },
            },
          },
          {
            $set: {
              leases: { $cond: ["$granted", { $concatArrays: ["$leases", [{ $literal: lease }]] }, "$leases"] },
              nextStartAt: { $cond: ["$granted", iso(now + minGapMs), "$nextStartAt"] },
            },
          },
          { $unset: "granted" },
        ],
        { upsert: true, returnDocument: "after" },
      );
      if (doc?.leases.some((entry) => entry.id === lease.id)) return lease;

      const waits = [doc?.pausedUntil, doc?.nextStartAt]
        .map((at) => (at ? Date.parse(at) - now : 0))
        .filter((ms) => ms > 0);
      const ms = waits.length > 0 ? Math.max(...waits) : FULL_RETRY_MS;
      // Leichte Streuung, damit wartende Plätze nicht im Gleichschritt anfragen.
      await this.wait(ms + Math.floor(Math.random() * 250), signal);
    }
  }

  /**
   * Gibt den Platz frei. `transient` (Zeitüberschreitung, Serverfehler,
   * Netzwerk) pausiert die ganze Spur; ein Erfolg baut die Pause wieder ab.
   */
  async release(
    lease: LimiterLease,
    outcome: { ok: boolean; transient?: boolean; reason?: string; aborted?: boolean },
  ): Promise<void> {
    const now = Date.now();
    const ms = now - Date.parse(lease.startedAt);
    const pull = { $pull: { leases: { id: lease.id } } };
    const event = { $push: { recent: { $each: [{ at: iso(now), ok: outcome.ok, ms, transient: !!outcome.transient }], $slice: -RECENT_EVENTS } } };
    try {
      if (outcome.aborted) {
        await this.collection.updateOne({ _id: LIMITER_ID }, pull);
      } else if (outcome.ok) {
        await this.collection.updateOne(
          { _id: LIMITER_ID },
          { ...pull, ...event, $inc: { successStreak: 1 }, $set: { failureStreak: 0 } },
        );
      } else if (outcome.transient) {
        const doc = await this.collection.findOneAndUpdate(
          { _id: LIMITER_ID },
          { ...pull, ...event, $inc: { failureStreak: 1 }, $set: { successStreak: 0 } },
          { returnDocument: "after" },
        );
        const pauseMs = lanePauseMs(doc?.failureStreak ?? 1);
        const until = iso(now + pauseMs);
        const reason = (outcome.reason ?? "").slice(0, 200);
        await this.collection.updateOne(
          { _id: LIMITER_ID },
          { $max: { pausedUntil: until }, $set: { lastPauseReason: reason } },
        );
        this.options.log(`Anfragen pausiert für ${Math.round(pauseMs / 1000)} s (${reason})`);
      } else {
        // Inhaltlicher Fehler einer einzelnen Anfrage: kein Zeichen von Überlastung.
        await this.collection.updateOne({ _id: LIMITER_ID }, { ...pull, ...event });
      }
    } finally {
      const waiting = this.wakeLocal;
      this.wakeLocal = [];
      for (const resolve of waiting) resolve();
    }
  }

  /** Tatsächliche Rate der letzten zehn Minuten, für das Protokoll. */
  async summary(): Promise<string> {
    const doc = await this.collection.findOne({ _id: LIMITER_ID });
    if (!doc) return "noch keine Anfragen";
    const since = iso(Date.now() - 10 * 60 * 1000);
    const recent = (doc.recent ?? []).filter((event) => event.at >= since);
    const failed = recent.filter((event) => !event.ok).length;
    const running = (doc.leases ?? []).filter((entry) => entry.expiresAt > iso()).length;
    const allowed = (doc.successStreak ?? LIMITER_RAMP_SUCCESSES) < LIMITER_RAMP_SUCCESSES ? 1 : doc.maxConcurrent;
    return (
      `${(recent.length / 10).toFixed(1)} Anfragen/min (10 min), ${failed} Fehler, ` +
      `${running}/${allowed} laufend, Abstand ${Math.round(doc.minGapMs / 1000)} s`
    );
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.wakeLocal = this.wakeLocal.filter((entry) => entry !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      // Gibt ein Platz dieser Instanz frei, sofort neu versuchen (nicht während einer Pause).
      if (ms <= FULL_RETRY_MS + 250) this.wakeLocal.push(done);
    });
  }
}
