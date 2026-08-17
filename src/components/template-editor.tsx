"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  previewTemplateAction,
  resetToDefaultTemplateAction,
  saveTemplateAction,
  type TemplatePreview,
} from "@/app/actions/admin";
import { DEFAULT_TEMPLATE_EXAMPLE, PLACEHOLDERS } from "@/lib/filename-template";
import { formatDateTimeWithSeconds } from "@/lib/time";

export function TemplateEditor({
  initialTemplate,
  version,
  updatedAt,
  updatedBy,
  history,
}: {
  initialTemplate: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  history: { version: number; template: string; updatedAt: string; updatedBy: string }[];
}) {
  const router = useRouter();
  const [template, setTemplate] = useState(initialTemplate);
  const [testName, setTestName] = useState(DEFAULT_TEMPLATE_EXAMPLE);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, startSaving] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await previewTemplateAction(template, testName);
        if (!cancelled) setPreview(result);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [template, testName]);

  function insertPlaceholder(token: string) {
    const input = inputRef.current;
    if (!input) {
      setTemplate((current) => current + token);
      return;
    }
    const start = input.selectionStart ?? template.length;
    const end = input.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  }

  const valid = preview?.validation.valid ?? false;
  const parsedOk = preview?.parsed?.ok ?? false;
  const unchanged = template.trim() === initialTemplate.trim();

  function save() {
    if (saving || !valid) return;
    startSaving(async () => {
      const result = await saveTemplateAction(template.trim());
      setFeedback(result);
      if (result.ok) router.refresh();
    });
  }

  function reset() {
    if (saving) return;
    startSaving(async () => {
      const result = await resetToDefaultTemplateAction();
      setFeedback(result);
      setTemplate(result.template);
      router.refresh();
    });
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Dateinamensvorlage</h2>
        <p className="text-[12px] text-ink-faint">
          Aktive Version {version} · zuletzt geändert am {formatDateTimeWithSeconds(updatedAt)} von{" "}
          {updatedBy}
        </p>
      </div>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
        Die Vorlage besteht aus Platzhaltern und frei wählbaren Trennzeichen. Sie bestimmt, wie
        Anrufername, Telefonnummer, Zeitpunkt und Anrufnummer beim Sammelupload aus dem Dateinamen
        gelesen werden. Bestehende Aufnahmen behalten die Version, mit der sie erfasst wurden.
      </p>

      <div className="mt-4">
        <label className="label" htmlFor="vorlage">
          Vorlage
        </label>
        <input
          id="vorlage"
          ref={inputRef}
          className="field font-mono"
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
          spellCheck={false}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PLACEHOLDERS.map((placeholder) => (
            <button
              key={placeholder.key}
              type="button"
              className="btn btn-secondary font-mono text-[12px]"
              title={placeholder.description}
              onClick={() => insertPlaceholder(placeholder.token)}
            >
              {placeholder.token}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-faint">
          Für abweichende Zeitformate kann {"{DatumZeit:yyyy-MM-dd_HH-mm-ss}"} verwendet werden.
          Zulässige Bausteine: yyyy, MM, dd, HH, mm, ss. Die Uhrzeit wird als CET interpretiert.
        </p>
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="testname">
          Testdateiname
        </label>
        <input
          id="testname"
          className="field font-mono"
          value={testName}
          onChange={(event) => setTestName(event.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="mt-4 rounded-[4px] border border-line bg-canvas p-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
          Vorschau {checking && <span className="font-normal text-ink-faint">· wird geprüft …</span>}
        </h3>

        {preview && preview.validation.errors.length > 0 && (
          <ul className="mt-2 space-y-1">
            {preview.validation.errors.map((error) => (
              <li key={error} className="notice notice-error">
                {error}
              </li>
            ))}
          </ul>
        )}
        {preview && preview.validation.warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {preview.validation.warnings.map((warning) => (
              <li key={warning} className="notice notice-warn">
                {warning}
              </li>
            ))}
          </ul>
        )}

        {preview?.parsed && !preview.parsed.ok && (
          <div className="notice notice-error mt-2">{preview.parsed.error}</div>
        )}

        {preview?.parsed?.ok && (
          <dl className="mt-2 grid gap-2 sm:grid-cols-4">
            {[
              ["Anrufer", preview.parsed.callerName],
              ["Telefonnummer", preview.parsed.phoneNumber || "–"],
              ["Anrufnummer", preview.parsed.callNumber || "–"],
              ["Zeitpunkt (CET)", formatDateTimeWithSeconds(preview.parsed.callAtUtc)],
            ].map(([term, value]) => (
              <div key={term} className="rounded-[4px] border border-line bg-surface p-2">
                <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{term}</dt>
                <dd className="mt-0.5 text-[13px] font-medium text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {preview && valid && parsedOk && (
          <p className="mt-2 text-[12px] text-ok">
            Die Vorlage ist gültig und liest den Testdateinamen korrekt.
          </p>
        )}
      </div>

      {feedback && (
        <div className={`notice ${feedback.ok ? "notice-ok" : "notice-error"} mt-4`} role="status">
          {feedback.message}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !valid || unchanged}
          onClick={save}
          title={unchanged ? "Die Vorlage ist unverändert." : undefined}
        >
          {saving ? "Wird gespeichert …" : "Vorlage speichern"}
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={reset}>
          Standardvorlage wiederherstellen
        </button>
        <span className="text-[12px] text-ink-faint">
          Speichern ist nur möglich, wenn die Vorlage gültig ist.
        </span>
      </div>

      {history.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-[12px] font-semibold text-ink-soft">
            Frühere Versionen ({history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...history].reverse().map((entry) => (
              <li key={entry.version} className="flex flex-wrap gap-2 text-[12px] text-ink-soft">
                <span className="w-16 shrink-0 font-semibold">V{entry.version}</span>
                <code className="font-mono text-[11.5px] text-ink">{entry.template}</code>
                <span className="text-ink-faint">
                  {formatDateTimeWithSeconds(entry.updatedAt)} · {entry.updatedBy}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
