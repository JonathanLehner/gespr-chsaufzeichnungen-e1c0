/**
 * Richtet vorhandene Transkripte nachträglich an ihren Aufnahmen aus.
 *
 * Transkripte, die vor der Einführung der akustischen Ausrichtung entstanden
 * sind, tragen die geschätzten Zeiten des Sprachmodells. Dieses Skript ersetzt
 * sie durch gemessene, ohne den Text neu erzeugen zu lassen – es kostet keinen
 * Aufruf des Transkriptionsdienstes.
 *
 * Aufruf: npx tsx --env-file=.env.local --conditions=react-server scripts/realign-transcripts.mts [--alle]
 */
import { Collections, findMany } from "../src/lib/db";
import { realignRecording } from "../src/lib/transcription";
import type { Recording } from "../src/lib/types";

const all = process.argv.includes("--alle");

const recordings = (await findMany<Recording>(Collections.recordings, {}))
  .filter((recording) => recording.transcriptionStatus === "abgeschlossen")
  .filter((recording) => all || recording.transcriptionAlignment !== "akustisch")
  .sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0));

if (recordings.length === 0) {
  console.log("Alle Transkripte sind bereits ausgerichtet.");
  process.exit(0);
}

console.log(`${recordings.length} Transkripte werden ausgerichtet.\n`);
let done = 0;
let failed = 0;

for (const recording of recordings) {
  try {
    const result = await realignRecording(recording._id);
    console.log(`${result.ok ? "ok  " : "FEHL"} ${recording._id}  ${result.message}`);
    if (result.ok) done += 1;
    else failed += 1;
  } catch (error) {
    console.log(`FEHL ${recording._id}  ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
}

console.log(`\n${done} ausgerichtet, ${failed} nicht.`);
if (failed > 0) process.exit(1);
