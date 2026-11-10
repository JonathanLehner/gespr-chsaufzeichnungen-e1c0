/**
 * Typen, die die Anwendung und der Transkriptionsdienst (`transcriber/`)
 * gemeinsam verwenden. Reine Typen, ohne Laufzeitcode.
 */

export type AudioMime = "audio/wav" | "audio/mpeg";

/**
 * Herkunft der Zeitangaben eines Transkripts.
 *
 * `akustisch`: an der Aufnahme ausgerichtet – die Wortmarkierung folgt dem
 * Gehörten. `geschaetzt`: die Datei war beim Transkribieren nicht lesbar, die
 * Zeiten stammen aus dem Sprachmodell und sind nur grob.
 */
export type AlignmentSource = "akustisch" | "geschaetzt";

export type TranscriptWord = {
  text: string;
  startMs: number;
  endMs: number;
};

export type TranscriptSentence = {
  text: string;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
};

export type TranscriptSegment = {
  speaker: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  sentences: TranscriptSentence[];
};
