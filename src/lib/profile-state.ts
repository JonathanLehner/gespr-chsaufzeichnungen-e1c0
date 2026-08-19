/**
 * Rückgabewert der Profilaktion.
 *
 * Der Startwert steht bewusst hier und nicht in `src/app/actions/profile.ts`:
 * Ein Modul mit „use server“ darf nur asynchrone Funktionen ausgeben. Ein
 * Objekt, das von dort in eine Client-Komponente importiert wird, kommt als
 * Serververweis an – `state.name` läse dann den Namen dieser Funktion statt des
 * eingegebenen Namens. Vgl. `auth-state.ts`.
 */
export type ProfileState = {
  status: "leer" | "erfolg" | "fehler";
  message: string;
  /** Zuletzt eingegebener Wert, damit das Feld nach einem Fehler gefüllt bleibt. */
  name: string;
};

export const emptyProfileState: ProfileState = { status: "leer", message: "", name: "" };
