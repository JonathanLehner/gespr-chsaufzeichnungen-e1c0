/** Rückgabewert der Anmelde- und Registrierungsaktionen. */
export type AuthState = {
  status: "leer" | "fehler" | "erfolg";
  message?: string;
  /**
   * Ausschliesslich Bestätigungslinks für die E-Mail-Adresse, und auch die nur,
   * wenn die E-Mail nicht zugestellt werden konnte. Links zum Zurücksetzen des
   * Passworts werden nie an die Oberfläche gegeben.
   */
  verifyLink?: string;
  email?: string;
  /** Bleibt nach einer fehlgeschlagenen Registrierung im Formular stehen. */
  name?: string;
  /** Feld, auf das sich ein Validierungsfehler bezieht. */
  field?: "email";
};

export const emptyAuthState: AuthState = { status: "leer" };
