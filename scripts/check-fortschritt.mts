/**
 * Reine Prüfungen zur Fortschrittsanzeige und zur Übernahme verwaister
 * Aufträge (ohne Datenbank): Restzeit aus der gemessenen Zeit je Abschnitt,
 * Position in der Warteschlange, Texte und der Filter für verwaiste Sperren.
 *
 *   npx tsx --test scripts/check-fortschritt.mts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STALE_LOCK_MS,
  claimableFilter,
  msPerChunk,
  queuePosition,
  remainingMs,
  staleLockFilter,
  type ProgressFields,
} from "../transcriber/shared/queue";
import {
  currentChunk,
  formatChunkRate,
  formatElapsed,
  formatRemaining,
  formatSecondsAgo,
  hasChunkProgress,
} from "../src/lib/progress-text";

const base: ProgressFields = {
  progressDone: 4,
  progressTotal: 10,
  progressRunAt: "2026-11-10T17:00:00.000Z",
  progressRunDone: 0,
  progressAt: "2026-11-10T17:02:00.000Z",
};

test("Zeit je Abschnitt und Restzeit aus dem laufenden Durchgang", () => {
  assert.equal(msPerChunk(base), 30_000);
  assert.equal(remainingMs(base), 6 * 30_000);
  assert.equal(formatRemaining(remainingMs(base)!), "ca. 3 Min. verbleibend");
  assert.equal(formatChunkRate(base), "2.0 Abschnitte/Min.");
});

test("fortgesetzter Durchgang zählt nur die neuen Abschnitte", () => {
  const resumed = { ...base, progressRunDone: 3 };
  assert.equal(msPerChunk(resumed), 120_000);
  assert.equal(remainingMs(resumed), 6 * 120_000);
});

test("ohne fertigen Abschnitt im Durchgang keine Schätzung", () => {
  assert.equal(msPerChunk({ ...base, progressRunDone: 4 }), null);
  assert.equal(remainingMs({ ...base, progressRunAt: null }), null);
  assert.equal(formatChunkRate({ ...base, progressDone: null }), null);
});

test("ein einziger Abschnitt gilt als unbestimmter Fortschritt", () => {
  assert.equal(hasChunkProgress({ progressTotal: 1 }), false);
  assert.equal(hasChunkProgress({ progressTotal: null }), false);
  assert.equal(hasChunkProgress({ progressTotal: 10 }), true);
  assert.equal(currentChunk({ progressDone: 3, progressTotal: 10 }), 4);
  assert.equal(currentChunk({ progressDone: 10, progressTotal: 10 }), 10);
});

test("Texte", () => {
  const now = Date.parse("2026-11-10T17:00:30.000Z");
  assert.equal(formatSecondsAgo("2026-11-10T17:00:18.000Z", now), "vor 12 s");
  assert.equal(formatSecondsAgo("2026-11-10T16:57:00.000Z", now), "vor 3 Min.");
  assert.equal(formatElapsed(84_000), "1 Min. 24 s");
  assert.equal(formatElapsed(9_000), "9 s");
  assert.equal(formatRemaining(20_000), "weniger als 1 Min. verbleibend");
});

test("Position: vorgezogene zuerst, danach von beiden Enden", () => {
  assert.equal(queuePosition({ prioritizedAhead: 0, older: 0, newer: 120 }), 1);
  assert.equal(queuePosition({ prioritizedAhead: 0, older: 120, newer: 0 }), 1);
  assert.equal(queuePosition({ prioritizedAhead: 0, older: 18, newer: 50 }), 37);
  assert.equal(queuePosition({ prioritizedAhead: 2, older: 5, newer: 5 }), 13);
});

test("verwaiste Sperre: nur lockedAt zählt, Text oder BSON-Datum", () => {
  const now = Date.parse("2026-11-10T17:00:00.000Z");
  const filter = staleLockFilter(now) as { status: string; $or: Record<string, unknown>[] };
  assert.equal(filter.status, "in_arbeit");
  assert.equal(JSON.stringify(filter).includes("workerId"), false);
  assert.equal(JSON.stringify(filter).includes("lockId"), false);
  assert.deepEqual(filter.$or[1], {
    lockedAt: { $type: "string", $lt: new Date(now - STALE_LOCK_MS).toISOString() },
  });
  assert.deepEqual(filter.$or[2], { lockedAt: { $type: "date", $lt: new Date(now - STALE_LOCK_MS) } });
  assert.deepEqual((claimableFilter(now) as { $or: unknown[] }).$or[1], filter);
});
