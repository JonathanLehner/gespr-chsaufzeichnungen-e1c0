/**
 * Übersetzt die technischen Meldungen des Transkriptionsdienstes in Sätze, die
 * Mitarbeitende ohne technischen Hintergrund verstehen. Die Rohmeldung bleibt
 * erhalten und wird in der Oberfläche nur hinter „Technische Details“ gezeigt.
 *
 * Die Datei enthält bewusst keine Server-Abhängigkeiten, damit sie sowohl in
 * Server- als auch in Client-Komponenten verwendet werden kann.
 */

export type TranscriptionFailure = {
  /** Verständlicher Satz zur Ursache. */
  message: string;
  /** Unveränderte Rohmeldung, oder `null`, wenn sie nichts hinzufügt. */
  technical: string | null;
};

const RULES: { test: RegExp; message: string }[] = [
  {
    test: /\b(408|504|522|524)\b|zeit(überschreitung|limit)|timeout|timed out|etimedout|deadline exceeded|aborted/i,
    message: "Der Transkriptionsdienst hat nicht rechtzeitig geantwortet.",
  },
  {
    test: /\b429\b|rate limit|too many requests|quota|resource exhausted/i,
    message: "Der Transkriptionsdienst ist zurzeit überlastet und hat den Auftrag abgewiesen.",
  },
  {
    test: /\b(500|502|503)\b|bad gateway|service unavailable|internal (server )?error|unavailable/i,
    message: "Der Transkriptionsdienst war vorübergehend nicht erreichbar.",
  },
  {
    test: /\b(401|403)\b|unauthorized|forbidden|permission denied|api[_ -]?key/i,
    message:
      "Der Zugang zum Transkriptionsdienst wurde abgelehnt. Die Administration muss die Zugangsdaten prüfen.",
  },
  {
    test: /\b413\b|too large|payload too|request entity|file size/i,
    message: "Die Audiodatei ist für den Transkriptionsdienst zu gross.",
  },
  {
    test: /kein gültiges json|verwertbaren text|safety|blocked|recitation|kein transkript/i,
    message: "Der Transkriptionsdienst hat kein auswertbares Transkript zurückgeliefert.",
  },
  {
    test: /\b(400|404|415|422)\b|invalid argument|unsupported|not found|unsupported media/i,
    message: "Der Transkriptionsdienst konnte die Audiodatei nicht verarbeiten.",
  },
  {
    test: /fetch failed|network|econnreset|econnrefused|enotfound|socket|dns/i,
    message: "Die Verbindung zum Transkriptionsdienst ist abgebrochen.",
  },
];

const FALLBACK = "Die Transkription konnte nicht abgeschlossen werden.";

export function describeTranscriptionError(raw: string | null | undefined): TranscriptionFailure {
  const technical = (raw ?? "").trim();
  if (!technical) return { message: FALLBACK, technical: null };

  const rule = RULES.find((entry) => entry.test.test(technical));
  const message = rule?.message ?? FALLBACK;
  return { message, technical: technical === message ? null : technical };
}

/**
 * Kurzer Hinweis darauf, wie es mit dem Auftrag weitergeht. `nextAttemptLabel`
 * ist der bereits formatierte Zeitpunkt der nächsten automatischen
 * Wiederholung, oder `null`, wenn keine mehr aussteht.
 */
export function retryHint(nextAttemptLabel: string | null | undefined): string {
  return nextAttemptLabel
    ? `Das System versucht es automatisch erneut, frühestens am ${nextAttemptLabel} Uhr. Sie können die Transkription auch sofort neu starten.`
    : "Die automatischen Wiederholungen sind ausgeschöpft. Sie können die Transkription jederzeit selbst neu starten.";
}
