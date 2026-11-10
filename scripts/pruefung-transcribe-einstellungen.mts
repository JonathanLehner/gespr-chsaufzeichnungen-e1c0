/**
 * Prüfung von zwei Einstellungen für gemini-3.5-transcribe (10.11.2026), nur lesend:
 *   A  wie im Dienst: Opus 24 kbit/s, mono 16 kHz, keine Sprachangabe
 *   B  A + language_codes ["de-DE"]
 *   C  Originaldatei unverändert (WAV/MP3), Abschnitte verlustfrei geschnitten
 *   D  B + C
 * Alle mit Sprechern und Wortzeiten, Abschnitte höchstens 5 min, in Pausen geschnitten.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/pruefung-transcribe-einstellungen.mts <ordner> <referenz.json>
 *
 * <ordner>/audio/<anruf>.bin: Kopien der Aufnahmen. <referenz.json>: gespeicherte
 * gemini-2.5-flash-Transkripte (`[{ id, call, durationMs, storedAtCompare }]`).
 * Schreibt <ordner>/results.json und protokolliert auf stdout. Keine Datenbank.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { energyEnvelope } from "../transcriber/shared/audio-envelope";
import { sliceOriginal } from "../transcriber/shared/audio-split";
import { boundsAtPauses } from "../transcriber/shared/chunk-bounds";
import { detectSpeech } from "../transcriber/shared/forced-alignment";
import { BASE_VOCABULARY, callerVocabulary, costUsd, findModel, usageFromInteraction, addUsage, EMPTY_USAGE, normalizeVocabulary, type TokenUsage } from "../transcriber/shared/models";
import type { TranscriptSegment } from "../transcriber/shared/types";
import { correctVocabulary } from "../transcriber/shared/vocabulary-correction";
import { offsetToMs, segmentsFromWords, type WordAnnotation } from "../transcriber/shared/word-timestamps";

const require = createRequire(join(import.meta.dirname, "..", "transcriber", "package.json"));
// Das SDK liegt nur im Dienst (transcriber/node_modules); hier lose typisiert.
type GenAI = {
  files: { upload(o: unknown): Promise<{ name?: string; uri?: string }>; delete(o: unknown): Promise<unknown> };
  interactions: { create(body: unknown, options?: unknown): Promise<unknown> };
};
const { GoogleGenAI } = (await import(require.resolve("@google/genai"))) as { GoogleGenAI: new (options: unknown) => GenAI };
const run = promisify(execFile);

const [dir, refFile] = process.argv.slice(2);
if (!process.env.GEMINI_API_KEY || !dir || !refFile) {
  console.error("GEMINI_API_KEY, <ordner> und <referenz.json> sind nötig.");
  process.exit(1);
}

const MAX_CHUNK_MS = 5 * 60 * 1000;
const TOKENS_PER_MINUTE = 10_000;
const MODEL = findModel("gemini-3.5-transcribe")!;
type Variant = { key: string; languageCodes: string[] | null; original: boolean };
const VARIANTS: Variant[] = [
  { key: "A", languageCodes: null, original: false },
  { key: "B", languageCodes: ["de-DE"], original: false },
  { key: "C", languageCodes: null, original: true },
  { key: "D", languageCodes: ["de-DE"], original: true },
];
const only = process.env.VARIANTS?.split(",");

type Ref = { id: string; call: string; durationMs: number; storedAtCompare: TranscriptSegment[] };
const refs = JSON.parse(readFileSync(refFile, "utf8")) as Ref[];
const outFile = join(dir, "results.json");
const results: Record<string, Record<string, unknown>> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const vocabulary = normalizeVocabulary([
  ...BASE_VOCABULARY,
  ...callerVocabulary([{ first: "Valerio", last: "Labruzzo" }, { first: "Hossain", last: "Mortazavi" }, { first: "Ivana", last: "Zivkovic" }, { first: "Oktay", last: "Arslantas" }]),
]);

/* ---------------------------------------------------------- Drossel (Stufe 1) */
const spent: { at: number; tokens: number }[] = [];
async function budget(tokens: number) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].at > 61_000) spent.shift();
    const used = spent.reduce((sum, entry) => sum + entry.tokens, 0);
    if (used + tokens <= TOKENS_PER_MINUTE * 0.95 || spent.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, spent[0].at + 61_000 - now)));
  }
  spent.push({ at: Date.now(), tokens });
}

/* ------------------------------------------------------------------- Anfrage */
async function opus(file: string, startMs: number, endMs: number): Promise<Uint8Array> {
  const { stdout } = await run("ffmpeg", [
    "-loglevel", "error", "-ss", String(startMs / 1000), "-t", String((endMs - startMs) / 1000),
    "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return new Uint8Array(stdout);
}

async function transcribe(audio: Uint8Array, mime: string, languageCodes: string[] | null, estTokens: number) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, apiVersion: "v1beta", httpOptions: { retryOptions: { attempts: 1 } } });
  for (let attempt = 1; ; attempt += 1) {
    await budget(estTokens);
    const t0 = Date.now();
    const uploaded = await ai.files.upload({ file: new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime }), config: { mimeType: mime } });
    const t1 = Date.now();
    try {
      const response = (await ai.interactions.create(
        {
          model: "gemini-3.5-transcribe",
          input: [{ type: "audio", uri: uploaded.uri, mime_type: mime }],
          generation_config: {
            transcription_config: {
              ...(languageCodes ? { language_codes: languageCodes } : {}),
              mode: { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] },
            },
          },
        },
        { retries: { strategy: "none" } },
      )) as { model?: string; usage?: Parameters<typeof usageFromInteraction>[0]; steps?: { content?: { annotations?: WordAnnotation[] }[] }[] };
      const words = (response.steps ?? []).flatMap((s) => s.content ?? []).flatMap((c) => c.annotations ?? []).filter((a) => a.type === "word_info");
      return { words, usage: usageFromInteraction(response.usage), uploadMs: t1 - t0, requestMs: Date.now() - t1, modelVersion: response.model ?? null };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    Fehler ${status ?? ""} (Anlauf ${attempt}): ${message.slice(0, 200)}`);
      if (attempt >= 4 || (status && status < 500 && status !== 429)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 62_000));
    } finally {
      if (uploaded.name) await ai.files.delete({ name: uploaded.name }).catch(() => undefined);
    }
  }
}

/* ----------------------------------------------------------------- Kennzahlen */
const norm = (text: string) =>
  text.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/ß/g, "ss").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const textOf = (segments: TranscriptSegment[]) => segments.flatMap((s) => s.sentences.map((x) => x.text)).join(" ");
const countWords = (segments: TranscriptSegment[]) => segments.reduce((n, s) => n + s.sentences.reduce((m, x) => m + x.text.split(/\s+/).filter(Boolean).length, 0), 0);

/** Wortfehlerrate und je Referenzwort, ob es getroffen wurde (Levenshtein mit Rückverfolgung). */
function wer(ref: string[], hyp: string[]) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const row = new Uint32Array(m + 1); row[0] = i; return row; });
  for (let j = 0; j <= m; j += 1) d[0][j] = j;
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  const kept = new Array<boolean>(n).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { kept[i - 1] = true; i -= 1; j -= 1; }
    else if (d[i][j] === d[i - 1][j] + 1) i -= 1;
    else j -= 1;
  }
  return { wer: n ? d[n][m] / n : 0, kept };
}

/** Sätze der Referenz, von denen mindestens 70 % fehlen (gelöscht, nicht ersetzt). */
function droppedSentences(refSegs: TranscriptSegment[], kept: boolean[]) {
  const out: { startMs: number; speaker: string; text: string }[] = [];
  let k = 0;
  for (const seg of refSegs) for (const sentence of seg.sentences) {
    const words = norm(sentence.text);
    const hit = kept.slice(k, k + words.length).filter(Boolean).length;
    k += words.length;
    if (words.length >= 3 && hit / words.length <= 0.3) out.push({ startMs: sentence.startMs, speaker: seg.speakerLabel, text: sentence.text });
  }
  return out;
}

function timing(words: { startMs: number; endMs: number }[], durationMs: number) {
  let backwards = 0, zero = 0, outside = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (i > 0 && w.startMs < words[i - 1].startMs) backwards += 1;
    if (w.endMs <= w.startMs) zero += 1;
    if (w.startMs < 0 || w.endMs > durationMs + 500) outside += 1;
  }
  return { words: words.length, backwards, zero, outside };
}

const excerpt = (segments: TranscriptSegment[], untilMs: number) =>
  segments.flatMap((s) => s.sentences.filter((x) => x.startMs < untilMs).map((x) => `${(x.startMs / 1000).toFixed(1)} s [${s.speakerLabel}] ${x.text}`)).join(" · ");

/* --------------------------------------------------------------------- Ablauf */
const work = await mkdtemp(join(tmpdir(), "pruefung-"));
try {
  for (const ref of refs) {
    const file = join(dir, "audio", `${ref.call}.bin`);
    const bytes = new Uint8Array(readFileSync(file));
    const envelope = energyEnvelope(bytes, "audio/wav");
    const bounds = boundsAtPauses(ref.durationMs, MAX_CHUNK_MS, envelope ? detectSpeech(envelope) : null);
    const refWords = norm(textOf(ref.storedAtCompare));
    const refCount = countWords(ref.storedAtCompare);
    for (const variant of VARIANTS) {
      if (only && !only.includes(variant.key)) continue;
      const key = `${ref.call}:${variant.key}`;
      if (results[key]) continue;
      const started = Date.now();
      let usage: TokenUsage = { ...EMPTY_USAGE };
      const raw: { startMs: number; endMs: number }[] = [];
      const parts: TranscriptSegment[][] = [];
      let uploadMs = 0, requestMs = 0, bytesSent = 0, modelVersion: string | null = null;
      try {
        for (const chunk of bounds) {
          let audio: Uint8Array, mime: string, offset: number;
          if (variant.original) {
            const slice = sliceOriginal(bytes, "audio/wav", chunk, bounds.length === 1);
            if (!slice) throw new Error("nicht verlustfrei schneidbar");
            ({ bytes: audio, startMs: offset } = slice);
            mime = "audio/wav";
          } else {
            audio = await opus(file, chunk.startMs, chunk.endMs);
            mime = "audio/ogg";
            offset = chunk.startMs;
          }
          bytesSent += audio.length;
          const est = Math.ceil(((chunk.endMs - chunk.startMs) / 1000) * 26);
          const answer = await transcribe(audio, mime, variant.languageCodes, est);
          usage = addUsage(usage, answer.usage);
          uploadMs += answer.uploadMs;
          requestMs += answer.requestMs;
          modelVersion = answer.modelVersion;
          for (const w of answer.words) {
            raw.push({ startMs: (offsetToMs(w.start_offset) ?? NaN) + offset, endMs: (offsetToMs(w.end_offset) ?? NaN) + offset });
          }
          const corrected = correctVocabulary(answer.words, vocabulary);
          // Sprecher je Abschnitt getrennt; wie im Dienst (mergeChunks) zählen sie je Abschnitt neu.
          parts.push(segmentsFromWords(corrected.words, offset).segments.map((s) => ({ ...s, speaker: `${parts.length}:${s.speaker}` })));
        }
      } catch (error) {
        results[key] = { call: ref.call, variant: variant.key, error: error instanceof Error ? error.message : String(error) };
        writeFileSync(outFile, JSON.stringify(results, null, 1));
        console.log(`${key}: FEHLER ${results[key].error}`);
        continue;
      }
      const segments = parts.flat();
      const hyp = norm(textOf(segments));
      const score = wer(refWords, hyp);
      const built = segments.flatMap((s) => s.sentences.flatMap((x) => x.words));
      const count = countWords(segments);
      const audioMin = ref.durationMs / 60000;
      results[key] = {
        call: ref.call, variant: variant.key, chunks: bounds.length, bytesSent, modelVersion,
        words: count, refWords: refCount, kept: count / refCount,
        wer: score.wer,
        speakers: parts.map((p) => new Set(p.map((s) => s.speaker)).size),
        timingRaw: timing(raw, ref.durationMs), timingBuilt: timing(built, ref.durationMs),
        usage, costUsd: costUsd(MODEL, usage), costPerMin: costUsd(MODEL, usage) / audioMin,
        uploadMs, requestMs, totalMs: Date.now() - started,
        firstMinute: excerpt(segments, 60_000),
        dropped: droppedSentences(ref.storedAtCompare, score.kept),
        segments,
      };
      writeFileSync(outFile, JSON.stringify(results, null, 1));
      console.log(`${key}: ${count}/${refCount} Wörter (${Math.round((count / refCount) * 100)} %), WER ${score.wer.toFixed(2)}, Sprecher ${results[key].speakers}, ` +
        `Tokens ${usage.audioInput}/${usage.output}, $${(costUsd(MODEL, usage) / audioMin).toFixed(4)}/min, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
  console.log("FERTIG");
} finally {
  await rm(work, { recursive: true, force: true });
}
