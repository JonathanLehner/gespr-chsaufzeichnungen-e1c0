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
import {
  LEGACY_MODEL,
  TRANSCRIPTION_MODELS,
  addUsage,
  callerVocabulary,
  costUsd,
  estimatedCostPerMinute,
  findModel,
  normalizeVocabulary,
  resolveModel,
  usageFromMetadata,
  vocabularyPrompt,
} from "../transcriber/shared/models";
import { offsetToMs, segmentsFromWords } from "../transcriber/shared/word-timestamps";

test("nicht verfügbare Modelle fallen auf ein verfügbares zurück", () => {
  assert.equal(resolveModel("gemini-3.5-flash-lite").id, "gemini-3.5-flash-lite");
  const fallback = resolveModel("gemini-3.5-transcribe");
  assert.ok(fallback.available);
  assert.equal(resolveModel(null).id, fallback.id);
  assert.equal(resolveModel("gibt-es-nicht").id, fallback.id);
  assert.equal(resolveModel("gemini-2.5-flash-lite").available, true);
  assert.equal(findModel(LEGACY_MODEL)?.available, true);
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
  // Laut Preisliste rund $0.005 je Minute.
  assert.ok(Math.abs(estimatedCostPerMinute(findModel("gemini-3.5-transcribe")!) - 0.0053) < 0.001);
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
