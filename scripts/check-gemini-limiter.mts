/**
 * Prüft die gemeinsame Drossel unter Wettbewerb: Zwei Clients (wie Staging
 * und Produktion) mit je vier wartenden Plätzen stellen 40 Anfragen. Es
 * dürfen nie mehr als zwei gleichzeitig laufen; nach einer Störung läuft nur
 * eine zugleich, bis drei Anfragen in Folge gelungen sind.
 *
 *   TEST_MONGODB_URI="mongodb://localhost:27999/limiter_check?directConnection=true" \
 *     npx tsx scripts/check-gemini-limiter.mts
 *
 * Nur gegen eine Wegwerf-Datenbank ausführen: `transcriber_limiter` wird geleert.
 */
import { MongoClient } from "mongodb";
import { GeminiLimiter } from "../transcriber/limiter";
import { LIMITER_COLLECTION, LIMITER_ID, type LimiterDoc } from "../transcriber/shared/queue";

const uri = process.env.TEST_MONGODB_URI;
if (!uri) {
  console.error("TEST_MONGODB_URI fehlt (Wegwerf-Datenbank, nie die Produktionsdatenbank).");
  process.exit(1);
}

const [a, b] = await Promise.all([new MongoClient(uri).connect(), new MongoClient(uri).connect()]);
// Der Dienst bringt seine eigene Kopie des Treibers mit; die Typen sind gleich aufgebaut.
type LimiterCollection = ConstructorParameters<typeof GeminiLimiter>[0];
const col = (client: MongoClient) =>
  client.db().collection<LimiterDoc>(LIMITER_COLLECTION) as unknown as LimiterCollection;
await col(a).deleteMany({});
const options = { maxConcurrent: 2, minGapMs: 0, leaseMs: 60_000, log: () => undefined };
const limiters = [new GeminiLimiter(col(a), "A", options), new GeminiLimiter(col(b), "B", options)];

let running = 0;
let max = 0;
let remaining = 40;
const signal = new AbortController().signal;
await Promise.all(
  Array.from({ length: 8 }, async (_, i) => {
    const limiter = limiters[i % 2];
    while (remaining-- > 0) {
      const lease = await limiter.acquire(signal);
      running += 1;
      max = Math.max(max, running);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      running -= 1;
      await limiter.release(lease, { ok: true });
    }
  }),
);
const errors: string[] = [];
if (max !== 2) errors.push(`Höchstens ${max} gleichzeitig statt genau 2.`);

// Störung: Spur pausiert, danach nur eine Anfrage zugleich bis drei Erfolge.
const lease = await limiters[0].acquire(signal);
await limiters[0].release(lease, { ok: false, transient: true, reason: "504" });
const doc = await col(a).findOne({ _id: LIMITER_ID });
const pause = doc?.pausedUntil ? Date.parse(doc.pausedUntil) - Date.now() : 0;
if (pause < 25_000 || pause > 31_000) errors.push(`Pause ${pause} ms statt 30 s.`);
await col(a).updateOne({ _id: LIMITER_ID }, { $set: { pausedUntil: null } });
const first = await limiters[0].acquire(signal);
const blocked = await Promise.race([
  limiters[1].acquire(signal).then((l) => limiters[1].release(l, { ok: true }).then(() => false)),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1500)),
]);
if (!blocked) errors.push("Nach der Störung liefen sofort wieder zwei Anfragen gleichzeitig.");
await limiters[0].release(first, { ok: true });

await Promise.all([a.close(), b.close()]);
console.log(`höchstens ${max} gleichzeitig, Pause ${Math.round(pause / 1000)} s, Anlauf mit einer Anfrage: ${blocked}`);
if (errors.length) {
  console.error("FEHL:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("OK");
process.exit(0);
