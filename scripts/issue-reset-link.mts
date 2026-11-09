/**
 * Erzeugt einen Link zum Zurücksetzen des Passworts für ein bestehendes Konto,
 * wenn der E-Mail-Versand nicht eingerichtet ist und die Person sich nicht
 * mehr anmelden kann (z. B. der Superuser, der den Link sonst im
 * Admin-Dashboard erzeugen würde). Setzt selbst kein Passwort.
 *
 *   RESET_EMAIL=... [APP_BASE_URL=https://...] \
 *     npx tsx --env-file=.env.local --conditions=react-server scripts/issue-reset-link.mts
 *
 * Der Link ist 60 Minuten gültig und einmal verwendbar. Er wird nur auf der
 * Konsole ausgegeben; im Postausgang erscheint er wie gewohnt nicht.
 */
const email = process.env.RESET_EMAIL;
if (!process.env.MONGODB_URI || !email) {
  console.error("MONGODB_URI und RESET_EMAIL müssen gesetzt sein.");
  process.exit(1);
}

const { normalizeEmail } = await import("../src/lib/auth");
const { Collections, findById, closeDb } = await import("../src/lib/db");
const { issueAuthLink } = await import("../src/lib/mail");

const normalized = normalizeEmail(email);
const user = await findById<{ emailVerified?: boolean }>(Collections.users, normalized);
if (!user) {
  console.error(`Kein Konto für ${normalized}.`);
  await closeDb();
  process.exit(1);
}

const issued = await issueAuthLink(normalized, "passwort_reset", { issuedBy: "skript" });
console.log(`Konto: ${normalized} (bestätigt: ${user.emailVerified ? "ja" : "nein"})`);
console.log(`Versand: ${issued.delivery.status}`);
console.log(`Gültig bis: ${issued.expiresAt}`);
console.log(`Link: ${issued.url}`);
await closeDb();
