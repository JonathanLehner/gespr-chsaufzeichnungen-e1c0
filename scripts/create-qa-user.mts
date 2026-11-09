/**
 * Legt das QA-Konto an (bestätigt, Rolle „user“) oder aktualisiert es.
 * Staging und Produktion teilen sich eine Datenbank (`MONGODB_URI`).
 *
 *   QA_USER_EMAIL=... QA_USER_PASSWORD=... \
 *     npx tsx --env-file=.env.local --conditions=react-server scripts/create-qa-user.mts
 *
 * Besteht das Konto bereits, werden Passwort, Bestätigung und Rolle
 * aktualisiert. Das Passwort wird nie ausgegeben.
 */
const email = process.env.QA_USER_EMAIL;
const password = process.env.QA_USER_PASSWORD;
if (!process.env.MONGODB_URI || !email || !password) {
  console.error("MONGODB_URI, QA_USER_EMAIL und QA_USER_PASSWORD müssen gesetzt sein.");
  process.exit(1);
}

const { emailAllowed, isSuperuser, normalizeEmail } = await import("../src/lib/auth");
const { hashPassword } = await import("../src/lib/passwords");
const { Collections, insertUnique, updateOne, closeDb } = await import("../src/lib/db");

const normalized = normalizeEmail(email);
if (!emailAllowed(normalized) || isSuperuser(normalized)) {
  console.error("Die QA-Adresse muss eine normale @immotrustag.ch-Adresse sein.");
  process.exit(1);
}

const fields = {
  email: normalized,
  name: "QA",
  role: "user",
  passwordHash: await hashPassword(password),
  emailVerified: true,
};
const created = await insertUnique(Collections.users, {
  _id: normalized,
  ...fields,
  createdAt: new Date().toISOString(),
});
if (!created) await updateOne(Collections.users, { _id: normalized }, { $set: fields });
console.log(`QA-Konto ${created ? "angelegt" : "aktualisiert"}: ${normalized}`);
await closeDb();
