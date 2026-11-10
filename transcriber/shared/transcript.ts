/**
 * Reine Verarbeitung der Antworten des Transkriptionsdienstes: Prompt,
 * Auswertung, Zusammensetzen der Abschnitte und Aufteilen für die Ablage.
 * Gemeinsam genutzt von der Anwendung und dem Transkriptionsdienst
 * (`transcriber/`), deshalb ohne Datenbank- oder Laufzeitabhängigkeiten.
 */
import type { TranscriptSegment, TranscriptSentence, TranscriptWord } from "./types";

export const MAX_PART_BYTES = 350 * 1024; // Grenze des Datenbank-Endpunkts ist 1 MB

/**
 * Die abgefragten Zeitangaben sind nur noch Rückfallwerte.
 *
 * Sie werden nach dem Transkribieren durch gemessene ersetzt (siehe
 * `transcriber/shared/forced-alignment.ts`) und kommen nur dann zum Tragen, wenn die
 * Audiodatei nicht abrufbar war. Sie bleiben trotzdem im Prompt: Sie kosten je
 * Satz zwei Zahlen, halten das Modell aber dazu an, die Aufnahme der Reihe nach
 * durchzuhören, statt sie zusammenzufassen.
 */
export const PROMPT = `Du transkribierst Telefongespräche der Immotrust AG, einer Immobilienfirma aus Zürich. Ein Mitarbeiter ruft Liegenschaftsbesitzer in der Deutschschweiz an und fragt, ob sie ihr Grundstück oder ihre Liegenschaft verkaufen möchten. Fast alle sprechen Schweizerdeutsch, meist Zürichdeutsch.

Aufgabe: Transkribiere die beigefügte Audioaufnahme vollständig und wortgetreu IN SCHWEIZERDEUTSCH, so wie gesprochen.

Regeln:
- Übersetze NICHT ins Hochdeutsche. Schreib die Mundart so, wie man sie in der Schweiz schreibt (z. B. "Grüezi", "Ja, grüess Sie", "das isch de Labruzzo vo de Firma Immotrust", "mir lueged grad", "Liegeschaft", "nimmt mi wunder", "hät", "gsi", "öppe", "chönd Sie").
- Bleib über die ganze Aufnahme bei der Mundart. Nur wer tatsächlich Hochdeutsch spricht, wird hochdeutsch geschrieben.
- Kein ß, immer ss.
- Eigennamen, Orte und Strassen in ihrer offiziellen Schreibweise (z. B. Knonau, Schlieren, Oerlikon, Grundstrasse, Zürcherstrasse, Immotrust). Personennamen genau so, wie sie zu hören sind; im Zweifel die übliche Schweizer Schreibweise.
- Trenne die Sprecher. Vergib stabile Kennungen S1, S2, S3 in der Reihenfolge des ersten Auftretens.
- Nennt sich jemand mit Namen oder wird so angesprochen, verwende den Namen als Bezeichnung des Sprechers (z. B. "Frau Muster"), sonst "Sprecher 1", "Sprecher 2". Verwende nur Namen, die in der Aufnahme tatsächlich fallen.
- Gliedere jeden Sprecherbeitrag in einzelne Sätze.
- Alle Zeitangaben in ganzen Millisekunden ab Beginn der Aufnahme, aufsteigend und ohne Überlappung.
- Erfinde nichts. Unverständliche Stellen als [unverständlich] kennzeichnen.

Antworte ausschliesslich mit JSON in genau dieser Struktur:
{"speakers":[{"id":"S1","label":"Frau Muster"}],
 "segments":[{"speaker":"S1","startMs":0,"endMs":2100,
   "sentences":[{"text":"Grüezi mitenand.","startMs":0,"endMs":2100}]}]}

Ist auf der Aufnahme nichts Gesprochenes zu hören – etwa nur Freizeichen, Besetztton, Rauschen oder Stille –, dann antworte mit {"speakers":[],"segments":[]}. Erfinde in diesem Fall keinen Text.`;

/** Was aus dem vorigen Abschnitt bekannt ist: Sprecherbezeichnungen und die letzten Sätze. */
export type ChunkContext = { labels: string[]; lastLines: { label: string; text: string }[] };

/**
 * Bezeichnungen und Schluss des vorigen Abschnitts. Damit vergibt das Modell
 * im nächsten Abschnitt dieselben Namen statt neu „Sprecher 1/2“, und
 * `mergeChunks` führt dieselbe Person über die Abschnitte zusammen.
 */
export function chunkContext(previous: NormalizedTranscript | null | undefined, lines = 4): ChunkContext | null {
  if (!previous || previous.segments.length === 0) return null;
  const all = previous.segments.flatMap((segment) =>
    segment.sentences.map((sentence) => ({ label: segment.speakerLabel, text: sentence.text })),
  );
  return { labels: [...new Set(previous.segments.map((segment) => segment.speakerLabel))], lastLines: all.slice(-lines) };
}

/**
 * Zusatz für einen einzelnen Abschnitt. Der Dienst hört nur diesen Ausschnitt;
 * die Zeitangaben zählen deshalb ab Beginn des Abschnitts und werden erst beim
 * Zusammensetzen auf die Gesprächszeit verschoben.
 *
 * Der Name aus den Metadaten wird bewusst nicht mitgegeben: In der Messung hat
 * das Modell ihn als Sprecherbezeichnung übernommen, auch wenn er im Abschnitt
 * gar nicht fiel. Bekannt sind nur die Bezeichnungen, die das Modell selbst im
 * vorigen Abschnitt aus dem Gehörten vergeben hat (`context`).
 */
export function chunkPrompt(index: number, count: number, context: ChunkContext | null = null): string {
  let text = `${PROMPT}

Diese Audiodatei ist Abschnitt ${index + 1} von ${count} eines längeren Gesprächs.
- Alle Zeitangaben zählen ab dem Beginn dieses Abschnitts, nicht ab dem Beginn des Gesprächs.
- Der Abschnitt kann mitten in einem Satz beginnen und enden. Gib angefangene Sätze so wieder, wie sie zu hören sind, und ergänze nichts.
- Verwende für dieselbe Person durchgehend dieselbe Bezeichnung.`;
  if (context && context.labels.length > 0) {
    text += `

Im vorigen Abschnitt sind diese Sprecher vorgekommen: ${context.labels.map((label) => `"${label}"`).join(", ")}.
Er endete so:
${context.lastLines.map((line) => `${line.label}: ${line.text}`).join("\n")}
Spricht dieselbe Person weiter, verwende genau dieselbe Bezeichnung wie oben, auch wenn ihr Name in diesem Abschnitt nicht fällt. Ordne die Stimmen anhand des Gesprächsverlaufs zu (wer anruft, wer angerufen wird). Neue Bezeichnungen nur für Personen, die neu dazukommen. Die Sätze oben gehören nicht zu diesem Abschnitt; schreib sie nicht noch einmal.`;
  }
  return text;
}

/**
 * Struktur der Antwort für `generationConfig.responseSchema` (OpenAPI-Teilmenge
 * der Gemini API). Sie bindet das Modell an gültiges JSON in genau der Form,
 * die der Prompt beschreibt.
 */
export const TRANSCRIPT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["speakers", "segments"],
  properties: {
    speakers: {
      type: "ARRAY",
      items: { type: "OBJECT", required: ["id", "label"], properties: { id: { type: "STRING" }, label: { type: "STRING" } } },
    },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["speaker", "startMs", "endMs", "sentences"],
        properties: {
          speaker: { type: "STRING" },
          startMs: { type: "INTEGER" },
          endMs: { type: "INTEGER" },
          sentences: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              required: ["text", "startMs", "endMs"],
              properties: { text: { type: "STRING" }, startMs: { type: "INTEGER" }, endMs: { type: "INTEGER" } },
            },
          },
        },
      },
    },
  },
} as const;

type RawWord = { text?: string; startMs?: number; endMs?: number };
type RawSentence = { text?: string; startMs?: number; endMs?: number; words?: RawWord[] };
type RawSegment = { speaker?: string; startMs?: number; endMs?: number; sentences?: RawSentence[] };
export type RawTranscript = { speakers?: { id?: string; label?: string }[]; segments?: RawSegment[] };

export function parseJsonLoosely(text: string): RawTranscript {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate) as RawTranscript;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as RawTranscript;
    }
    throw new Error("Die Antwort des Transkriptionsdienstes war kein gültiges JSON.");
  }
}

function toMs(value: unknown, fallback: number): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric);
}

export type NormalizedTranscript = {
  segments: TranscriptSegment[];
  speakerLabels: string[];
  wordCount: number;
  endMs: number;
};

/**
 * Bringt die Modellantwort in eine lückenlose, aufsteigende Struktur.
 *
 * Ein leeres Ergebnis ist gültig und kein Fehler: Es bedeutet, dass auf der
 * Aufnahme nichts Gesprochenes zu hören war. Wie damit umzugehen ist,
 * entscheidet der Aufrufer.
 */
export function normalizeTranscript(raw: RawTranscript): NormalizedTranscript {
  const labels = new Map<string, string>();
  (raw.speakers ?? []).forEach((speaker, index) => {
    const id = (speaker.id ?? `S${index + 1}`).trim();
    labels.set(id, (speaker.label ?? "").trim() || `Sprecher ${index + 1}`);
  });

  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  let wordCount = 0;

  for (const rawSegment of raw.segments ?? []) {
    const speaker = (rawSegment.speaker ?? "S1").trim() || "S1";
    if (!labels.has(speaker)) labels.set(speaker, `Sprecher ${labels.size + 1}`);

    const sentences: TranscriptSentence[] = [];
    for (const rawSentence of rawSegment.sentences ?? []) {
      const text = (rawSentence.text ?? "").trim();
      if (!text) continue;
      const startMs = Math.max(toMs(rawSentence.startMs, cursor), cursor);
      let endMs = toMs(rawSentence.endMs, startMs + Math.max(800, text.length * 60));
      if (endMs <= startMs) endMs = startMs + Math.max(800, text.length * 60);

      const rawWords = (rawSentence.words ?? []).filter((word) => (word.text ?? "").trim().length > 0);
      let words: TranscriptWord[];
      if (rawWords.length > 0) {
        let wordCursor = startMs;
        words = rawWords.map((word, index) => {
          const wordStart = Math.max(toMs(word.startMs, wordCursor), wordCursor);
          const evenly = startMs + ((endMs - startMs) * (index + 1)) / rawWords.length;
          let wordEnd = toMs(word.endMs, Math.round(evenly));
          if (wordEnd <= wordStart) wordEnd = Math.min(endMs, wordStart + 200);
          wordCursor = wordEnd;
          return { text: (word.text ?? "").trim(), startMs: wordStart, endMs: wordEnd };
        });
      } else {
        // Der Prompt verlangt keine Wortzeiten mehr – sie zu erzeugen kostete
        // den Dienst ein Vielfaches der Antwortzeit und war die Ursache der
        // Zeitüberschreitungen. Innerhalb des gemessenen Satzes werden die
        // Wörter deshalb gleichmässig verteilt. Das Mitlaufen im Transkript
        // bleibt dadurch erhalten; genau sind die Satzgrenzen, nicht die
        // einzelnen Wortgrenzen.
        const tokens = text.split(/\s+/).filter(Boolean);
        const step = (endMs - startMs) / Math.max(tokens.length, 1);
        words = tokens.map((token, index) => ({
          text: token,
          startMs: Math.round(startMs + step * index),
          endMs: Math.round(startMs + step * (index + 1)),
        }));
      }
      wordCount += words.length;
      const last = words[words.length - 1];
      if (last && last.endMs > endMs) endMs = last.endMs;
      sentences.push({ text, startMs, endMs, words });
      cursor = endMs;
    }
    if (sentences.length === 0) continue;
    segments.push({
      speaker,
      speakerLabel: labels.get(speaker) ?? speaker,
      startMs: sentences[0].startMs,
      endMs: sentences[sentences.length - 1].endMs,
      sentences,
    });
  }

  const usedSpeakers = new Set(segments.map((segment) => segment.speaker));
  return {
    segments,
    speakerLabels: [...usedSpeakers].map((id) => labels.get(id) ?? id),
    wordCount,
    endMs: segments.length > 0 ? segments[segments.length - 1].endMs : 0,
  };
}

/** Verschiebt einen Abschnitt auf seine Position im Gesamtgespräch. */
export function shiftSegments(segments: TranscriptSegment[], offsetMs: number): TranscriptSegment[] {
  if (offsetMs === 0) return segments;
  return segments.map((segment) => ({
    ...segment,
    startMs: segment.startMs + offsetMs,
    endMs: segment.endMs + offsetMs,
    sentences: segment.sentences.map((sentence) => ({
      ...sentence,
      startMs: sentence.startMs + offsetMs,
      endMs: sentence.endMs + offsetMs,
      words: sentence.words.map((word) => ({
        ...word,
        startMs: word.startMs + offsetMs,
        endMs: word.endMs + offsetMs,
      })),
    })),
  }));
}

/**
 * Setzt die Abschnitte zu einem Transkript zusammen.
 *
 * Die Sprecherkennungen S1, S2 … vergibt der Dienst je Abschnitt neu. Zusammen
 * gehören deshalb jene Beiträge, die dieselbe Bezeichnung tragen – der Prompt
 * verlangt für dieselbe Person in jedem Abschnitt dieselbe Bezeichnung. Nennt
 * ein Abschnitt einen Namen und der nächste nicht, bleiben beide als eigene
 * Sprecher stehen; das ist ohne abschnittsübergreifenden Höreindruck nicht
 * auflösbar und im Transkript sichtbar, statt still falsch zusammengeführt.
 */
export function mergeChunks(parts: NormalizedTranscript[]): NormalizedTranscript {
  const ids = new Map<string, string>();
  const segments: TranscriptSegment[] = [];
  let wordCount = 0;

  for (const part of parts) {
    for (const segment of part.segments) {
      const key = segment.speakerLabel.trim().toLowerCase();
      let id = ids.get(key);
      if (!id) {
        id = `S${ids.size + 1}`;
        ids.set(key, id);
      }
      segments.push({ ...segment, speaker: id });
    }
    wordCount += part.wordCount;
  }

  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const speakerLabels = [...new Set(segments.map((segment) => segment.speakerLabel))];

  return {
    segments,
    speakerLabels,
    wordCount,
    endMs: segments.length > 0 ? segments[segments.length - 1].endMs : 0,
  };
}

export type TranscriptPart = {
  _id: string;
  recordingId: string;
  partIndex: number;
  partCount: number;
  segments: TranscriptSegment[];
};

export function splitIntoParts(recordingId: string, segments: TranscriptSegment[]): TranscriptPart[] {
  const parts: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const segmentSize = JSON.stringify(segment).length;
    if (current.length > 0 && size + segmentSize > MAX_PART_BYTES) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += segmentSize;
  }
  if (current.length > 0) parts.push(current);
  return parts.map((partSegments, index) => ({
    _id: `${recordingId}:${index}`,
    recordingId,
    partIndex: index,
    partCount: parts.length,
    segments: partSegments,
  }));
}

export type TranscriptIndex = {
  _id: string;
  recordingId: string;
  fullText: string;
  sentences: { t: number; e: number; s: string; x: string }[];
  speakerLabels: string[];
  updatedAt: string;
};

/** Kompakter Volltext-Index einer Aufnahme für Suche und Anzeige. */
export function buildTranscriptIndex(
  recordingId: string,
  segments: TranscriptSegment[],
  speakerLabels: string[],
): TranscriptIndex {
  const sentences = segments.flatMap((segment) =>
    segment.sentences.map((sentence) => ({
      t: sentence.startMs,
      e: sentence.endMs,
      s: segment.speakerLabel,
      x: sentence.text,
    })),
  );
  return {
    _id: recordingId,
    recordingId,
    fullText: sentences.map((sentence) => sentence.x).join(" "),
    sentences,
    speakerLabels,
    updatedAt: new Date().toISOString(),
  };
}
