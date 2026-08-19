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

type RowProps = {
  sentence: FlatSentence;
  active: boolean;
  activeWord: number;
  matchState: "keiner" | "treffer" | "aktuell";
  query: string;
  tone: string;
  hintId: string;
  onSeek: (ms: number) => void;
};

/**
 * Ein Satz ist genau eine Tabulator-Station.
 *
 * Früher war jedes Wort fokussierbar; ein zwanzigminütiges Gespräch ergab damit
 * mehrere tausend Stationen, und die rechte Spalte mit Metadaten, Bewertung und
 * Kommentaren war per Tastatur praktisch unerreichbar. Deshalb ist nur noch die
 * Satzzeile selbst fokussierbar (Enter springt an den Satzanfang), während die
 * Wörter reine Schaltflächen für die Maus bleiben und weiterhin an die
 * Wortposition springen.
 */
const SentenceRow = memo(function SentenceRow({
  sentence,
  active,
  activeWord,
  matchState,
  query,
  tone,
  hintId,
  onSeek,
}: RowProps) {
  return (
    <button
      type="button"
      id={`satz-${sentence.index}`}
      aria-describedby={hintId}
      onClick={() => onSeek(sentence.startMs)}
      // select-text hält das Transkript kopierbar; Schaltflächen unterbinden
      // die Textauswahl sonst je nach Browser.
      className={`group flex w-full select-text gap-3 rounded-[4px] px-2 py-1.5 text-left transition-colors ${
        active ? "bg-petrol-soft" : matchState === "aktuell" ? "bg-[#fdeaa8]/60" : "hover:bg-canvas"
      }`}
    >
      <span
        className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-ink-faint group-hover:text-petrol"
        title="An diese Stelle springen"
      >
        {timecode(sentence.startMs)}
      </span>
      <span className="flex-1 text-[13.5px] leading-relaxed">
        {sentence.newSpeaker && (
          <span className={`badge mr-2 align-baseline ${tone}`}>{sentence.speakerLabel}</span>
        )}
        {sentence.words.map((word, wordIndex) => {
          const isActiveWord = active && wordIndex === activeWord;
          const isMatch =
            query.length >= 2 && word.text.toLowerCase().includes(query.toLowerCase());
          return (
            <span
              key={wordIndex}
              data-wort=""
              // Der Klick auf ein Wort springt an die Wortposition und darf
              // deshalb nicht zusätzlich den Satzanfang der Zeile auslösen.
              onClick={(event) => {
                event.stopPropagation();
                onSeek(word.startMs);
              }}
              className={`cursor-pointer rounded-[2px] ${
                isActiveWord ? "bg-petrol text-white" : isMatch ? "bg-[#fdeaa8]" : "hover:bg-line"
              }`}
            >
              {word.text}
              {wordIndex < sentence.words.length - 1 ? " " : ""}
            </span>
          );
        })}
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

  const activeIndex = useMemo(() => {
    let low = 0;
    let high = sentences.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const sentence = sentences[middle];
      if (currentMs < sentence.startMs) high = middle - 1;
      else if (currentMs > sentence.endMs) low = middle + 1;
      else {
        found = middle;
        break;
      }
    }
    if (found === -1 && high >= 0 && currentMs > sentences[high]?.endMs) return high;
    return found;
  }, [currentMs, sentences]);

  const activeWord = useMemo(() => {
    if (activeIndex < 0) return -1;
    const words = sentences[activeIndex].words;
    for (let index = words.length - 1; index >= 0; index -= 1) {
      if (currentMs >= words[index].startMs) return index;
    }
    return -1;
  }, [activeIndex, currentMs, sentences]);

  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    const element = document.getElementById(`satz-${activeIndex}`);
    const container = containerRef.current;
    if (!element || !container) return;
    const elementTop = element.offsetTop;
    const target = elementTop - container.clientHeight / 2;
    if (Math.abs(container.scrollTop - target) > 40) {
      container.scrollTo({ top: target, behavior: "smooth" });
    }
  }, [activeIndex, follow]);

  function goToMatch(next: number) {
    if (matches.length === 0) return;
    const position = (next + matches.length) % matches.length;
    setMatchPosition(position);
    const sentence = matches[position];
    setFollow(false);
    const element = document.getElementById(`satz-${sentence.index}`);
    const container = containerRef.current;
    if (element && container) {
      container.scrollTo({ top: element.offsetTop - container.clientHeight / 3, behavior: "smooth" });
    }
    onSeek(sentence.startMs);
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
        Enter spielt die Aufnahme ab dem Anfang dieses Satzes ab. Ein Mausklick auf ein einzelnes
        Wort springt an die Position dieses Wortes.
      </p>
      <div ref={containerRef} className="max-h-[560px] min-h-[320px] overflow-y-auto p-2">
        {sentences.map((sentence) => (
          <SentenceRow
            key={sentence.index}
            hintId={hintId}
            sentence={sentence}
            active={sentence.index === activeIndex}
            activeWord={sentence.index === activeIndex ? activeWord : -1}
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
