"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TranscriptSegment } from "@/lib/types";

export type FlatSentence = {
  index: number;
  speaker: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  words: { text: string; startMs: number; endMs: number }[];
  newSpeaker: boolean;
};

export function flattenSegments(segments: TranscriptSegment[]): FlatSentence[] {
  const flat: FlatSentence[] = [];
  let previousSpeaker = "";
  for (const segment of segments) {
    for (const sentence of segment.sentences) {
      flat.push({
        index: flat.length,
        speaker: segment.speaker,
        speakerLabel: segment.speakerLabel,
        startMs: sentence.startMs,
        endMs: sentence.endMs,
        text: sentence.text,
        words: sentence.words,
        // Die Sprecherbezeichnung erscheint nur beim Wechsel, nicht bei jedem Satz.
        newSpeaker: segment.speaker !== previousSpeaker,
      });
      previousSpeaker = segment.speaker;
    }
  }
  return flat;
}

function timecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const SPEAKER_TONES = [
  "bg-petrol-soft text-petrol",
  "bg-warn-soft text-warn",
  "bg-ok-soft text-ok",
  "bg-busy-soft text-busy",
];

/**
 * Ermittelt, welche Wörter einer Zeile zum Suchbegriff gehören.
 *
 * Der Vergleich läuft über den zusammengesetzten Satz und nicht über einzelne
 * Wörter: Ein Begriff aus mehreren Wörtern („Guten Tag“) steckt in keinem
 * einzelnen Wort, blieb bei der wortweisen Prüfung also unmarkiert, obwohl die
 * Zeile als Treffer gezählt wurde. Ebenso findet die Suche jetzt Wortteile über
 * Wortgrenzen hinweg.
 */
function matchedWordIndexes(words: { text: string }[], query: string): Set<number> {
  const hits = new Set<number>();
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return hits;

  const ranges: [number, number][] = [];
  let offset = 0;
  for (const word of words) {
    ranges.push([offset, offset + word.text.length]);
    offset += word.text.length + 1; // Trennzeichen zwischen zwei Wörtern
  }
  const haystack = words.map((word) => word.text).join(" ").toLowerCase();

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    ranges.forEach(([start, stop], index) => {
      if (start < end && stop > at) hits.add(index);
    });
    from = at + needle.length;
  }
  return hits;
}

type RowProps = {
  sentence: FlatSentence;
  active: boolean;
  matchState: "keiner" | "treffer" | "aktuell";
  query: string;
  tone: string;
  hintId: string;
  onSeek: (ms: number) => void;
};

/**
 * Ein Satz ist genau eine Tabulator-Station und genau eine Sprungmarke.
 *
 * Früher war jedes Wort fokussierbar; ein zwanzigminütiges Gespräch ergab damit
 * mehrere tausend Stationen, und die rechte Spalte mit Metadaten, Bewertung und
 * Kommentaren war per Tastatur praktisch unerreichbar.
 *
 * Ebenso wurde früher das gerade gesprochene Wort einzeln hervorgehoben. Der
 * Dienst liefert jedoch keine Wortzeiten – sie werden innerhalb des Satzes
 * gleichmässig geschätzt (siehe `normalizeTranscript`). Die Markierung stand
 * deshalb regelmässig auf einem anderen Wort als dem gehörten und blieb in
 * Sprechpausen auf dem letzten Wort stehen. Belastbar ist die Satzgrenze,
 * darum wird der laufende Satz als Ganzes hervorgehoben und ein Klick springt
 * an dessen Anfang.
 */
const SentenceRow = memo(function SentenceRow({
  sentence,
  active,
  matchState,
  query,
  tone,
  hintId,
  onSeek,
}: RowProps) {
  const hits = useMemo(() => matchedWordIndexes(sentence.words, query), [sentence.words, query]);

  return (
    <button
      type="button"
      id={`satz-${sentence.index}`}
      aria-describedby={hintId}
      aria-current={active ? "true" : undefined}
      onClick={() => onSeek(sentence.startMs)}
      // select-text hält das Transkript kopierbar; Schaltflächen unterbinden
      // die Textauswahl sonst je nach Browser.
      className={`group flex w-full select-text gap-3 rounded-[4px] px-2 py-1.5 text-left transition-colors ${
        active ? "bg-petrol-soft" : matchState === "aktuell" ? "bg-[#fdeaa8]/60" : "hover:bg-canvas"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 font-mono text-[11px] tabular-nums group-hover:text-petrol ${
          active ? "font-semibold text-petrol" : "text-ink-faint"
        }`}
        title="An diese Stelle springen"
      >
        {timecode(sentence.startMs)}
      </span>
      <span className="flex-1 text-[13.5px] leading-relaxed">
        {sentence.newSpeaker && (
          <span className={`badge mr-2 align-baseline ${tone}`}>{sentence.speakerLabel}</span>
        )}
        {sentence.words.map((word, wordIndex) => (
          <span
            key={wordIndex}
            data-wort=""
            className={hits.has(wordIndex) ? "rounded-[2px] bg-[#fdeaa8]" : undefined}
          >
            {word.text}
            {wordIndex < sentence.words.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </button>
  );
});

export function TranscriptView({
  segments,
  currentMs,
  onSeek,
  initialQuery = "",
}: {
  segments: TranscriptSegment[];
  currentMs: number;
  onSeek: (ms: number) => void;
  initialQuery?: string;
}) {
  const sentences = useMemo(() => flattenSegments(segments), [segments]);
  const speakerTone = useMemo(() => {
    const map = new Map<string, string>();
    for (const sentence of sentences) {
      if (!map.has(sentence.speaker)) {
        map.set(sentence.speaker, SPEAKER_TONES[map.size % SPEAKER_TONES.length]);
      }
    }
    return map;
  }, [sentences]);

  const [query, setQuery] = useState(initialQuery);
  const [matchPosition, setMatchPosition] = useState(0);
  const [follow, setFollow] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return sentences.filter((sentence) => sentence.text.toLowerCase().includes(needle));
  }, [query, sentences]);

  /**
   * Anfangszeiten, streng aufsteigend gemacht.
   *
   * Beim Zusammensetzen abschnittsweise transkribierter Aufnahmen können sich
   * die Zeitbereiche zweier Abschnitte an der Nahtstelle geringfügig
   * überlappen. Eine Suche, die auf lückenlos getrennte Bereiche baut, findet
   * dann zeitweise gar keinen Satz – die Markierung sprang deshalb aus der
   * Liste. Mit monoton korrigierten Anfangszeiten gilt schlicht: laufend ist
   * der zuletzt begonnene Satz.
   */
  const starts = useMemo(() => {
    const list: number[] = [];
    let previous = -1;
    for (const sentence of sentences) {
      previous = Math.max(previous + 1, sentence.startMs);
      list.push(previous);
    }
    return list;
  }, [sentences]);

  const activeIndex = useMemo(() => {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= currentMs) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }, [currentMs, starts]);

  /**
   * Holt eine Zeile in den sichtbaren Ausschnitt – aber nur, wenn sie ihn
   * verlassen hat.
   *
   * Gemessen wird gegen den Behälter, nicht gegen die Seite: `offsetTop` zählt
   * bis zum nächsten positionierten Vorfahren, und der ist hier das Dokument.
   * Die frühere Rechnung addierte deshalb die gesamte Seitenhöhe oberhalb der
   * Karte zum Ziel und warf die Liste bei jedem Satzwechsel ans Ende – das
   * waren die unvermittelten Sprünge.
   *
   * Ausserdem wird nicht mehr bei jedem Satz nachzentriert, sondern erst, wenn
   * die laufende Zeile aus dem Ausschnitt läuft. Die Liste steht dadurch still
   * und rückt einmal je Bildschirmhöhe nach.
   */
  function revealRow(index: number, mode: "sanft" | "immer") {
    const container = containerRef.current;
    const element = document.getElementById(`satz-${index}`);
    if (!container || !element) return;

    const box = container.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    const rand = 12;
    if (mode === "sanft" && row.top >= box.top + rand && row.bottom <= box.bottom - rand) return;

    const relativeTop = row.top - box.top + container.scrollTop;
    const limit = container.scrollHeight - container.clientHeight;
    const target = Math.max(0, Math.min(limit, relativeTop - container.clientHeight / 3));
    const distance = Math.abs(target - container.scrollTop);
    if (distance < 2) return;
    // Über weite Strecken – etwa nach einem Sprung in der Suche – wäre die
    // weiche Bewegung ein langer Flug durch das halbe Transkript.
    container.scrollTo({
      top: target,
      behavior: distance > container.clientHeight * 1.5 ? "auto" : "smooth",
    });
  }

  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    // revealRow liest Behälter und Zeile beim Aufruf aus dem DOM; ausser dem
    // Satzwechsel und dem Kästchen gibt es nichts, worauf zu reagieren wäre.
    revealRow(activeIndex, "sanft");
  }, [activeIndex, follow]);

  function goToMatch(next: number) {
    if (matches.length === 0) return;
    const position = (next + matches.length) % matches.length;
    setMatchPosition(position);
    const sentence = matches[position];
    setFollow(false);
    onSeek(sentence.startMs);
    revealRow(sentence.index, "immer");
  }

  const currentMatchIndex = matches[matchPosition]?.index ?? -1;
  const matchIndexes = useMemo(() => new Set(matches.map((match) => match.index)), [matches]);

  return (
    <section className="card flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <h2 className="text-[14px] font-semibold text-ink">Transkript</h2>
        <span className="text-[12px] text-ink-faint">
          {sentences.length} Sätze · {speakerTone.size} Sprecher
        </span>
        {/* Suchfeld, Trefferzähler, Sprungtasten und „Mitlaufen“ stehen auf
            breiten Bildschirmen in einer Zeile. Auf schmalen Geräten reicht die
            Breite dafür nicht: Ohne Umbruch und ohne schrumpffähiges Suchfeld
            würde diese Zeile die Karte – und damit die ganze Detailseite –
            breiter machen als das Fenster. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchPosition(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToMatch(matchPosition + (event.shiftKey ? -1 : 1));
              }
            }}
            className="field w-56 min-w-0"
            placeholder="Im Transkript suchen …"
            aria-label="Im Transkript suchen"
          />
          <span className="min-w-[86px] text-[12px] tabular-nums text-ink-soft">
            {query.trim().length >= 2
              ? matches.length > 0
                ? `Treffer ${matchPosition + 1} von ${matches.length}`
                : "Kein Treffer"
              : ""}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={matches.length === 0}
            onClick={() => goToMatch(matchPosition - 1)}
            aria-label="Vorheriger Treffer"
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={matches.length === 0}
            onClick={() => goToMatch(matchPosition + 1)}
            aria-label="Nächster Treffer"
          >
            ↓
          </button>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
              className="accent-[#0e5567]"
            />
            Mitlaufen
          </label>
        </div>
      </div>
      <p id={hintId} className="sr-only">
        Enter spielt die Aufnahme ab dem Anfang dieses Satzes ab.
      </p>
      {/* Scrollt jemand von Hand, ist das Mitlaufen nicht mehr erwünscht: Sonst
          zöge die Wiedergabe die Liste sofort wieder zurück und die Ansicht
          ruckelte zwischen beiden Absichten hin und her. Gehorcht wird dem
          Rad und dem Finger, nicht dem Scroll-Ereignis – das löst auch die
          eigene Bewegung aus und schaltete sich damit selbst ab. */}
      <div
        ref={containerRef}
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
        className="max-h-[560px] min-h-[320px] overflow-y-auto p-2"
      >
        {sentences.map((sentence) => (
          <SentenceRow
            key={sentence.index}
            hintId={hintId}
            sentence={sentence}
            active={sentence.index === activeIndex}
            matchState={
              sentence.index === currentMatchIndex
                ? "aktuell"
                : matchIndexes.has(sentence.index)
                  ? "treffer"
                  : "keiner"
            }
            query={query.trim()}
            tone={speakerTone.get(sentence.speaker) ?? SPEAKER_TONES[0]}
            onSeek={onSeek}
          />
        ))}
      </div>
    </section>
  );
}
