/**
 * Regeln für den Anzeigenamen eines Kontos.
 *
 * Die Datei enthält bewusst keine Server-Abhängigkeiten, damit dieselbe Prüfung
 * im Formular und in der Server-Aktion gilt (vgl. `transcription-errors.ts`).
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 60;

/** Fasst Leerraum zusammen und schneidet Ränder ab. */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Vorschlag für den Anzeigenamen, wenn bei der Registrierung keiner angegeben
 * wurde. Aus „samir.weber@…“ wird „Samir Weber“; enthält der vordere Teil der
 * Adresse keine Trennzeichen, bleibt es bei einem einzelnen Wort. Der Vorschlag
 * ist nur ein Startwert – geändert wird er unter „Einstellungen“.
 */
export function defaultNameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").trim();
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return normalizeName(words.join(" ")) || local;
}

export function nameProblem(name: string): string | null {
  const value = normalizeName(name);
  if (value.length < NAME_MIN_LENGTH) {
    return `Bitte geben Sie einen Namen mit mindestens ${NAME_MIN_LENGTH} Zeichen an.`;
  }
  if (value.length > NAME_MAX_LENGTH) {
    return `Der Name darf höchstens ${NAME_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (!/\p{L}/u.test(value)) {
    return "Der Name muss mindestens einen Buchstaben enthalten.";
  }
  if (/[<>@]/.test(value)) {
    return "Der Name darf die Zeichen <, > und @ nicht enthalten.";
  }
  return null;
}
