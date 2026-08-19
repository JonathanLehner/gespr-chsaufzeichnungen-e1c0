import type { MailOutboxEntry } from "@/lib/types";

/**
 * Einzige Stelle, die entscheidet, welcher Link aus dem Postausgang überhaupt
 * angezeigt werden darf.
 *
 * Bestätigungslinks dürfen sichtbar bleiben – sie bestätigen lediglich eine
 * Adresse. Links zum Zurücksetzen des Passworts werden aus dem Protokoll nie
 * angezeigt: Wer einen solchen Link sieht, kann das zugehörige Konto übernehmen.
 * Braucht die Administration einen, erzeugt sie im Admin-Dashboard über
 * „Reset-Link erzeugen“ einen frischen, der genau einmal erscheint.
 */
export function displayableLink(mail: Pick<MailOutboxEntry, "kind" | "link">): string | null {
  return mail.kind === "bestaetigung" ? mail.link : null;
}
