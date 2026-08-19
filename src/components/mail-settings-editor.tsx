"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveMailSettingsAction, sendTestMailAction } from "@/app/actions/admin";
import {
  MAIL_PROVIDERS,
  PROVIDER_LABELS,
  type MailConfig,
  type MailSettingsView,
} from "@/lib/mail-config";
import type { MailProvider } from "@/lib/types";
import { formatDateTimeWithSeconds } from "@/lib/time";

/**
 * Stellt Versanddienst und Absender ein. Der Schlüssel wird nur entgegengenommen
 * und nie zurückgeliefert – angezeigt werden lediglich die letzten vier Zeichen.
 */
export function MailSettingsEditor({
  settings,
  config,
  testAddress,
}: {
  settings: MailSettingsView;
  config: MailConfig;
  testAddress: string;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<MailProvider | "">(settings.provider);
  const [fromAddress, setFromAddress] = useState(settings.fromAddress);
  const [fromName, setFromName] = useState(settings.fromName);
  const [replyTo, setReplyTo] = useState(settings.replyTo);
  const [mailgunDomain, setMailgunDomain] = useState(settings.mailgunDomain);
  const [mailgunRegion, setMailgunRegion] = useState(settings.mailgunRegion);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [testTo, setTestTo] = useState(testAddress);
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  function save() {
    if (saving) return;
    startSaving(async () => {
      const result = await saveMailSettingsAction({
        provider,
        fromAddress,
        fromName,
        replyTo,
        mailgunDomain,
        mailgunRegion,
        apiKey: clearKey ? "" : apiKey.trim() ? apiKey : undefined,
      });
      setFeedback(result);
      if (result.ok) {
        setApiKey("");
        setClearKey(false);
        router.refresh();
      }
    });
  }

  function test() {
    if (testing) return;
    startTesting(async () => {
      setFeedback(await sendTestMailAction(testTo));
      router.refresh();
    });
  }

  const effective = config.configured
    ? `Versand aktiv über ${PROVIDER_LABELS[config.provider]}, Absender ${config.from}.`
    : (config.problem ?? "");

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">E-Mail-Versand</h2>
        {config.updatedAt && (
          <p className="text-[12px] text-ink-faint">
            zuletzt geändert am {formatDateTimeWithSeconds(config.updatedAt)} von {config.updatedBy}
          </p>
        )}
      </div>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
        Bestätigungs- und Reset-Mails gehen über den hier eingestellten Dienst hinaus. Leere Felder
        übernehmen den Wert aus den Umgebungsvariablen (<code className="font-mono">MAIL_PROVIDER</code>,{" "}
        <code className="font-mono">MAIL_API_KEY</code>,{" "}
        <code className="font-mono">MAIL_FROM_ADDRESS</code> …). Der Schlüssel wird nur gespeichert und
        nie wieder angezeigt.
      </p>

      <div className={`notice ${config.configured ? "notice-ok" : "notice-warn"} mt-3`} role="status">
        {effective}
        {config.apiKeySet && (
          <>
            {" "}
            Schlüssel hinterlegt (…{config.apiKeyHint}
            {config.fromEnv.apiKey ? ", aus der Umgebung" : ""}).
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="mail-provider">
            Versanddienst
          </label>
          <select
            id="mail-provider"
            className="field"
            value={provider}
            onChange={(event) => setProvider(event.target.value as MailProvider | "")}
          >
            <option value="">Aus Umgebungsvariablen übernehmen</option>
            {MAIL_PROVIDERS.map((entry) => (
              <option key={entry} value={entry}>
                {PROVIDER_LABELS[entry]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="mail-key">
            Schlüssel des Dienstes
          </label>
          <input
            id="mail-key"
            type="password"
            className="field font-mono"
            autoComplete="off"
            value={apiKey}
            disabled={clearKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings.apiKeyStored ? "hinterlegt – leer lassen behält ihn" : "z. B. re_…"}
          />
          {settings.apiKeyStored && (
            <label className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-soft">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              Hinterlegten Schlüssel entfernen
            </label>
          )}
        </div>

        <div>
          <label className="label" htmlFor="mail-from">
            Absenderadresse
          </label>
          <input
            id="mail-from"
            type="email"
            className="field"
            value={fromAddress}
            onChange={(event) => setFromAddress(event.target.value)}
            placeholder={config.fromAddress}
          />
        </div>

        <div>
          <label className="label" htmlFor="mail-from-name">
            Anzeigename des Absenders
          </label>
          <input
            id="mail-from-name"
            className="field"
            value={fromName}
            onChange={(event) => setFromName(event.target.value)}
            placeholder={config.fromName}
          />
        </div>

        <div>
          <label className="label" htmlFor="mail-reply">
            Antwortadresse (optional)
          </label>
          <input
            id="mail-reply"
            type="email"
            className="field"
            value={replyTo}
            onChange={(event) => setReplyTo(event.target.value)}
            placeholder={config.replyTo ?? "keine"}
          />
        </div>

        {provider === "mailgun" && (
          <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
            <div>
              <label className="label" htmlFor="mail-mailgun-domain">
                Mailgun-Domain
              </label>
              <input
                id="mail-mailgun-domain"
                className="field"
                value={mailgunDomain}
                onChange={(event) => setMailgunDomain(event.target.value)}
                placeholder="mg.immotrustag.ch"
              />
            </div>
            <div>
              <label className="label" htmlFor="mail-mailgun-region">
                Region
              </label>
              <select
                id="mail-mailgun-region"
                className="field"
                value={mailgunRegion}
                onChange={(event) => setMailgunRegion(event.target.value as "eu" | "us" | "")}
              >
                <option value="">Vorgabe</option>
                <option value="eu">EU</option>
                <option value="us">US</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {feedback && (
        <div className={`notice ${feedback.ok ? "notice-ok" : "notice-error"} mt-4`} role="status">
          {feedback.message}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? "Wird gespeichert …" : "Einstellungen speichern"}
        </button>
        <div>
          <label className="label" htmlFor="mail-test">
            Testnachricht an
          </label>
          <input
            id="mail-test"
            type="email"
            className="field w-64"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={testing || !config.configured}
          title={config.configured ? undefined : "Erst einen Versanddienst hinterlegen."}
          onClick={test}
        >
          {testing ? "Wird gesendet …" : "Testnachricht senden"}
        </button>
      </div>
    </section>
  );
}
