/**
 * Modellvergleich Transkription (10.11.2026), nur lesend, einzeln je Modell (ein Durchgang).
 *
 * Prompt-Weg wie im Dienst: derselbe Prompt (`PROMPT`/`chunkPrompt` + Vokabular), dasselbe
 * `responseSchema`, temperature 0, 60-s-Abschnitte. Abweichend vom Dienst: Originalaudio
 * (WAV-PCM, verlustfrei geschnitten) statt Opus, und direkt über `GEMINI_API_KEY`.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/vergleich-modelle.mts <ordner> <referenz.json> <vokabular.json>
 *
 * <ordner>/audio/<anruf>.bin: Kopien der Aufnahmen (WAV). <referenz.json>: gespeicherte
 * gemini-2.5-flash-Transkripte (`[{ id, call, durationMs, storedAtCompare }]`).
 * <vokabular.json>: Liste der Begriffe wie im Dienst (BASE_VOCABULARY + Anrufernamen).
 * Schreibt <ordner>/results.json (fortsetzbar: fertige Läufe werden übersprungen).
 * Keine Datenbank. VARIANTS=L,AL,... wählt Varianten, CALLS=10980,... Anrufe.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fixedBounds } from "../transcriber/shared/chunk-bounds";
import { sliceOriginal } from "../transcriber/shared/audio-split";
import { energyEnvelope } from "../transcriber/shared/audio-envelope";
import { alignToEnvelope, detectSpeech } from "../transcriber/shared/forced-alignment";
import { addUsage, EMPTY_USAGE, usageFromMetadata, vocabularyPrompt, type TokenUsage } from "../transcriber/shared/models";
import {
  chunkPrompt, mergeChunks, normalizeTranscript, parseJsonLoosely, PROMPT, shiftSegments,
  TRANSCRIPT_RESPONSE_SCHEMA, type NormalizedTranscript, type RawTranscript,
} from "../transcriber/shared/transcript";
import type { TranscriptSegment } from "../transcriber/shared/types";

const require = createRequire(join(import.meta.dirname, "..", "transcriber", "package.json"));
// Das SDK liegt nur im Dienst (transcriber/node_modules); hier lose typisiert.
type GenAI = { models: { generateContent(o: unknown): Promise<{ text?: string; usageMetadata?: Parameters<typeof usageFromMetadata>[0]; modelVersion?: string }> } };
const { GoogleGenAI } = (await import(require.resolve("@google/genai"))) as { GoogleGenAI: new (options: unknown) => GenAI };

const [dir, refFile, vocabFile] = process.argv.slice(2);
if (!process.env.GEMINI_API_KEY || !dir || !refFile || !vocabFile) {
  console.error("GEMINI_API_KEY, <ordner>, <referenz.json> und <vokabular.json> sind nötig.");
  process.exit(1);
}

const CHUNK_MS = 60_000; // wie im Dienst (Prompt-Weg)
const PROD_TIMEOUT_MS = 120_000; // Zeitgrenze im Dienst; hier nur gezählt
const TIMEOUT_MS = 300_000; // harte Grenze dieses Tests
const ATTEMPTS = 3; // wie CHUNK_ATTEMPTS im Dienst
const CONCURRENCY = 2; // wie CHUNK_CONCURRENCY im Dienst

/** USD je 1 Mio. Tokens, Eingabe (Audio und Text gleich) / Ausgabe inkl. Denken. */
type Price = { input: number; output: number; label: string };
type Variant = { key: string; model: string; thinking: Record<string, unknown> | null; label: string; prices: Price[] };
const ARGON_CARBON: Price[] = [
  { input: 2, output: 10, label: "bis 30.11.2026" },
  { input: 4, output: 20, label: "ab 1.12.2026" },
];
const FLASH_38: Price[] = [
  { input: 0.75, output: 3.75, label: "bis 31.12.2026" },
  { input: 1.5, output: 7.5, label: "ab 1.1.2027" },
];
export const VARIANTS: Variant[] = [
  { key: "L", model: "gemini-3.5-flash-lite", thinking: { thinkingLevel: "minimal" }, label: "gemini-3.5-flash-lite, Denken minimal", prices: [{ input: 0.3, output: 2.5, label: "aktuell" }] },
  { key: "AL", model: "gemini-4-argon", thinking: { thinkingLevel: "low" }, label: "gemini-4-argon, Denken low", prices: ARGON_CARBON },
  { key: "AD", model: "gemini-4-argon", thinking: null, label: "gemini-4-argon, Denken Standard", prices: ARGON_CARBON },
  { key: "CL", model: "gemini-4-carbon", thinking: { thinkingLevel: "low" }, label: "gemini-4-carbon, Denken low", prices: ARGON_CARBON },
  { key: "CD", model: "gemini-4-carbon", thinking: null, label: "gemini-4-carbon, Denken Standard", prices: ARGON_CARBON },
  { key: "FL", model: "gemini-3.8-flash", thinking: { thinkingLevel: "low" }, label: "gemini-3.8-flash, Denken low", prices: FLASH_38 },
  { key: "FD", model: "gemini-3.8-flash", thinking: null, label: "gemini-3.8-flash, Denken Standard", prices: FLASH_38 },
];
const onlyVariants = process.env.VARIANTS?.split(",");
const onlyCalls = process.env.CALLS?.split(",");

type Ref = { id: string; call: string; durationMs: number; storedAtCompare: TranscriptSegment[] };
const refs = (JSON.parse(readFileSync(refFile, "utf8")) as Ref[]).filter((r) => !onlyCalls || onlyCalls.includes(r.call));
const vocabularyText = vocabularyPrompt(JSON.parse(readFileSync(vocabFile, "utf8")) as string[]);
const outFile = join(dir, "results.json");
const results: Record<string, Record<string, unknown>> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const save = () => writeFileSync(outFile, JSON.stringify(results, null, 1));

/* ------------------------------------------------------------------- Anfrage */
type Event = { chunk: number; attempt: number; kind: "invalid-json" | "timeout" | "error"; status?: number; message: string; ms: number };
type ChunkOut = {
  transcript: NormalizedTranscript | null;
  raw: RawTranscript | null;
  usage: TokenUsage;
  modelVersion: string | null;
  requestMs: number[];
  events: Event[];
};

async function requestChunk(variant: Variant, prompt: string, audio: Uint8Array, chunk: number): Promise<ChunkOut> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  const out: ChunkOut = { transcript: null, raw: null, usage: { ...EMPTY_USAGE }, modelVersion: null, requestMs: [], events: [] };
  const data = Buffer.from(audio).toString("base64");
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const t0 = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: variant.model,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data } }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          temperature: 0,
          ...(variant.thinking ? { thinkingConfig: variant.thinking } : {}),
          abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        },
      });
      const ms = Date.now() - t0;
      out.requestMs.push(ms);
      out.usage = addUsage(out.usage, usageFromMetadata(response.usageMetadata));
      out.modelVersion = response.modelVersion ?? null;
      try {
        out.raw = parseJsonLoosely(response.text ?? "");
        out.transcript = normalizeTranscript(out.raw);
        return out;
      } catch (error) {
        out.events.push({ chunk, attempt, kind: "invalid-json", message: String(error).slice(0, 200), ms });
      }
    } catch (error) {
      const ms = Date.now() - t0;
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /abort|timeout|timed out/i.test(message) || (error as Error).name === "TimeoutError";
      out.events.push({ chunk, attempt, kind: timeout ? "timeout" : "error", status, message: message.slice(0, 300), ms });
      console.log(`    ${variant.key} Abschnitt ${chunk + 1} Anlauf ${attempt}: ${timeout ? "Zeitüberschreitung" : `Fehler ${status ?? ""}`} ${message.slice(0, 160)}`);
      // Drosselung: warten und nicht als Anlauf zählen (höchstens 6-mal).
      if (status === 429 && out.events.filter((e) => e.status === 429).length <= 6) {
        attempt -= 1;
        await new Promise((resolve) => setTimeout(resolve, 62_000));
        continue;
      }
      if (status && status < 500 && status !== 429 && status !== 408) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return out;
}

/* ----------------------------------------------------------------- Kennzahlen */
const norm = (text: string) =>
  text.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/ß/g, "ss").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const textOf = (segments: TranscriptSegment[]) => segments.flatMap((s) => s.sentences.map((x) => x.text)).join(" ");
const countWords = (segments: TranscriptSegment[]) => segments.reduce((n, s) => n + s.sentences.reduce((m, x) => m + x.text.split(/\s+/).filter(Boolean).length, 0), 0);

function wer(ref: string[], hyp: string[]) {
  const n = ref.length, m = hyp.length;
  if (n === 0) return m ? 1 : 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const row = [i];
    for (let j = 1; j <= m; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[m] / n;
}

/** Namen und Begriffe: richtige Schreibweise und Varianten. */
function terms(text: string) {
  const find = (re: RegExp) => [...text.matchAll(re)].map((m) => m[0]);
  const immo = find(/\b(?:immo[\s-]?tr[ua]st|imotr[ua]s\w*|imm?o\s?tras\w*)(?:\s?AG)?\b/gi);
  const labr = find(/\b(?:la[\s-]?br[uo][sz]+[oi]\w*|schlabru\w*|labrut\w*)\b/gi);
  const streets = find(/\b[\p{Lu}][\p{L}-]*(?:strasse|straße|gasse|weg|platz|rain|halde|ring|allee)\b/gu);
  return {
    immotrust: { correct: immo.filter((x) => /^Immotrust(\sAG)?$/.test(x)).length, variants: [...new Set(immo.filter((x) => !/^Immotrust(\sAG)?$/.test(x)))] },
    labruzzo: { correct: labr.filter((x) => x === "Labruzzo").length, variants: [...new Set(labr.filter((x) => x !== "Labruzzo"))] },
    streets: [...new Set(streets)],
  };
}

/**
 * Satzzeiten des Modells vor dem Forced Alignment (Rohwerte aus dem JSON, auf die
 * Gesprächszeit verschoben): ausserhalb des Abschnitts, rückwärts/überlappend, Abstand zur
 * Ausrichtung und Anteil der Satzanfänge in erkannter Sprache.
 */
function timingQuality(rawSentences: { startMs: number; endMs: number; chunkStart: number; chunkEnd: number }[], aligned: TranscriptSegment[] | null, speech: { startMs: number; endMs: number }[]) {
  let outside = 0, backwards = 0, invalid = 0, inSpeech = 0;
  for (let i = 0; i < rawSentences.length; i += 1) {
    const s = rawSentences[i];
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.endMs <= s.startMs) invalid += 1;
    if (s.startMs < s.chunkStart - 500 || s.endMs > s.chunkEnd + 1000) outside += 1;
    if (i > 0 && s.startMs < rawSentences[i - 1].endMs - 100 && s.chunkStart === rawSentences[i - 1].chunkStart) backwards += 1;
    if (speech.some((r) => s.startMs >= r.startMs - 300 && s.startMs <= r.endMs + 300)) inSpeech += 1;
  }
  const alignedStarts = aligned ? aligned.flatMap((seg) => seg.sentences.map((x) => x.startMs)) : [];
  const deltas = alignedStarts.length === rawSentences.length ? rawSentences.map((s, i) => Math.abs(s.startMs - alignedStarts[i])).sort((a, b) => a - b) : [];
  const q = (p: number) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))] : null);
  return { sentences: rawSentences.length, outside, backwards, invalid, inSpeech, deltaToAlignmentMs: { median: q(0.5), p90: q(0.9) } };
}

const excerpt = (segments: TranscriptSegment[], fromMs: number, untilMs: number) =>
  segments.flatMap((s) => s.sentences.filter((x) => x.startMs >= fromMs && x.startMs < untilMs).map((x) => `${(x.startMs / 1000).toFixed(1)} s [${s.speakerLabel}] ${x.text}`)).join(" · ");

/* --------------------------------------------------------------------- Ablauf */
async function runOne(ref: Ref, variant: Variant) {
  const key = `${ref.call}:${variant.key}`;
  if (results[key] && !results[key].error) return;
  const bytes = new Uint8Array(readFileSync(join(dir, "audio", `${ref.call}.bin`)));
  const bounds = fixedBounds(ref.durationMs, CHUNK_MS);
  const started = Date.now();
  const outs: (ChunkOut & { startMs: number; endMs: number })[] = new Array(bounds.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, bounds.length) }, async () => {
    while (next < bounds.length) {
      const index = next++;
      const slice = sliceOriginal(bytes, "audio/wav", bounds[index], bounds.length === 1);
      if (!slice) throw new Error("nicht verlustfrei schneidbar");
      const prompt = (bounds.length === 1 ? PROMPT : chunkPrompt(index, bounds.length)) + vocabularyText;
      const out = await requestChunk(variant, prompt, slice.bytes, index);
      outs[index] = { ...out, startMs: slice.startMs, endMs: bounds[index].endMs };
    }
  }));
  const totalMs = Date.now() - started;

  const usage = outs.reduce((u, o) => addUsage(u, o.usage), { ...EMPTY_USAGE } as TokenUsage);
  const done = outs.filter((o) => o.transcript).map((o) => ({ ...o.transcript!, segments: shiftSegments(o.transcript!.segments, o.startMs) }));
  const gaps = outs.filter((o) => !o.transcript).map((o) => ({ startMs: o.startMs, endMs: o.endMs }));
  const merged = mergeChunks(done);
  const rawSentences = outs.flatMap((o) => (o.raw?.segments ?? []).flatMap((seg) => (seg.sentences ?? []).filter((x) => (x.text ?? "").trim()).map((x) => ({
    startMs: Number(x.startMs) + o.startMs, endMs: Number(x.endMs) + o.startMs, chunkStart: o.startMs, chunkEnd: o.endMs,
  }))));
  // Normalisierte Reihenfolge = Rohreihenfolge je Abschnitt; nach dem Zusammensetzen nach Zeit sortiert.
  const envelope = energyEnvelope(bytes, "audio/wav");
  const speech = envelope ? detectSpeech(envelope) : [];
  const perChunkAligned = done.length ? done.map((d) => d.segments).flat() : [];
  const aligned = envelope && perChunkAligned.length ? alignToEnvelope(perChunkAligned, envelope, { gaps })?.segments ?? null : null;

  const segments = merged.segments;
  const count = countWords(segments);
  const refCount = countWords(ref.storedAtCompare);
  const audioMin = ref.durationMs / 60000;
  const cost = (p: Price) => (((usage.audioInput + usage.textInput) * p.input + (usage.output + usage.thinking) * p.output) / 1e6);
  const events = outs.flatMap((o) => o.events);
  const requestMs = outs.flatMap((o) => o.requestMs);
  results[key] = {
    call: ref.call, variant: variant.key, model: variant.model, modelVersion: outs.find((o) => o.modelVersion)?.modelVersion ?? null,
    chunks: bounds.length, failedChunks: gaps.length,
    words: count, refWords: refCount, kept: count / refCount, wer: wer(norm(textOf(ref.storedAtCompare)), norm(textOf(segments))),
    speakers: merged.speakerLabels,
    terms: terms(textOf(segments)), refTerms: terms(textOf(ref.storedAtCompare)),
    timing: timingQuality(rawSentences, aligned, speech),
    events: { invalidJson: events.filter((e) => e.kind === "invalid-json").length, timeouts: events.filter((e) => e.kind === "timeout").length, errors: events.filter((e) => e.kind === "error").length, overProdTimeout: requestMs.filter((ms) => ms > PROD_TIMEOUT_MS).length, list: events },
    usage, costs: variant.prices.map((p) => ({ label: p.label, usd: cost(p), perMin: cost(p) / audioMin })),
    totalMs, perMinMs: totalMs / audioMin, requestMs,
    firstMinute: excerpt(segments, 0, 60_000),
    segments,
  };
  save();
  console.log(`${key}: ${count}/${refCount} Wörter (${Math.round((count / refCount) * 100)} %), Sprecher ${merged.speakerLabels.join("|")}, ` +
    `Tokens ${usage.audioInput}+${usage.textInput}/${usage.output}/${usage.thinking}, $${cost(variant.prices[0]).toFixed(4)}, ${Math.round(totalMs / 1000)} s, ` +
    `Ereignisse ${events.length}, Lücken ${gaps.length}`);
}

// Varianten laufen parallel (eigene Grenzen je Modell), Anrufe je Variante nacheinander.
await Promise.all(VARIANTS.filter((v) => !onlyVariants || onlyVariants.includes(v.key)).map(async (variant) => {
  for (const ref of refs) {
    try {
      await runOne(ref, variant);
    } catch (error) {
      results[`${ref.call}:${variant.key}`] = { call: ref.call, variant: variant.key, error: String(error) };
      save();
      console.log(`${ref.call}:${variant.key}: FEHLER ${String(error).slice(0, 200)}`);
    }
  }
}));
console.log("FERTIG");
