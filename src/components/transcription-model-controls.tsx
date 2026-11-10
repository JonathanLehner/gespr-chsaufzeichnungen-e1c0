"use client";

import { useState } from "react";
import {
  enqueueRetranscriptionAction,
  planRetranscriptionAction,
  saveModelSettingAction,
  saveVocabularyAction,
} from "@/app/actions/admin";
import { ResultText, useLockedAction } from "@/components/queue-controls";
import type { RetranscribePlan } from "@/lib/transcription-models";

export type ModelOption = {
  id: string;
  available: boolean;
  note: string | null;
  timingLabel: string;
  estimatedPerMinute: string;
  actualPerMinute: string | null;
};

export function ModelSettingsForm({
  models,
  selected,
  defaultId,
}: {
  models: ModelOption[];
  selected: string;
  defaultId: string;
}) {
  const { pending, result, run } = useLockedAction();
  const [value, setValue] = useState(selected);

  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => saveModelSettingAction(value));
      }}
    >
      <fieldset>
        <legend className="sr-only">Transkriptionsmodell</legend>
        <div className="divide-y divide-line rounded-md border border-line">
          {models.map((model) => (
            <label
              key={model.id}
              className={`flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5 ${
                model.available ? "cursor-pointer hover:bg-canvas" : "cursor-not-allowed opacity-70"
              }`}
            >
              <input
                type="radio"
                name="modell"
                value={model.id}
                checked={value === model.id}
                disabled={!model.available}
                onChange={() => setValue(model.id)}
                className="mt-1 accent-[#0e5567]"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[12.5px] text-ink">
                  {model.id}
                  {model.id === defaultId && <span className="ml-2 badge bg-petrol-soft text-petrol">Standard</span>}
                </span>
                <span className="block text-[12px] text-ink-soft">{model.timingLabel}</span>
                {model.note && <span className="block text-[12px] text-warn">{model.note}</span>}
              </span>
              <span className="text-right text-[12px] tabular-nums text-ink-soft">
                <span className="block text-ink">ca. {model.estimatedPerMinute}/Min.</span>
                {model.actualPerMinute && <span className="block">tatsächlich {model.actualPerMinute}/Min.</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3">
        <button type="submit" className="btn btn-primary" disabled={pending || value === selected}>
          {pending ? "Wird gespeichert …" : "Modell speichern"}
        </button>
      </div>
      <ResultText result={result} />
    </form>
  );
}

export function VocabularyForm({ initial, stored }: { initial: string[]; stored: boolean }) {
  const { pending, result, run } = useLockedAction();
  const [text, setText] = useState(initial.join("\n"));
  const count = text.split("\n").filter((line) => line.trim()).length;

  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => saveVocabularyAction(text));
      }}
    >
      <label className="block">
        <span className="block text-[12px] font-semibold text-ink-soft">Ein Begriff pro Zeile</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={10}
          spellCheck={false}
          className="field mt-1 h-auto font-mono text-[12px] leading-relaxed"
        />
      </label>
      <p className="mt-1 text-[11.5px] text-ink-faint tabular-nums">
        {count} Begriffe{stored ? "" : " · Vorbelegung, noch nicht gespeichert"}
      </p>
      <div className="mt-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Wird gespeichert …" : "Vokabular speichern"}
        </button>
      </div>
      <ResultText result={result} />
    </form>
  );
}

type Input = { target: string; scope: "eine" | "alle"; model: string; kind: "transkription" | "neu_ausrichten" };

function usd(value: number) {
  return `$${value.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function RetranscribeForm({ models, defaultModel }: { models: ModelOption[]; defaultModel: string }) {
  const preview = useLockedAction();
  const submit = useLockedAction();
  const [input, setInput] = useState<Input>({ target: "", scope: "eine", model: defaultModel, kind: "transkription" });
  const [plan, setPlan] = useState<(RetranscribePlan & { for: string }) | null>(null);
  const key = JSON.stringify(input);
  const current = plan && plan.for === key ? plan : null;
  const update = (patch: Partial<Input>) => setInput((value) => ({ ...value, ...patch }));

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        preview.run(async () => {
          const result = await planRetranscriptionAction(input);
          setPlan({ ...result, for: key });
          return { ok: result.ok, message: result.message };
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset>
          <legend className="text-[12px] font-semibold text-ink-soft">Aktion</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={input.kind === "transkription"} onChange={() => update({ kind: "transkription" })} className="accent-[#0e5567]" />
              Neu transkribieren
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={input.kind === "neu_ausrichten"} onChange={() => update({ kind: "neu_ausrichten" })} className="accent-[#0e5567]" />
              Zeiten neu ausrichten
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[12px] font-semibold text-ink-soft">Umfang</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={input.scope === "eine"} onChange={() => update({ scope: "eine" })} className="accent-[#0e5567]" />
              Eine Aufnahme
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={input.scope === "alle"} onChange={() => update({ scope: "alle" })} className="accent-[#0e5567]" />
              Alle Transkripte
            </label>
          </div>
        </fieldset>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {input.scope === "eine" && (
          <label className="block">
            <span className="block text-[12px] font-semibold text-ink-soft">Anrufnummer, Aufnahme-ID oder Dateiname</span>
            <input
              value={input.target}
              onChange={(event) => update({ target: event.target.value })}
              required
              className="field mt-1 font-mono text-[12px]"
              placeholder="10980"
            />
          </label>
        )}
        {input.kind === "transkription" && (
          <label className="block">
            <span className="block text-[12px] font-semibold text-ink-soft">Modell</span>
            <select value={input.model} onChange={(event) => update({ model: event.target.value })} className="field mt-1 font-mono text-[12px]">
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.id} · ca. {model.estimatedPerMinute}/Min.{model.available ? "" : " · nicht verfügbar"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-[12px] text-ink-faint">
        {input.scope === "alle"
          ? input.kind === "transkription"
            ? "Alle abgeschlossenen Transkripte, die nicht schon von diesem Modell stammen."
            : "Alle abgeschlossenen Transkripte mit geschätzten Zeiten."
          : "Das bisherige Transkript bleibt sichtbar, bis das neue fertig ist."}{" "}
        Neue Uploads haben immer Vorrang.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-secondary" disabled={preview.pending}>
          {preview.pending ? "Wird geprüft …" : "Prüfen"}
        </button>
        {current?.ok && current.count > 0 && (
          <>
            <span className="text-[12.5px] text-ink tabular-nums">
              {current.count} {current.count === 1 ? "Aufnahme" : "Aufnahmen"},{" "}
              {Math.round(current.audioMinutes).toLocaleString("de-CH")} Min.
              {input.kind === "transkription" ? `, ca. ${usd(current.estimatedUsd)}` : ", ohne Kosten"}
              {current.skipped > 0 ? ` · ${current.skipped} bereits in der Warteschlange` : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submit.pending}
              onClick={() =>
                submit.run(async () => {
                  const result = await enqueueRetranscriptionAction(input);
                  setPlan(null);
                  return { ok: result.ok, message: result.message };
                })
              }
            >
              {submit.pending ? "Wird eingereiht …" : "Einreihen"}
            </button>
          </>
        )}
      </div>
      <ResultText result={preview.result && !preview.result.ok ? preview.result : current && current.count === 0 ? { ok: true, message: current.message } : null} />
      <ResultText result={submit.result} />
    </form>
  );
}
