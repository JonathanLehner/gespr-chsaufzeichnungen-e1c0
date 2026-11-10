/**
 * Trägt die Herkunft bestehender Transkripte nach: Alle Transkripte vor der
 * Modellauswahl stammen von gemini-2.5-flash mit geschätzten Zeiten (Forced
 * Alignment). Ändert nur abgeschlossene Aufnahmen ohne `transcript`; Text,
 * Zeiten und Status bleiben unberührt. Mehrfach ausführbar.
 *
 *   MONGODB_URI=… npx tsx scripts/backfill-transcript-meta.mts [--dry-run]
 */
import { MongoClient } from "mongodb";
import { legacyTranscriptMeta } from "../transcriber/shared/models";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI fehlt.");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const client = await new MongoClient(uri, { maxPoolSize: 2 }).connect();
try {
  const recordings = client.db().collection<{
    _id: string;
    transcriptionFinishedAt?: string | null;
    durationMs?: number | null;
  }>("recordings");
  const filter = { transcriptionStatus: "abgeschlossen", transcript: { $exists: false } };
  const rows = await recordings
    .find(filter, { projection: { transcriptionFinishedAt: 1, durationMs: 1 } })
    .toArray();
  console.log(`${rows.length} Transkripte ohne Herkunftsangabe${dryRun ? " (Probelauf)" : ""}.`);
  if (!dryRun && rows.length > 0) {
    const result = await recordings.bulkWrite(
      rows.map((row) => ({
        updateOne: {
          filter: { _id: row._id, transcript: { $exists: false } },
          update: {
            $set: { transcript: legacyTranscriptMeta(row.transcriptionFinishedAt ?? null, row.durationMs ?? null) },
          },
        },
      })),
    );
    console.log(`${result.modifiedCount} nachgetragen.`);
  }
} finally {
  await client.close();
}
