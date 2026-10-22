/**
 * Legt das QA-Konto für die Staging-Umgebung an (bestätigt, Rolle „user“).
 * Läuft nur gegen die Staging-Datenbank, nie gegen die Produktion.
 *
 *   STAGING_MONGODB_URI=... QA_USER_EMAIL=... QA_USER_PASSWORD=... \
 *     npx tsx --conditions=react-server scripts/create-qa-user.mts
 *
 * Absichtlich ohne `--env-file=.env.local`: Die Zieldatenbank muss ausdrücklich
 * als STAGING_MONGODB_URI übergeben werden. Besteht das Konto bereits, werden
 * Passwort, Bestätigung und Rolle aktualisiert. Das Passwort wird nie ausgegeben.
 */
const uri = process.env.STAGING_MONGODB_URI;
const email = process.env.QA_USER_EMAIL;
const password = process.env.QA_USER_PASSWORD;
if (!uri || !email || !password) {
  console.error("STAGING_MONGODB_URI, QA_USER_EMAIL und QA_USER_PASSWORD müssen gesetzt sein.");
  process.exit(1);
}
process.env.MONGODB_URI = uri;

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
  name: "QA (staging only)",
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
