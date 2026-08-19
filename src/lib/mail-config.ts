import type { MailDeliveryStatus, MailProvider, MailSettings } from "./types";

/**
 * Beschreibung des E-Mail-Versands ohne Serverbezug, damit das Admin-Dashboard
 * dieselben Bezeichnungen verwendet wie der Versand selbst. Die Zustellung
 * liegt in `mailer.ts` und bleibt serverseitig.
 */

export const MAIL_PROVIDERS: MailProvider[] = [
  "protokoll",
  "resend",
  "postmark",
  "sendgrid",
  "mailgun",
];

export const PROVIDER_LABELS: Record<MailProvider, string> = {
  protokoll: "kein Versand (nur Protokoll)",
  resend: "Resend",
  postmark: "Postmark",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
};

export const DELIVERY_LABELS: Record<MailDeliveryStatus, string> = {
  gesendet: "zugestellt",
  fehlgeschlagen: "Versand fehlgeschlagen",
  nicht_konfiguriert: "kein Versand eingerichtet",
};

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Wirksamer Stand des Versands. Enthält nie den Schlüssel des Dienstes. */
export type MailConfig = {
  provider: MailProvider;
  fromAddress: string;
  fromName: string;
  /** Vollständiger Absender in der Form `Name <adresse>`. */
  from: string;
  replyTo: string | null;
  mailgunDomain: string;
  mailgunRegion: "eu" | "us";
  /** `true`, sobald ein Schlüssel hinterlegt ist – der Wert selbst bleibt auf dem Server. */
  apiKeySet: boolean;
  /** Letzte vier Zeichen des Schlüssels zur Wiedererkennung. */
  apiKeyHint: string | null;
  /** Herkunft der einzelnen Werte, damit im Dashboard ersichtlich ist, was greift. */
  fromEnv: { provider: boolean; apiKey: boolean; fromAddress: boolean };
  /** `true`, sobald tatsächlich zugestellt werden kann. */
  configured: boolean;
  /** Grund, weshalb nicht zugestellt werden kann – sonst `null`. */
  problem: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Hinterlegte Werte ohne Schlüssel – Vorbelegung des Formulars im Dashboard. */
export type MailSettingsView = Omit<MailSettings, "_id" | "apiKey"> & { apiKeyStored: boolean };

/** Eingabe des Einstellungsformulars. */
export type MailSettingsInput = {
  provider: MailProvider | "";
  fromAddress: string;
  fromName: string;
  replyTo: string;
  mailgunDomain: string;
  mailgunRegion: "eu" | "us" | "";
  /** `undefined` lässt den hinterlegten Schlüssel unverändert, `""` löscht ihn. */
  apiKey?: string;
};
