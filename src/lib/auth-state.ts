/** Rückgabewert der Anmelde- und Registrierungsaktionen. */
export type AuthState = {
  status: "leer" | "fehler" | "erfolg";
  message?: string;
  link?: string;
  email?: string;
  /** Bleibt nach einer fehlgeschlagenen Registrierung im Formular stehen. */
  name?: string;
  /** Feld, auf das sich ein Validierungsfehler bezieht. */
  field?: "email";
};

export const emptyAuthState: AuthState = { status: "leer" };
