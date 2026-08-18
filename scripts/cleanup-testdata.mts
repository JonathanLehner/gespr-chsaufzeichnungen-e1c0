/**
 * Entfernt die Daten, die der automatische Browsertest hinterlässt:
 * Testaufnahmen, Testkonten sowie deren Kommentare und Bewertungen.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/cleanup-testdata.mts
 */
import { Collections, deleteMany, findMany } from "../src/lib/db";
import { hardDeleteRecording, refreshRatingSummary } from "../src/lib/recordings";
import type { Comment, Rating, Recording, User } from "../src/lib/types";

const TEST_CALLERS = ["Ziegler", "Zimmermann", "Kunz"];
// Konten der automatischen Prüfläufe: die Registrierung legt sie unter
// `pia.roth+…` an, ältere Läufe und Admin-Prüfkonten unter `pruefung…`.
const TEST_ACCOUNT = /^(pia\.roth\+|pruefung[.+])/i;

const recordings = await findMany<Recording>(Collections.recordings, {});
for (const recording of recordings) {
  if (!TEST_CALLERS.some((name) => recording.callerName.includes(name))) continue;
  await hardDeleteRecording(recording._id);
  console.log(`Testaufnahme entfernt: ${recording.originalFilename}`);
}

const comments = await findMany<Comment>(Collections.comments, {});
for (const comment of comments) {
  if (!TEST_ACCOUNT.test(comment.authorEmail) && !comment.text.startsWith("Automatische Prüfung")) {
    continue;
  }
  await deleteMany(Collections.comments, { _id: comment._id });
  console.log(`Testkommentar entfernt: ${comment.authorEmail}`);
}

const ratings = await findMany<Rating>(Collections.ratings, {});
const touched = new Set<string>();
for (const rating of ratings) {
  if (!TEST_ACCOUNT.test(rating.authorEmail)) continue;
  await deleteMany(Collections.ratings, { _id: rating._id });
  touched.add(rating.recordingId);
  console.log(`Testbewertung entfernt: ${rating.authorEmail}`);
}
for (const recordingId of touched) {
  await refreshRatingSummary(recordingId);
  console.log(`Bewertungsdurchschnitt neu berechnet: ${recordingId}`);
}

const users = await findMany<User>(Collections.users, {});
for (const user of users) {
  if (!TEST_ACCOUNT.test(user.email)) continue;
  await deleteMany(Collections.users, { _id: user._id });
  await deleteMany(Collections.sessions, { userId: user._id });
  await deleteMany(Collections.tokens, { email: user._id });
  await deleteMany(Collections.mailOutbox, { to: user._id });
  console.log(`Testkonto entfernt: ${user.email}`);
}

console.log("Aufräumen abgeschlossen.");
