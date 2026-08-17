/** Zeigt den Zustand der Daten für eine Stichprobe an. */
import { Collections, findMany } from "../src/lib/db";
import { loadTranscript } from "../src/lib/transcription";
import type { Recording, TranscriptIndexDoc } from "../src/lib/types";

const recordings = await findMany<Recording>(Collections.recordings, {});
console.log(`Aufnahmen: ${recordings.length}`);
for (const recording of recordings) {
  console.log(
    `  ${recording.originalFilename} | ${recording.transcriptionStatus} | ${recording.wordCount ?? "-"} Wörter | ${recording.speakerCount ?? "-"} Sprecher | Bewertung ${recording.ratingAverage ?? "-"} (${recording.ratingCount}) | bucket ${(recording as unknown as { bucket: number }).bucket} | markiert: ${recording.deletionFlagged}`,
  );
}

const first = recordings.find((row) => row.transcriptionStatus === "abgeschlossen");
if (first) {
  const segments = await loadTranscript(first._id);
  console.log(`\nTranskript von ${first.originalFilename}: ${segments.length} Sprecherabschnitte`);
  for (const segment of segments.slice(0, 3)) {
    console.log(`  [${segment.speakerLabel}] ${segment.startMs}–${segment.endMs} ms`);
    for (const sentence of segment.sentences.slice(0, 2)) {
      console.log(`    ${sentence.startMs}: ${sentence.text}`);
      console.log(
        `      Wörter: ${sentence.words.slice(0, 5).map((word) => `${word.text}@${word.startMs}`).join(" ")}`,
      );
    }
  }
  const index = await findMany<TranscriptIndexDoc>(Collections.transcriptIndex, {
    recordingId: first._id,
  });
  console.log(`\nIndex: ${index[0]?.sentences.length} Sätze, ${index[0]?.fullText.length} Zeichen`);
  console.log(`  Volltext-Ausschnitt: ${index[0]?.fullText.slice(0, 220)} …`);
}

const suche = await findMany<TranscriptIndexDoc>(Collections.transcriptIndex, {
  fullText: { $regex: "Nebenkosten", $options: "i" },
});
console.log(`\nVolltextsuche "Nebenkosten": ${suche.length} Aufnahme(n)`);
