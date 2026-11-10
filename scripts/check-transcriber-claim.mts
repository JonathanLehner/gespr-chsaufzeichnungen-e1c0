/**
 * Prüft, dass die Übernahme eines Auftrags exklusiv ist: Zwei Clients
 * (wie Staging und Produktion) übernehmen gleichzeitig 400-mal aus 100
 * Aufträgen (wartend, verwaist, fällige Wiederholung). Jeder Auftrag darf
 * genau einmal übernommen werden. Endgültig fehlgeschlagene Aufträge und
 * Wiederholungen, die erst später fällig sind, dürfen nie übernommen werden.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27017/claim_race" npx tsx scripts/check-transcriber-claim.mts
 *
 * Nur gegen eine Wegwerf-Datenbank ausführen: Die Sammlung `jobs` dieser
 * Datenbank wird geleert.
 */
import { MongoClient } from "mongodb";
import { claimableFilter, iso } from "../transcriber/shared/queue";

const uri = process.env.TEST_MONGODB_URI;
if (!uri) {
  console.error("TEST_MONGODB_URI fehlt (Wegwerf-Datenbank, nie die Produktionsdatenbank).");
  process.exit(1);
}

const [a, b] = await Promise.all([new MongoClient(uri).connect(), new MongoClient(uri).connect()]);
const ja = a.db().collection<{ _id: string; [field: string]: unknown }>("jobs");
const jb = b.db().collection<{ _id: string; [field: string]: unknown }>("jobs");
await ja.deleteMany({});
await ja.insertMany(
  Array.from({ length: 100 }, (_, i) => ({
    _id: `j${i}`,
    createdAt: iso(Date.parse("2026-11-02T09:22:00Z") + i * 1000),
    ...(i % 3 === 0
      ? { status: "in_arbeit", lockedAt: "2026-11-02T09:25:00Z", attempts: 1 }
      : i % 3 === 1
        ? { status: "wartend", lockedAt: null, attempts: 0 }
        : { status: "wartend", attempts: 7, nextAttemptAt: "2026-11-05T00:00:00Z" }),
  })),
);
// Nicht übernehmbar: endgültig fehlgeschlagen, Wiederholung erst in einer Stunde.
await ja.insertMany([
  { _id: "endgueltig", createdAt: iso(), status: "fehlgeschlagen", attempts: 1, permanent: true, nextAttemptAt: null },
  { _id: "spaeter", createdAt: iso(), status: "wartend", attempts: 9, nextAttemptAt: iso(Date.now() + 3600_000) },
]);

const claims = await Promise.all(
  Array.from({ length: 400 }, (_, i) =>
    (i % 2 ? ja : jb).findOneAndUpdate(
      claimableFilter(),
      { $set: { status: "in_arbeit", lockedAt: iso(), lockId: `L${i}` } },
      { sort: { createdAt: i % 4 < 2 ? -1 : 1 }, returnDocument: "before" },
    ),
  ),
);
const ids = claims.filter((doc) => doc !== null).map((doc) => doc._id);
if (ids.includes("endgueltig") || ids.includes("spaeter")) {
  console.error("FEHL: Ein nicht fälliger oder endgültig fehlgeschlagener Auftrag wurde übernommen.");
  process.exit(1);
}
const unique = new Set(ids).size;
const left = await ja.countDocuments(claimableFilter());
await Promise.all([a.close(), b.close()]);

console.log(`übernommen ${ids.length}, eindeutig ${unique}, noch offen ${left}`);
if (ids.length !== 100 || unique !== 100 || left !== 0) {
  console.error("FEHL: Ein Auftrag wurde doppelt oder gar nicht übernommen.");
  process.exit(1);
}
console.log("OK");
