import type { MailOutboxEntry } from "@/lib/types";

/**
 * Einzige Stelle, die entscheidet, welcher Link aus dem Postausgang überhaupt
 * angezeigt werden darf.
 *
 * Bestätigungslinks dürfen sichtbar bleiben – sie bestätigen lediglich eine
 * Adresse. Links zum Zurücksetzen des Passworts werden nie angezeigt, auch
 * nicht im Admin-Dashboard und auch dann nicht, wenn kein E-Mail-Versand
 * eingerichtet ist: Wer einen solchen Link sieht, kann das zugehörige Konto
 * übernehmen.
 */
export function displayableLink(mail: Pick<MailOutboxEntry, "kind" | "link">): string | null {
  return mail.kind === "bestaetigung" ? mail.link : null;
}
