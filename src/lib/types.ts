export type UserRole = "admin" | "user";

export type User = {
  _id: string; // normalisierte E-Mail-Adresse
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt?: string;
};

export type SessionUser = {
  email: string;
  name: string;
  role: UserRole;
  isAdmin: boolean;
};

/**
 * `ohne_sprache` ist ein Abschluss, kein Fehler: Der Dienst hat die Aufnahme
 * gehört und darin nichts Gesprochenes gefunden (Freizeichen, Besetztton,
 * aufgelegt). Solche Aufträge werden nicht wiederholt.
 */
export type TranscriptionStatus =
  | "wartend"
  | "in_arbeit"
  | "abgeschlossen"
  | "ohne_sprache"
  | "fehlgeschlagen";

export type Recording = {
  _id: string;
  originalFilename: string;
  audioUrl: string;
  mimeType: "audio/wav" | "audio/mpeg";
  byteSize: number;
  durationMs: number | null;
  callerName: string;
  callerLastName: string;
  callerFirstName: string;
  phoneNumber: string;
  callNumber: string;
  callAtUtc: string; // ISO-8601, aus CET normalisiert
  metadataSource: "dateiname" | "manuell";
  templateVersion: number | null;
  uploadedByEmail: string;
  uploadedByName: string;
  uploadedAt: string;
  fingerprint: string; // Dateiname + Grösse, für Doppelerkennung
  transcriptionStatus: TranscriptionStatus;
  transcriptionError: string | null;
  transcriptionStartedAt: string | null;
  transcriptionFinishedAt: string | null;
  /** Zeitpunkt, ab dem das System einen fehlgeschlagenen Auftrag selbst wiederholt. */
  transcriptionNextAttemptAt: string | null;
  transcriptionAttempts: number;
  speakerCount: number | null;
  wordCount: number | null;
  /** Zahl der Abschnitte, in die die Aufnahme zum Transkribieren geteilt wurde. */
  transcriptionChunks?: number | null;
  /**
   * Zeitbereiche, für die kein Text vorliegt, weil der Dienst den betreffenden
   * Abschnitt auch nach Wiederholungen nicht beantwortet hat. Der Rest des
   * Transkripts ist gültig; die Lücken werden in der Ansicht benannt.
   */
  transcriptionGaps?: { startMs: number; endMs: number }[] | null;
  /** Fehlt bei Transkripten aus der Zeit vor der akustischen Ausrichtung. */
  transcriptionAlignment?: AlignmentSource | null;
  deletionFlagged: boolean;
  deletionFlaggedBy: string | null;
  deletionFlaggedAt: string | null;
  deletionReason: string | null;
  ratingAverage: number | null;
  ratingCount: number;
};

export type {
  AlignmentSource,
  TranscriptSegment,
  TranscriptSentence,
  TranscriptWord,
} from "../../transcriber/shared/types";
import type { AlignmentSource, TranscriptSegment } from "../../transcriber/shared/types";

export type TranscriptIndexSentence = {
  t: number; // Startzeit in ms
  e: number; // Endzeit in ms
  s: string; // Sprecherbezeichnung
  x: string; // Satztext
};

export type TranscriptIndexDoc = {
  _id: string; // recordingId
  recordingId: string;
  fullText: string;
  sentences: TranscriptIndexSentence[];
  speakerLabels: string[];
  updatedAt: string;
};

export type TranscriptPartDoc = {
  _id: string; // `${recordingId}:${partIndex}`
  recordingId: string;
  partIndex: number;
  partCount: number;
  segments: TranscriptSegment[];
};

export type Comment = {
  _id: string;
  recordingId: string;
  text: string;
  authorEmail: string;
  authorName: string;
  createdAt: string;
  /**
   * Zeitpunkt der letzten Änderung am Text. Fehlt bei Kommentaren aus der Zeit
   * vor der Bearbeitungsmöglichkeit und bleibt `null`, solange der Kommentar
   * unverändert ist.
   */
  editedAt?: string | null;
};

export type Rating = {
  _id: string; // `${recordingId}:${email}`
  recordingId: string;
  score: number; // 1-10
  authorEmail: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

export type Job = {
  _id: string; // recordingId
  recordingId: string;
  type: "transkription";
  status: TranscriptionStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lockedAt: string | null;
  /** Nächster Versuch eines wartenden Auftrags nach einer Störung; `null` = sofort fällig. */
  nextAttemptAt: string | null;
  originalFilename: string;
  /** „Nach vorne“ im Admin-Dashboard; höhere Werte werden zuerst bearbeitet. */
  priority?: number | null;
};

/**
 * Angehaltene Warteschlange, für die Anzeige bei wartenden Aufnahmen:
 * Sperre nach dem Kostenlimit des Dienstes oder Pause durch den Admin.
 */
export type QueueHalt =
  | { kind: "gesperrt"; since: string; until: string }
  | { kind: "pausiert"; since: string }
  | null;

export type FilenameTemplateSettings = {
  _id: "filename_template";
  template: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  history: { version: number; template: string; updatedAt: string; updatedBy: string }[];
};

/** Angebundene Versanddienste; `protokoll` stellt nichts zu, sondern schreibt nur ins Serverprotokoll. */
export type MailProvider = "resend" | "postmark" | "sendgrid" | "mailgun" | "clawcorp" | "protokoll";

export type MailDeliveryStatus = "gesendet" | "fehlgeschlagen" | "nicht_konfiguriert";

export type MailOutboxEntry = {
  _id: string;
  to: string;
  subject: string;
  kind: "bestaetigung" | "passwort_reset";
  link: string;
  createdAt: string;
  expiresAt: string;
  /** Fehlt bei Einträgen aus der Zeit vor dem angebundenen Versand. */
  deliveryStatus?: MailDeliveryStatus;
  deliveryProvider?: MailProvider;
  deliveryError?: string | null;
  /** Gesetzt, wenn der Link im Admin-Dashboard von Hand erzeugt wurde. */
  issuedBy?: string | null;
};

/**
 * Einstellungen des E-Mail-Versands. Leere Felder bedeuten „aus der Umgebung
 * übernehmen“ (siehe `src/lib/mailer.ts`), damit dieselbe Anwendung entweder
 * über Worker-Secrets oder über das Admin-Dashboard eingerichtet werden kann.
 */
export type MailSettings = {
  _id: "mail_settings";
  provider: MailProvider | "";
  fromAddress: string;
  fromName: string;
  replyTo: string;
  /** Schlüssel des Versanddienstes. Verlässt den Server nie. */
  apiKey: string;
  mailgunDomain: string;
  mailgunRegion: "eu" | "us" | "";
  updatedAt: string | null;
  updatedBy: string | null;
};
