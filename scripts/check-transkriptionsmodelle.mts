/**
 * Reine Prüfungen zu Modellauswahl, Kosten, Vokabular, Wortzeiten von
 * gemini-3.5-transcribe und zur Reihenfolge nachrangiger Neu-Transkriptionen
 * (ohne Datenbank, ohne Anfragen).
 *
 *   npx tsx --test scripts/check-transkriptionsmodelle.mts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimJob } from "../transcriber/claim";
import { parseWavLayout, sliceOriginal } from "../transcriber/shared/audio-split";
import { boundsAtPauses, fixedBounds } from "../transcriber/shared/chunk-bounds";
import { isSpendingLimitError } from "../transcriber/shared/queue";
import { correctVocabulary, foldForMatch } from "../transcriber/shared/vocabulary-correction";
import {
  DEFAULT_MODEL,
  LEGACY_MODEL,
  TRANSCRIPTION_MODELS,
  addUsage,
  availabilityNote,
  callerVocabulary,
  costUsd,
  estimatedCostPerMinute,
  findModel,
  isAvailable,
  normalizeVocabulary,
  resolveModel,
  usageFromInteraction,
  usageFromMetadata,
  vocabularyPrompt,
} from "../transcriber/shared/models";
import { offsetToMs, segmentsFromWords } from "../transcriber/shared/word-timestamps";

test("Standard ist gemini-3.5-flash-lite; gemini-2.5-flash ist abgelöst und fällt darauf zurück", () => {
  assert.equal(DEFAULT_MODEL, "gemini-3.5-flash-lite");
  assert.equal(resolveModel(null).id, "gemini-3.5-flash-lite");
  assert.equal(resolveModel("gibt-es-nicht").id, "gemini-3.5-flash-lite");
  assert.equal(findModel(LEGACY_MODEL)?.available, false);
  assert.equal(resolveModel(LEGACY_MODEL, true).id, "gemini-3.5-flash-lite");
  assert.equal(resolveModel("gemini-2.5-flash-lite", true).id, "gemini-3.5-flash-lite");
});

test("gemini-3.5-transcribe nur mit eigenem Schlüssel", () => {
  const transcribe = findModel("gemini-3.5-transcribe")!;
  assert.equal(transcribe.route, "direkt");
  assert.equal(isAvailable(transcribe, false), false);
  assert.equal(isAvailable(transcribe, true), true);
  assert.equal(resolveModel("gemini-3.5-transcribe", false).id, "gemini-3.5-flash-lite");
  assert.equal(resolveModel("gemini-3.5-transcribe", true).id, "gemini-3.5-transcribe");
  assert.match(availabilityNote(transcribe, false) ?? "", /nicht eingerichtet/);
  assert.equal(isAvailable(findModel("gemini-3.5-flash-lite")!, false), true);
});

test("usage der Interactions-API: Audio, Text, Ausgabe", () => {
  const usage = usageFromInteraction({
    total_input_tokens: 2318,
    total_output_tokens: 61,
    total_thought_tokens: 0,
    input_tokens_by_modality: [{ modality: "text", tokens: 1 }, { modality: "audio", tokens: 2317 }],
  });
  assert.deepEqual(usage, { audioInput: 2317, textInput: 1, output: 61, thinking: 0, requests: 1 });
  assert.equal(usageFromInteraction(undefined).requests, 1);
});

test("Kostenlimit: Plattform und Google direkt sperren, Minutengrenze nicht", () => {
  assert.ok(isSpendingLimitError("Gemini error: You have exceeded your monthly spending limit"));
  assert.ok(isSpendingLimitError("429 You exceeded your current quota, please check your plan and billing details."));
  assert.ok(isSpendingLimitError("Your project has exceeded its monthly spending cap."));
  assert.ok(isSpendingLimitError("Your prepayment credits are depleted."));
  assert.ok(!isSpendingLimitError("429 Rate limit exceeded for model gemini-3.5-transcribe (limit: 10000 input tokens per minute on Tier 1)."));
  assert.ok(!isSpendingLimitError("503 The model is overloaded."));
});

test("Abschnitte: feste Minute; gemini-3.5-transcribe schneidet in der längsten Pause", () => {
  assert.deepEqual(fixedBounds(150_000, 60_000), [
    { startMs: 0, endMs: 60_000 },
    { startMs: 60_000, endMs: 120_000 },
    { startMs: 120_000, endMs: 150_000 },
  ]);
  assert.deepEqual(boundsAtPauses(200_000, 300_000, null), [{ startMs: 0, endMs: 200_000 }]);
  const speech = [
    { startMs: 0, endMs: 230_000 },
    { startMs: 231_000, endMs: 260_000 },
    { startMs: 264_000, endMs: 400_000 },
    { startMs: 401_000, endMs: 700_000 },
  ];
  const bounds = boundsAtPauses(700_000, 300_000, speech);
  assert.equal(bounds[0].endMs, 262_000);
  assert.equal(bounds[bounds.length - 1].endMs, 700_000);
  for (let index = 0; index < bounds.length; index += 1) {
    assert.ok(bounds[index].endMs - bounds[index].startMs <= 300_000);
    if (index > 0) assert.equal(bounds[index].startMs, bounds[index - 1].endMs);
  }
  // Ohne Pause: harter Schnitt an der Grenze.
  assert.deepEqual(boundsAtPauses(400_000, 300_000, []).map((entry) => entry.endMs), [300_000, 400_000]);
});

test("Vokabular-Nachkorrektur: Namen angeglichen, Zeiten unverändert, gewöhnliche Wörter bleiben", () => {
  const words = [
    { type: "word_info", text: "La", speaker: "spk:0", start_offset: "1.000s", end_offset: "1.200s" },
    { type: "word_info", text: "Brusso", speaker: "spk:0", start_offset: "1.200s", end_offset: "1.700s" },
    { type: "word_info", text: "von", speaker: "spk:0", start_offset: "1.700s", end_offset: "1.900s" },
    { type: "word_info", text: "ImmoTrust.", speaker: "spk:0", start_offset: "1.900s", end_offset: "2.500s" },
    { type: "word_info", text: "Grundbuchs", speaker: "spk:1", start_offset: "3.000s", end_offset: "3.500s" },
    { type: "word_info", text: "Hauptstraße,", speaker: "spk:1", start_offset: "3.500s", end_offset: "4.000s" },
    { type: "word_info", text: "Basen", speaker: "spk:1", start_offset: "4.000s", end_offset: "4.400s" },
  ];
  const { words: out, corrections } = correctVocabulary(words, ["Immotrust AG", "Valerio Labruzzo", "Grundbuch", "Hauptstrasse", "Basel"]);
  assert.deepEqual(out.map((word) => word.text), ["Labruzzo", "von", "Immotrust.", "Grundbuchs", "Hauptstrasse,", "Basen"]);
  assert.equal(corrections, 3);
  assert.equal(out[0].start_offset, "1.000s");
  assert.equal(out[0].end_offset, "1.700s");
  assert.equal(out[2].start_offset, "1.900s");
  assert.equal(foldForMatch("Labruzzo"), foldForMatch("La Brusso"));
});

test("Flash-Modelle denken nicht oder nur minimal", () => {
  for (const model of TRANSCRIPTION_MODELS.filter((entry) => entry.path === "prompt")) {
    const thinking = model.generationConfig.thinkingConfig as Record<string, unknown> | undefined;
    assert.ok(thinking, model.id);
    assert.ok(thinking.thinkingBudget === 0 || thinking.thinkingLevel === "minimal", model.id);
  }
});

test("usageMetadata trennt Audio, Text, Ausgabe und Denken; Kosten zählen Denken als Ausgabe", () => {
  const usage = usageFromMetadata({
    promptTokenCount: 1945,
    candidatesTokenCount: 177,
    thoughtsTokenCount: 44,
    promptTokensDetails: [
      { modality: "TEXT", tokenCount: 24 },
      { modality: "AUDIO", tokenCount: 1921 },
    ],
  });
  assert.deepEqual(usage, { audioInput: 1921, textInput: 24, output: 177, thinking: 44, requests: 1 });
  const flash = findModel("gemini-2.5-flash")!;
  const expected = (1921 * 1.0 + 24 * 0.3 + (177 + 44) * 2.5) / 1e6;
  assert.ok(Math.abs(costUsd(flash, usage) - expected) < 1e-12);
  assert.deepEqual(addUsage(usage, usage).requests, 2);
  assert.equal(usageFromMetadata(undefined).requests, 1);
});

test("geschätzte Kosten je Minute liegen im erwarteten Bereich", () => {
  for (const model of TRANSCRIPTION_MODELS) {
    const perMinute = estimatedCostPerMinute(model);
    assert.ok(perMinute > 0.0005 && perMinute < 0.02, `${model.id}: ${perMinute}`);
  }
  // Gemessen am 10.11.2026: rund $0.0045 je Minute.
  assert.ok(Math.abs(estimatedCostPerMinute(findModel("gemini-3.5-transcribe")!) - 0.0048) < 0.001);
});

test("Vokabular: bereinigt, ohne Doppelte, Anrufer ohne Kürzel", () => {
  assert.deepEqual(normalizeVocabulary(["  Immotrust ", "immotrust", "", "Immotrust AG"]), ["Immotrust", "Immotrust AG"]);
  assert.deepEqual(callerVocabulary([{ first: "Valerio", last: "Labruzzo (IT)" }, { first: "", last: "" }]), [
    "Valerio Labruzzo",
  ]);
  assert.equal(vocabularyPrompt([]), "");
  assert.match(vocabularyPrompt(["Immotrust"]), /keine Liste der Sprecher/);
});

test("Wortzeiten: Sätze aus Satzzeichen, Abschnitte aus Sprecherwechseln, Versatz je Abschnitt", () => {
  const result = segmentsFromWords(
    [
      { type: "word_info", text: "Grüezi,", speaker: "spk_1", start_offset: "0.100s", end_offset: "0.400s" },
      { type: "word_info", text: "Immotrust.", speaker: "spk_1", start_offset: "0.500s", end_offset: "1.000s" },
      { type: "word_info", text: "Wie", speaker: "spk_1", start_offset: "1.200s", end_offset: "1.300s" },
      { type: "word_info", text: "geht's?", speaker: "spk_1", start_offset: "1.300s", end_offset: "1.700s" },
      { type: "word_info", text: "Gut", speaker: "spk_2", start_offset: "2.000s", end_offset: "2.300s" },
      { type: "word_info", text: "danke", speaker: "spk_2", start_offset: 2.3, end_offset: 2.6 },
    ],
    60_000,
  );
  assert.equal(result.wordCount, 6);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.speakerLabels, ["Sprecher 1", "Sprecher 2"]);
  const [first, second] = result.segments;
  assert.deepEqual(first.sentences.map((sentence) => sentence.text), ["Grüezi, Immotrust.", "Wie geht's?"]);
  assert.equal(first.sentences[0].words[0].startMs, 60_100);
  assert.equal(first.endMs, 61_700);
  assert.equal(second.speaker, "S2");
  assert.deepEqual(second.sentences[0].words.map((word) => word.startMs), [62_000, 62_300]);
  assert.equal(offsetToMs("1.25s"), 1250);
  assert.equal(offsetToMs("x"), null);
});

test("Übernahme: nachrangige Aufträge erst, wenn kein anderer fällig ist, und nie auf dem reservierten Platz", async () => {
  const calls: Record<string, unknown>[] = [];
  const queue = (answers: (string | null)[]) => ({
    async findOneAndUpdate(filter: Record<string, unknown>) {
      calls.push(filter);
      return answers.shift() ?? null;
    },
  });
  const background = (filter: Record<string, unknown>) =>
    JSON.stringify(filter).includes('"background":true');

  calls.length = 0;
  assert.equal(await claimJob(queue([null, "neu"]), { lockId: "l", workerId: "w", newestFirst: true }), "neu");
  assert.equal(calls.length, 2);
  assert.ok(JSON.stringify(calls[1]).includes('"background":{"$ne":true}'));

  calls.length = 0;
  assert.equal(
    await claimJob(queue([null, null, "alt"]), { lockId: "l", workerId: "w", newestFirst: true, allowBackground: true }),
    "alt",
  );
  assert.ok(background(calls[2]));

  calls.length = 0;
  assert.equal(
    await claimJob(queue([null, null, "alt"]), { lockId: "l", workerId: "w", newestFirst: true, allowBackground: false }),
    null,
  );
  assert.equal(calls.length, 2);
});

test("Originalaudio: WAV-Ausschnitt verlustfrei, ganze Datei unverändert", () => {
  // 8 kHz, 16 bit, mono, 10 s: Bytes zählen hoch, damit der Ausschnitt prüfbar ist.
  const rate = 8000, data = rate * 2 * 10;
  const wav = new Uint8Array(44 + data);
  const view = new DataView(wav.buffer);
  const put = (at: number, text: string) => [...text].forEach((c, i) => (wav[at + i] = c.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, "data"); view.setUint32(40, data, true);
  for (let i = 0; i < data; i += 1) wav[44 + i] = i % 251;
  assert.equal(sliceOriginal(wav, "audio/wav", { startMs: 0, endMs: 10_000 }, true)?.bytes, wav);
  const part = sliceOriginal(wav, "audio/wav", { startMs: 2500, endMs: 7000 }, false)!;
  assert.equal(part.startMs, 2500);
  const layout = parseWavLayout(part.bytes)!;
  assert.equal(layout.sampleRate, rate);
  assert.equal(layout.durationMs, 4500);
  assert.deepEqual(part.bytes.subarray(44, 54), wav.subarray(44 + 40_000, 44 + 40_010));
});
