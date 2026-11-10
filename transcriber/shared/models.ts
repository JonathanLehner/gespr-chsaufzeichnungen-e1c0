/**
 * Transkriptionsmodelle, Preise und Kostenrechnung. Gemeinsam genutzt von der
 * Anwendung (Admin-Dashboard, Metadaten) und dem Transkriptionsdienst
 * (`transcriber/`). Reine Daten und Funktionen, ohne Laufzeitabhängigkeiten.
 *
 * Preise: https://ai.google.dev/gemini-api/docs/pricing (Stand 2026-11, USD je
 * 1 Mio. Tokens, Standard-Stufe).
 */

export type TranscriptionModelId =
  | "gemini-4-argon"
  | "gemini-3.8-flash"
  | "gemini-3.5-transcribe"
  | "gemini-3.5-flash-lite"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-flash";

/** Herkunft der Wortzeiten eines Transkripts. */
export type TimingMethod = "modell" | "schaetzung";

export const TIMING_LABELS: Record<TimingMethod, string> = {
  modell: "Modell-Wortzeiten",
  schaetzung: "Schätzung (Forced Alignment)",
};

export type TranscriptionModel = {
  id: TranscriptionModelId;
  /** `transkription`: Sprach-zu-Text-Modell mit eigenen Wortzeiten; `prompt`: Sprachmodell mit Prompt. */
  path: "transkription" | "prompt";
  timing: TimingMethod;
  /** USD je 1 Mio. Tokens. */
  price: { audioInput: number; textInput: number; output: number };
  /**
   * Gemessene Tokens je Audiominute (60-s-Abschnitte, siehe Vergleich vom
   * 2026-11-10): Audio-Eingabe, Text-Eingabe (Prompt und Vokabular) und Ausgabe.
   */
  perMinute: { audioInput: number; textInput: number; output: number };
  /** Zusatz für `generationConfig`: Denken aus oder auf das Minimum (wird als Ausgabe berechnet). */
  generationConfig: Record<string, unknown>;
  /** Kann derzeit genutzt werden (bei `direct` nur mit `GEMINI_API_KEY`, siehe `isAvailable`). */
  available: boolean;
  /**
   * `direkt`: Googles Gemini API mit eigenem Schlüssel (`GEMINI_API_KEY`);
   * `plattform`: ClawCorp-Endpunkt `/gemini`. Ob Prompt oder Transcribe-API,
   * bestimmt `path`.
   */
  route: "direkt" | "plattform";
  /** Kurzer Hinweis im Dashboard, wenn nicht verfügbar oder bald umgeleitet. */
  note: string | null;
};

export const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] = [
  {
    id: "gemini-4-argon",
    path: "prompt",
    timing: "schaetzung",
    // Bis 30.11.2026; ab 1.12.2026 $4 / $20.
    price: { audioInput: 2.0, textInput: 2.0, output: 10.0 },
    // Gemessen am 10.11.2026 (11 Gespräche, 60-s-Abschnitte); argon denkt hier nicht.
    perMinute: { audioInput: 1800, textInput: 1900, output: 950 },
    generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    available: true,
    route: "direkt",
    note: "Bestes Schweizerdeutsch im Vergleich vom 10.11.2026. Preis verdoppelt sich ab 1.12.2026.",
  },
  {
    id: "gemini-3.8-flash",
    path: "prompt",
    timing: "schaetzung",
    // Bis 31.12.2026; ab 1.1.2027 $1.50 / $7.50.
    price: { audioInput: 0.75, textInput: 0.75, output: 3.75 },
    // Ausgabe inkl. rund 230 Denk-Tokens je Minute (Denkstufe low).
    perMinute: { audioInput: 1500, textInput: 1100, output: 1140 },
    generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    available: true,
    route: "direkt",
    note: "Günstiger; wechselte im Test vom 10.11.2026 gelegentlich ins Hochdeutsche und vergab Namen uneinheitlich.",
  },
  {
    id: "gemini-3.5-transcribe",
    path: "transkription",
    timing: "modell",
    price: { audioInput: 2.0, textInput: 2.0, output: 12.0 },
    // Gemessen am 10.11.2026 (11 Gespräche, ganze Datei, Wortzeiten + Sprecher).
    perMinute: { audioInput: 1500, textInput: 0, output: 150 },
    generationConfig: {},
    // Files API und Interactions-API (`transcription_config`) direkt bei Google;
    // der Plattform-Endpunkt leitet nur `generateContent` weiter.
    available: true,
    route: "direkt",
    note: "Liess im Test vom 10.11.2026 rund 40 % der Wörter aus, vor allem schweizerdeutsche Passagen.",
  },
  {
    id: "gemini-3.5-flash-lite",
    path: "prompt",
    timing: "schaetzung",
    price: { audioInput: 0.3, textInput: 0.3, output: 2.5 },
    perMinute: { audioInput: 1500, textInput: 1330, output: 870 },
    generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    available: true,
    route: "plattform",
    note: null,
  },
  {
    id: "gemini-2.5-flash-lite",
    path: "prompt",
    timing: "schaetzung",
    price: { audioInput: 0.3, textInput: 0.1, output: 0.4 },
    perMinute: { audioInput: 1920, textInput: 1180, output: 1400 },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    available: false,
    route: "plattform",
    note: "Nicht verfügbar: Google nimmt für dieses Konto keine Anfragen mehr an.",
  },
  {
    id: "gemini-2.5-flash",
    path: "prompt",
    timing: "schaetzung",
    price: { audioInput: 1.0, textInput: 0.3, output: 2.5 },
    perMinute: { audioInput: 1920, textInput: 1180, output: 1400 },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    // Abgelöst am 10.11.2026; bleibt nur als Bezeichnung früherer Transkripte.
    available: false,
    route: "plattform",
    note: "Abgelöst: Google leitet dieses Modell ab 1.12.2026 auf gemini-3.5-flash-lite um.",
  },
];

/**
 * Standard für neue Transkripte: gemini-4-argon (Denkstufe low) schreibt das
 * Schweizerdeutsch am zuverlässigsten (siehe `docs/vergleich-modelle-2026-11-10.md`).
 * Ohne `GEMINI_API_KEY` fällt die Auswahl auf gemini-3.5-flash-lite zurück.
 */
export const DEFAULT_MODEL: TranscriptionModelId = "gemini-4-argon";
/** Rückfall, wenn der eigene Schlüssel fehlt (läuft über den Plattform-Endpunkt). */
export const FALLBACK_MODEL: TranscriptionModelId = "gemini-3.5-flash-lite";
/** Bisheriges Modell; damit sind alle Transkripte vor der Modellauswahl entstanden. Nur noch Bezeichnung. */
export const LEGACY_MODEL: TranscriptionModelId = "gemini-2.5-flash";

export function findModel(id: string | null | undefined): TranscriptionModel | null {
  return TRANSCRIPTION_MODELS.find((model) => model.id === id) ?? null;
}

/** Nutzbar? Modelle mit `route: "direkt"` brauchen den eigenen Schlüssel (`GEMINI_API_KEY`). */
export function isAvailable(model: TranscriptionModel, directKey: boolean): boolean {
  return model.available && (model.route !== "direkt" || directKey);
}

/** Hinweis im Dashboard; ohne Schlüssel bei direkten Modellen „nicht eingerichtet“. */
export function availabilityNote(model: TranscriptionModel, directKey: boolean): string | null {
  if (model.available && model.route === "direkt" && !directKey) return "Nicht verfügbar: Zugang zur Gemini API ist nicht eingerichtet.";
  return model.note;
}

/** Tatsächlich verwendetes Modell: das gewählte, wenn nutzbar, sonst der Standard. */
export function resolveModel(id: string | null | undefined, directKey = false): TranscriptionModel {
  const chosen = findModel(id);
  if (chosen && isAvailable(chosen, directKey)) return chosen;
  const standard = findModel(DEFAULT_MODEL)!;
  return isAvailable(standard, directKey) ? standard : findModel(FALLBACK_MODEL)!;
}

/** Tokens einer oder mehrerer Anfragen, aufgeschlüsselt wie in `usageMetadata`. */
export type TokenUsage = {
  audioInput: number;
  textInput: number;
  output: number;
  thinking: number;
  requests: number;
};

export const EMPTY_USAGE: TokenUsage = { audioInput: 0, textInput: 0, output: 0, thinking: 0, requests: 0 };

type UsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
};

/** Liest `usageMetadata` einer `generateContent`-Antwort. */
export function usageFromMetadata(meta: UsageMetadata | null | undefined): TokenUsage {
  if (!meta) return { ...EMPTY_USAGE, requests: 1 };
  const prompt = meta.promptTokenCount ?? 0;
  const audio = (meta.promptTokensDetails ?? [])
    .filter((detail) => detail.modality === "AUDIO")
    .reduce((sum, detail) => sum + (detail.tokenCount ?? 0), 0);
  return {
    audioInput: audio,
    textInput: Math.max(0, prompt - audio),
    output: meta.candidatesTokenCount ?? 0,
    thinking: meta.thoughtsTokenCount ?? 0,
    requests: 1,
  };
}

type InteractionUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  input_tokens_by_modality?: { modality?: string; tokens?: number }[];
};

/** Liest `usage` einer Antwort der Interactions-API. */
export function usageFromInteraction(usage: InteractionUsage | null | undefined): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE, requests: 1 };
  const input = usage.total_input_tokens ?? 0;
  const audio = (usage.input_tokens_by_modality ?? [])
    .filter((entry) => entry.modality?.toLowerCase() === "audio")
    .reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
  return {
    audioInput: audio,
    textInput: Math.max(0, input - audio),
    output: usage.total_output_tokens ?? 0,
    thinking: usage.total_thought_tokens ?? 0,
    requests: 1,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    audioInput: a.audioInput + b.audioInput,
    textInput: a.textInput + b.textInput,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    requests: a.requests + b.requests,
  };
}

/** Kosten in USD; Denk-Tokens werden wie Ausgabe berechnet. */
export function costUsd(model: TranscriptionModel, usage: TokenUsage): number {
  const { price } = model;
  return (
    (usage.audioInput * price.audioInput +
      usage.textInput * price.textInput +
      (usage.output + usage.thinking) * price.output) /
    1_000_000
  );
}

/** Geschätzte Kosten je Audiominute aus den gemessenen Tokens je Minute. */
export function estimatedCostPerMinute(model: TranscriptionModel): number {
  return costUsd(model, { ...model.perMinute, thinking: 0, requests: 1 });
}

export function formatUsd(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `$${value.toLocaleString("de-CH", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/* ------------------------------------------------------------ Transkript-Metadaten */

/**
 * Herkunft eines gespeicherten Transkripts (`recordings.transcript`). Bei jeder
 * Neu-Transkription wandert der bisherige Eintrag nach `transcriptHistory`.
 */
export type TranscriptMeta = {
  model: string;
  /** `modelVersion` der Antwort, falls geliefert. */
  modelVersion: string | null;
  timing: TimingMethod;
  /** Fertigstellung des Transkripts. */
  at: string;
  /** `null` bei nachgetragenen Einträgen ohne gemessene Tokens. */
  usage: TokenUsage | null;
  costUsd: number | null;
  audioMs: number | null;
  /** Zuletzt neu ausgerichtet (nur Zeiten, Text unverändert). */
  retimedAt?: string | null;
  /** Nachgetragen für Transkripte aus der Zeit vor der Modellauswahl. */
  backfilled?: boolean;
};

/** Ältere Einträge in `transcriptHistory`, die aufbewahrt werden. */
export const TRANSCRIPT_HISTORY_MAX = 20;

/** Nachtrag für Transkripte vor der Modellauswahl: alle mit gemini-2.5-flash und geschätzten Zeiten. */
export function legacyTranscriptMeta(at: string | null, audioMs: number | null): TranscriptMeta {
  return {
    model: LEGACY_MODEL,
    modelVersion: null,
    timing: "schaetzung",
    at: at ?? new Date(0).toISOString(),
    usage: null,
    costUsd: null,
    audioMs,
    backfilled: true,
  };
}

/* ------------------------------------------------------------ Einstellungen */

/** Dokument in `settings` mit Modell und Vokabular. */
export const TRANSCRIPTION_SETTINGS_ID = "transcription_settings";

export type TranscriptionSettings = {
  _id: typeof TRANSCRIPTION_SETTINGS_ID;
  model: TranscriptionModelId;
  vocabulary: string[];
  updatedAt: string;
  updatedBy: string;
};

/** Grösste Zahl an Begriffen, die in den Prompt gehen (Google empfiehlt rund 100). */
export const VOCABULARY_MAX = 300;

/** Feste Vorbelegung; dazu kommen die Namen der Anrufer aus den Aufnahmen. */
export const BASE_VOCABULARY: readonly string[] = [
  "Immotrust",
  "Immotrust AG",
  "Zürich",
  "Winterthur",
  "Basel",
  "Bern",
  "Luzern",
  "St. Gallen",
  "Zug",
  "Aarau",
  "Baden",
  "Uster",
  "Dübendorf",
  "Kloten",
  "Wallisellen",
  "Thalwil",
  "Horgen",
  "Wädenswil",
  "Rapperswil-Jona",
  "Schaffhausen",
  "Frauenfeld",
  "Olten",
  "Solothurn",
  "Biel/Bienne",
  "Thun",
  "Chur",
  "Lugano",
  "Bahnhofstrasse",
  "Hauptstrasse",
  "Dorfstrasse",
  "Seestrasse",
  "Kirchgasse",
  "Badenerstrasse",
  "Langstrasse",
  "Limmatquai",
  "Stauffacherstrasse",
  "Hardturmstrasse",
  "Nebenkosten",
  "Stockwerkeigentum",
  "Eigenmietwert",
  "Hypothek",
  "Grundbuch",
  "Handänderungssteuer",
];

/** Bereinigt eine Liste: getrimmt, ohne Doppelte (Gross/klein egal), höchstens `VOCABULARY_MAX`. */
export function normalizeVocabulary(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    result.push(term);
    if (result.length >= VOCABULARY_MAX) break;
  }
  return result;
}

/** Name eines Anrufers ohne Kürzel in Klammern („Labruzzo (IT)“ → „Labruzzo“). */
export function callerVocabulary(names: readonly { first?: string | null; last?: string | null }[]): string[] {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return names
    .map((name) => [clean(name.first), clean(name.last)].filter(Boolean).join(" "))
    .filter((name) => name.length > 1);
}

/** Zusatz zum Prompt der Flash-Modelle. */
export function vocabularyPrompt(terms: readonly string[]): string {
  if (terms.length === 0) return "";
  return `\n\nSchreibweise von Namen und Begriffen, die im Gespräch vorkommen können. Verwende diese Schreibweise nur, wenn das Wort tatsächlich zu hören ist. Die Liste ist keine Liste der Sprecher: Übernimm daraus nie eine Sprecherbezeichnung.\n${terms.join(", ")}`;
}
