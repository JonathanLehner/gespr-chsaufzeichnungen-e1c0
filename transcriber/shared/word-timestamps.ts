/**
 * Wortzeiten und Sprecher von gemini-3.5-transcribe in die Struktur der
 * Transkripte (Sprecherabschnitt → Satz → Wort) überführen.
 *
 * Form der Antwort (Interactions-API, `transcription_config.mode` mit
 * `diarization_mode: "speaker"` und `timestamp_granularities: ["word"]`):
 *   steps[].content[] = { type: "text", text, annotations: [
 *     { type: "word_info", text: "Hallo", speaker: "spk_1",
 *       start_offset: "0.100s", end_offset: "0.400s" }, … ] }
 *
 * Reine Funktion ohne Laufzeitabhängigkeiten; genutzt vom direkten Weg im
 * Transkriptionsdienst (`requestDirectTranscript` in `transcriber/worker.ts`).
 */
import type { TranscriptSegment, TranscriptSentence, TranscriptWord } from "./types";

export type WordAnnotation = {
  type?: string;
  text?: string;
  speaker?: string;
  start_offset?: string | number;
  end_offset?: string | number;
};

/** "1.250s" oder 1.25 → 1250 ms; ungültig → `null`. */
export function offsetToMs(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const seconds = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/s$/, ""));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** Satzende: Wort endet auf . ? ! oder … (auch vor schliessenden Anführungszeichen). */
const SENTENCE_END = /[.?!…]["'»«”)]*$/;

/**
 * Baut Sprecherabschnitte aus Wortannotationen. Ein neuer Abschnitt beginnt
 * bei jedem Sprecherwechsel, ein neuer Satz nach Satzzeichen am Wortende oder
 * mit dem Sprecherwechsel. `offsetMs` verschiebt auf die Gesprächszeit.
 */
export function segmentsFromWords(
  annotations: readonly WordAnnotation[],
  offsetMs = 0,
): { segments: TranscriptSegment[]; speakerLabels: string[]; wordCount: number } {
  const speakerIds = new Map<string, string>();
  const segments: TranscriptSegment[] = [];
  let segment: TranscriptSegment | null = null;
  let sentence: TranscriptSentence | null = null;
  let cursor = 0;
  let wordCount = 0;

  const closeSentence = () => {
    if (segment && sentence && sentence.words.length > 0) {
      sentence.text = sentence.words.map((word) => word.text).join(" ");
      segment.sentences.push(sentence);
      segment.endMs = sentence.endMs;
    }
    sentence = null;
  };

  for (const annotation of annotations) {
    if (annotation.type && annotation.type !== "word_info") continue;
    const text = (annotation.text ?? "").trim();
    if (!text) continue;
    const raw = (annotation.speaker ?? "").trim() || "spk_1";
    let speaker = speakerIds.get(raw);
    if (!speaker) {
      speaker = `S${speakerIds.size + 1}`;
      speakerIds.set(raw, speaker);
    }
    const start = Math.max(offsetToMs(annotation.start_offset) ?? cursor, cursor);
    const end = Math.max(offsetToMs(annotation.end_offset) ?? start + 200, start + 1);
    cursor = end;
    const word: TranscriptWord = { text, startMs: start + offsetMs, endMs: end + offsetMs };

    if (!segment || segment.speaker !== speaker) {
      closeSentence();
      segment = {
        speaker,
        speakerLabel: `Sprecher ${speaker.slice(1)}`,
        startMs: word.startMs,
        endMs: word.endMs,
        sentences: [],
      };
      segments.push(segment);
    }
    if (!sentence) sentence = { text: "", startMs: word.startMs, endMs: word.endMs, words: [] };
    const current: TranscriptSentence = sentence;
    current.words.push(word);
    current.endMs = word.endMs;
    wordCount += 1;
    if (SENTENCE_END.test(text)) closeSentence();
  }
  closeSentence();

  const used = segments.filter((entry) => entry.sentences.length > 0);
  return {
    segments: used,
    speakerLabels: [...new Set(used.map((entry) => entry.speakerLabel))],
    wordCount,
  };
}
