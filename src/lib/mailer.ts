import "server-only";
import { Collections, findById, upsertById } from "./db";
import {
  EMAIL_PATTERN,
  MAIL_PROVIDERS,
  PROVIDER_LABELS,
  type MailConfig,
  type MailSettingsInput,
  type MailSettingsView,
} from "./mail-config";
import type { MailDeliveryStatus, MailProvider, MailSettings } from "./types";

/**
 * Versand der Bestätigungs- und Reset-Mails.
 *
 * Versanddienst und Absenderadresse sind einstellbar, und zwar an zwei Stellen:
 *
 *  1. Umgebungsvariablen (im Worker als Secrets hinterlegt)
 *       MAIL_PROVIDER      resend | postmark | sendgrid | mailgun | protokoll
 *       MAIL_API_KEY       Schlüssel des gewählten Dienstes
 *       MAIL_FROM_ADDRESS  Absenderadresse, z. B. noreply@immotrustag.ch
 *       MAIL_FROM_NAME     Anzeigename des Absenders
 *       MAIL_REPLY_TO      optionale Antwortadresse
 *       MAIL_MAILGUN_DOMAIN, MAIL_MAILGUN_REGION (eu|us) – nur für Mailgun
 *       APP_BASE_URL       Basis der Links in den Mails
 *  2. Admin-Dashboard: dieselben Werte liegen im Einstellungsdokument
 *     `mail_settings` und haben Vorrang, sobald sie gesetzt sind. So lässt sich
 *     der Versand ohne neue Auslieferung einrichten oder umstellen.
 *
 * Angebunden sind ausschliesslich HTTP-Schnittstellen: Die Anwendung läuft als
 * Cloudflare Worker, wo kein SMTP-Ausgang zur Verfügung steht.
 *
 * Ist nichts hinterlegt, bleibt der Versand auf „protokoll“. Die Nachricht wird
 * dann im Serverprotokoll festgehalten und im Postausgang als nicht zugestellt
 * vermerkt, sodass an jeder Stelle erkennbar ist, ob eine Mail wirklich rausging.
 */

export type MailDelivery = {
  status: MailDeliveryStatus;
  provider: MailProvider;
  error: string | null;
  sentAt: string;
};

const SETTINGS_ID = "mail_settings";
const DEFAULT_FROM_ADDRESS = "noreply@immotrustag.ch";
const DEFAULT_FROM_NAME = "Gesprächsaufzeichnungen Immotrust AG";
const TIMEOUT_MS = 12_000;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

const EMPTY_SETTINGS: MailSettings = {
  _id: SETTINGS_ID,
  provider: "",
  fromAddress: "",
  fromName: "",
  replyTo: "",
  apiKey: "",
  mailgunDomain: "",
  mailgunRegion: "",
  updatedAt: null,
  updatedBy: null,
};

/**
 * Liest die gespeicherten Einstellungen. Enthält den Schlüssel – nur
 * serverseitig verwenden. Fehlende Felder älterer Dokumente gelten als leer.
 */
export async function readMailSettings(): Promise<MailSettings> {
  const stored = await findById<Partial<MailSettings>>(Collections.settings, SETTINGS_ID);
  if (!stored) return { ...EMPTY_SETTINGS };
  const region = stored.mailgunRegion === "eu" || stored.mailgunRegion === "us" ? stored.mailgunRegion : "";
  return {
    _id: SETTINGS_ID,
    provider: MAIL_PROVIDERS.includes(stored.provider as MailProvider)
      ? (stored.provider as MailProvider)
      : "",
    fromAddress: stored.fromAddress ?? "",
    fromName: stored.fromName ?? "",
    replyTo: stored.replyTo ?? "",
    apiKey: stored.apiKey ?? "",
    mailgunDomain: stored.mailgunDomain ?? "",
    mailgunRegion: region,
    updatedAt: stored.updatedAt ?? null,
    updatedBy: stored.updatedBy ?? null,
  };
}

export async function saveMailSettings(
  input: MailSettingsInput,
  updatedBy: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const provider = input.provider.trim() as MailProvider | "";
  if (provider !== "" && !MAIL_PROVIDERS.includes(provider)) {
    return { ok: false, message: "Unbekannter Versanddienst." };
  }
  const fromAddress = input.fromAddress.trim().toLowerCase();
  if (fromAddress && !EMAIL_PATTERN.test(fromAddress)) {
    return { ok: false, message: "Die Absenderadresse ist keine gültige E-Mail-Adresse." };
  }
  const replyTo = input.replyTo.trim().toLowerCase();
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) {
    return { ok: false, message: "Die Antwortadresse ist keine gültige E-Mail-Adresse." };
  }
  const region = input.mailgunRegion.trim().toLowerCase();
  if (region !== "" && region !== "eu" && region !== "us") {
    return { ok: false, message: "Die Mailgun-Region muss „eu“ oder „us“ sein." };
  }

  const current = await readMailSettings();
  const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim();

  if (provider !== "" && provider !== "protokoll" && !apiKey && !env("MAIL_API_KEY")) {
    return {
      ok: false,
      message: `Für ${PROVIDER_LABELS[provider]} wird ein Schlüssel benötigt. Bitte tragen Sie ihn ein.`,
    };
  }

  await upsertById(Collections.settings, SETTINGS_ID, {
    provider,
    fromAddress,
    fromName: input.fromName.trim(),
    replyTo,
    apiKey,
    mailgunDomain: input.mailgunDomain.trim(),
    mailgunRegion: region,
    updatedAt: new Date().toISOString(),
    updatedBy,
  });
  return { ok: true };
}

function apiKeyOf(settings: MailSettings): string {
  return settings.apiKey.trim() || env("MAIL_API_KEY");
}

function chosenProvider(settings: MailSettings): MailProvider {
  const stored = settings.provider.trim().toLowerCase();
  if (MAIL_PROVIDERS.includes(stored as MailProvider)) return stored as MailProvider;
  const fromEnv = env("MAIL_PROVIDER").toLowerCase();
  if (MAIL_PROVIDERS.includes(fromEnv as MailProvider)) return fromEnv as MailProvider;
  // Ohne ausdrückliche Angabe entscheidet ein vorhandener Schlüssel.
  return apiKeyOf(settings) ? "resend" : "protokoll";
}

function configFrom(settings: MailSettings): MailConfig {
  const envProvider = env("MAIL_PROVIDER").toLowerCase();
  const provider = chosenProvider(settings);

  const fromAddress = settings.fromAddress || env("MAIL_FROM_ADDRESS") || DEFAULT_FROM_ADDRESS;
  const fromName = settings.fromName || env("MAIL_FROM_NAME") || DEFAULT_FROM_NAME;
  const replyTo = settings.replyTo || env("MAIL_REPLY_TO") || null;
  const mailgunDomain = settings.mailgunDomain || env("MAIL_MAILGUN_DOMAIN");
  const mailgunRegion =
    (settings.mailgunRegion || env("MAIL_MAILGUN_REGION").toLowerCase()) === "eu" ? "eu" : "us";
  const key = apiKeyOf(settings);

  let problem: string | null = null;
  if (provider === "protokoll") {
    problem = "Es ist kein Versanddienst hinterlegt. E-Mails werden nur protokolliert.";
  } else if (!key) {
    problem = `Für ${PROVIDER_LABELS[provider]} fehlt der Schlüssel.`;
  } else if (provider === "mailgun" && !mailgunDomain) {
    problem = "Für Mailgun fehlt die Domain.";
  } else if (!EMAIL_PATTERN.test(fromAddress)) {
    problem = "Die Absenderadresse ist keine gültige E-Mail-Adresse.";
  }

  return {
    provider,
    fromAddress,
    fromName,
    from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
    replyTo,
    mailgunDomain,
    mailgunRegion,
    apiKeySet: Boolean(key),
    apiKeyHint: key ? key.slice(-4) : null,
    fromEnv: {
      provider: !settings.provider && Boolean(envProvider),
      apiKey: !settings.apiKey.trim() && Boolean(env("MAIL_API_KEY")),
      fromAddress: !settings.fromAddress && Boolean(env("MAIL_FROM_ADDRESS")),
    },
    configured: problem === null,
    problem,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
}

/** Aktueller Stand des Versands. Enthält keinen Schlüssel und darf angezeigt werden. */
export async function mailConfig(): Promise<MailConfig> {
  return configFrom(await readMailSettings());
}

/**
 * Liest Einstellungen und wirksamen Stand in einem Zug, damit das Dashboard die
 * Datenbank nicht zweimal anfragt.
 */
export async function mailOverview(): Promise<{ settings: MailSettingsView; config: MailConfig }> {
  const stored = await readMailSettings();
  return {
    settings: {
      provider: stored.provider,
      fromAddress: stored.fromAddress,
      fromName: stored.fromName,
      replyTo: stored.replyTo,
      mailgunDomain: stored.mailgunDomain,
      mailgunRegion: stored.mailgunRegion,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      apiKeyStored: Boolean(stored.apiKey.trim()),
    },
    config: configFrom(stored),
  };
}

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * Stellt eine Nachricht zu. Wirft nie – ein Fehlschlag darf weder die
 * Registrierung noch die Antwort der Passwort-vergessen-Seite verändern.
 */
export async function sendMail(message: MailMessage): Promise<MailDelivery> {
  const settings = await readMailSettings();
  const config = configFrom(settings);
  const sentAt = new Date().toISOString();

  if (!config.configured) {
    console.warn(
      `[mail] nicht zugestellt an ${message.to} („${message.subject}“): ${config.problem}`,
    );
    return {
      status: "nicht_konfiguriert",
      provider: config.provider,
      error: config.problem,
      sentAt,
    };
  }

  try {
    await deliver(config, apiKeyOf(settings), message);
    return { status: "gesendet", provider: config.provider, error: null, sentAt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[mail] Versand an ${message.to} fehlgeschlagen: ${detail}`);
    return {
      status: "fehlgeschlagen",
      provider: config.provider,
      error: detail.slice(0, 300),
      sentAt,
    };
  }
}

async function deliver(config: MailConfig, key: string, message: MailMessage): Promise<void> {
  switch (config.provider) {
    case "resend":
      return request("https://api.resend.com/emails", {
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        }),
      });

    case "postmark":
      return request("https://api.postmarkapp.com/email", {
        headers: {
          "X-Postmark-Server-Token": key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          From: config.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: env("MAIL_POSTMARK_STREAM") || "outbound",
          ...(config.replyTo ? { ReplyTo: config.replyTo } : {}),
        }),
      });

    case "sendgrid":
      return request("https://api.sendgrid.com/v3/mail/send", {
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: config.fromAddress, name: config.fromName },
          subject: message.subject,
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
          ...(config.replyTo ? { reply_to: { email: config.replyTo } } : {}),
        }),
      });

    case "mailgun": {
      const host = config.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
      const form = new URLSearchParams({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      if (config.replyTo) form.set("h:Reply-To", config.replyTo);
      return request(`https://${host}/v3/${encodeURIComponent(config.mailgunDomain)}/messages`, {
        headers: {
          Authorization: `Basic ${btoa(`api:${key}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
    }

    default:
      throw new Error("Unbekannter Versanddienst.");
  }
}

async function request(url: string, init: { headers: Record<string, string>; body: string }) {
  const res = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${new URL(url).host} antwortete ${res.status}: ${detail}`);
  }
}
