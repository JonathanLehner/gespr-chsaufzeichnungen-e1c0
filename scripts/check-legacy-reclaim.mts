/**
 * Prüft die Übernahme verwaister Aufträge aus der früheren Verarbeitung in
 * der Anfrage: `in_arbeit`, `lockedAt` vom 02.11.2026, ohne `workerId`,
 * `lockId` und `staleClaims` (genau die Form der acht hängenden Aufträge in
 * der Produktion), dazu eine Variante mit `lockedAt` als BSON-Datum.
 *
 * Erwartet: Diese Aufträge werden vor allen wartenden übernommen, auch wenn
 * ältere und neuere wartende Aufträge vorhanden sind; ein laufender Auftrag
 * mit frischem Lebenszeichen wird nie übernommen; zwei gleichzeitige Clients
 * übernehmen keinen Auftrag doppelt.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27017/legacy_reclaim?directConnection=true" \
 *     npx tsx scripts/check-legacy-reclaim.mts
 *
 * Nur gegen eine Wegwerf-Datenbank ausführen: Die Sammlung `jobs` wird geleert.
 */
import { MongoClient } from "mongodb";
import { claimJob } from "../transcriber/claim";
import { iso } from "../transcriber/shared/queue";

const uri = process.env.TEST_MONGODB_URI;
if (!uri) {
  console.error("TEST_MONGODB_URI fehlt (Wegwerf-Datenbank, nie die Produktionsdatenbank).");
  process.exit(1);
}

type Job = { _id: string; [field: string]: unknown };
const [a, b] = await Promise.all([new MongoClient(uri).connect(), new MongoClient(uri).connect()]);
const ja = a.db().collection<Job>("jobs");
const jb = b.db().collection<Job>("jobs");
await ja.deleteMany({});

let failures = 0;
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "ok  " : "FEHL"} ${message}`);
  if (!ok) failures += 1;
};

/** Form aus der Produktion (rec_609807c40082e579524c7967 u. a.). */
const legacy = (id: string, lockedAt: string | Date, createdAt: string): Job => ({
  _id: id,
  recordingId: id,
  type: "transkription",
  status: "in_arbeit",
  attempts: 1,
  lastError: null,
  createdAt,
  startedAt: typeof lockedAt === "string" ? lockedAt : lockedAt.toISOString(),
  finishedAt: null,
  lockedAt,
  nextAttemptAt: null,
  originalFilename: `[Labruzzo (IT), Valerio]_387-0443222422_20261021123024(${id}).wav`,
});

const legacyIds = ["alt-1", "alt-2", "alt-3", "alt-datum"];
await ja.insertMany([
  legacy("alt-1", "2026-11-02T09:25:20.058Z", "2026-11-02T09:23:45.411Z"),
  legacy("alt-2", "2026-11-02T09:25:20.782Z", "2026-11-02T09:23:45.541Z"),
  legacy("alt-3", "2026-11-02T09:25:21.701Z", "2026-11-02T09:23:46.485Z"),
  legacy("alt-datum", new Date("2026-11-02T09:25:22.000Z"), "2026-11-02T09:23:47.000Z"),
  // Wartende davor und danach: Weder „älteste zuerst“ noch „neueste zuerst“ darf sie vorziehen.
  ...Array.from({ length: 40 }, (_, i) => ({
    _id: `w${i}`,
    status: "wartend",
    attempts: 0,
    lockedAt: null,
    nextAttemptAt: null,
    createdAt: iso(Date.parse(i < 20 ? "2026-11-01T08:00:00Z" : "2026-11-09T08:00:00Z") + i * 1000),
  })),
  // Läuft gerade mit frischem Lebenszeichen: nie übernehmen.
  {
    _id: "laeuft",
    status: "in_arbeit",
    attempts: 1,
    createdAt: "2026-10-01T00:00:00Z",
    lockedAt: iso(Date.now() - 20_000),
    lockId: "fremd",
    workerId: "andere-instanz",
  },
  // Vor 2 Minuten zuletzt gemeldet: noch innerhalb der Frist von 3 Minuten.
  {
    _id: "knapp",
    status: "in_arbeit",
    attempts: 1,
    createdAt: "2026-10-01T00:00:01Z",
    lockedAt: iso(Date.now() - 120_000),
    lockId: "fremd-2",
    workerId: "andere-instanz",
  },
]);

// 1. Die ersten vier Übernahmen (abwechselnd neueste/älteste) sind die verwaisten Aufträge.
const first: string[] = [];
for (let i = 0; i < 4; i += 1) {
  const job = await claimJob(i % 2 ? ja : jb, { lockId: `L${i}`, workerId: "pruefung", newestFirst: i % 2 === 0 });
  if (job) first.push(job._id);
}
check(
  JSON.stringify(first) === JSON.stringify(legacyIds),
  `verwaiste zuerst, älteste Sperre vorne: ${first.join(", ")}`,
);

const claimed = await ja.find({ _id: { $in: legacyIds } }).toArray();
check(
  claimed.every((job) => job.status === "in_arbeit" && job.workerId === "pruefung" && typeof job.lockId === "string"),
  "übernommene Aufträge tragen jetzt lockId und workerId",
);

// 2. Danach laufen sie mit frischem Lebenszeichen und dürfen nicht erneut übernommen werden.
const rest = await Promise.all(
  Array.from({ length: 80 }, (_, i) =>
    claimJob(i % 2 ? ja : jb, { lockId: `R${i}`, workerId: "pruefung", newestFirst: i % 4 < 2 }),
  ),
);
const ids = rest.filter((job) => job !== null).map((job) => job!._id);
check(new Set(ids).size === ids.length, `keine doppelte Übernahme (${ids.length} übernommen)`);
check(ids.length === 40, "alle 40 wartenden übernommen");
check(!ids.some((id) => legacyIds.includes(id)), "bereits übernommene verwaiste nicht erneut vergeben");
check(!ids.includes("laeuft") && !ids.includes("knapp"), "Aufträge mit frischem Lebenszeichen bleiben unberührt");

// 3. Ohne Lebenszeichen über die Frist hinaus wird auch ein so übernommener Auftrag wieder frei.
const later = Date.now() + 4 * 60 * 1000;
const again = await claimJob(ja, { lockId: "spaeter", workerId: "pruefung-2", newestFirst: true, now: later });
check(again?._id === "knapp", `nach Ablauf der Frist wieder übernommen, älteste Sperre zuerst: ${again?._id}`);

await ja.deleteMany({});
await Promise.all([a.close(), b.close()]);
if (failures > 0) {
  console.error(`${failures} Prüfung(en) fehlgeschlagen.`);
  process.exit(1);
}
console.log("OK");
