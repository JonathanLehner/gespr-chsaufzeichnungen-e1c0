/**
 * Prüft, dass eine Namensänderung die mitgespeicherten Kopien mitzieht.
 *
 * Der Anzeigename steht nicht nur am Konto, sondern auch an jedem Kommentar,
 * jeder Bewertung und jeder hochgeladenen Aufnahme. Bleibt eine dieser Kopien
 * stehen, stünden zwei Schreibweisen derselben Person nebeneinander – genau
 * das, was die Änderung beheben soll.
 *
 * Der Lauf legt ein Prüfkonto mit je einem Eintrag an und räumt alles wieder ab.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/check-namensabgleich.mts
 */
import { Collections, deleteById, findById, insertOne } from "../src/lib/db";
import { renameUser } from "../src/lib/profile";
import type { Comment, Rating, Recording, User } from "../src/lib/types";

const EMAIL = `pruefung.namensabgleich@immotrustag.ch`;
const ALT = "Alter Prüfname";
const NEU = "Neuer Prüfname";
const RECORDING_ID = `rec_pruefung_namensabgleich`;
const COMMENT_ID = `kommentar_pruefung_namensabgleich`;
const RATING_ID = `${RECORDING_ID}:${EMAIL}`;

const results: { label: string; ok: boolean }[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "OK  " : "FEHL"} ${label}${detail ? ` – ${detail}` : ""}`);
};

async function aufraeumen() {
  await Promise.all([
    deleteById(Collections.users, EMAIL),
    deleteById(Collections.recordings, RECORDING_ID),
    deleteById(Collections.comments, COMMENT_ID),
    deleteById(Collections.ratings, RATING_ID),
  ]);
}

await aufraeumen();
const now = new Date().toISOString();

try {
  await insertOne(Collections.users, {
    _id: EMAIL,
    email: EMAIL,
    name: ALT,
    role: "user",
    passwordHash: "scrypt$00$00",
    emailVerified: true,
    createdAt: now,
  });
  await insertOne(Collections.recordings, {
    _id: RECORDING_ID,
    originalFilename: "pruefung-namensabgleich.wav",
    audioUrl: "https://example.invalid/pruefung.wav",
    mimeType: "audio/wav",
    byteSize: 1,
    durationMs: 1000,
    callerName: "Ziegler, Pruefung",
    callerFirstName: "Pruefung",
    callerLastName: "Ziegler",
    phoneNumber: "",
    callNumber: "",
    callAtUtc: now,
    metadataSource: "manuell",
    templateVersion: null,
    uploadedByEmail: EMAIL,
    uploadedByName: ALT,
    uploadedAt: now,
    fingerprint: "pruefung-namensabgleich",
    transcriptionStatus: "wartend",
    transcriptionError: null,
    transcriptionStartedAt: null,
    transcriptionFinishedAt: null,
    transcriptionNextAttemptAt: null,
    transcriptionAttempts: 0,
    speakerCount: null,
    wordCount: null,
    deletionFlagged: false,
    deletionFlaggedBy: null,
    deletionFlaggedAt: null,
    deletionReason: null,
    ratingAverage: null,
    ratingCount: 0,
    bucket: 9999,
  });
  await insertOne(Collections.comments, {
    _id: COMMENT_ID,
    recordingId: RECORDING_ID,
    text: "Automatische Prüfung des Namensabgleichs.",
    authorEmail: EMAIL,
    authorName: ALT,
    createdAt: now,
    editedAt: null,
  });
  await insertOne(Collections.ratings, {
    _id: RATING_ID,
    recordingId: RECORDING_ID,
    score: 7,
    authorEmail: EMAIL,
    authorName: ALT,
    createdAt: now,
    updatedAt: now,
  });

  const result = await renameUser(EMAIL, `  ${NEU}   `);
  check("Umbenennen gemeldet als erfolgreich", result.ok, JSON.stringify(result));
  if (result.ok) {
    check("Mehrfache Leerzeichen zusammengefasst", result.name === NEU, result.name);
    check("Als Änderung erkannt", result.changed);
    check("Drei Kopien angepasst gemeldet", result.updatedEntries === 3, String(result.updatedEntries));
  }

  const [user, recording, comment, rating] = await Promise.all([
    findById<User>(Collections.users, EMAIL),
    findById<Recording>(Collections.recordings, RECORDING_ID),
    findById<Comment>(Collections.comments, COMMENT_ID),
    findById<Rating>(Collections.ratings, RATING_ID),
  ]);
  check("Konto trägt den neuen Namen", user?.name === NEU, user?.name);
  check("Aufnahme trägt den neuen Namen", recording?.uploadedByName === NEU, recording?.uploadedByName);
  check("Kommentar trägt den neuen Namen", comment?.authorName === NEU, comment?.authorName);
  check("Bewertung trägt den neuen Namen", rating?.authorName === NEU, rating?.authorName);
  check(
    "Anrufername aus dem Dateinamen bleibt unberührt",
    recording?.callerName === "Ziegler, Pruefung",
    recording?.callerName,
  );

  const nochmal = await renameUser(EMAIL, NEU);
  check(
    "Zweiter Aufruf mit demselben Namen schreibt nichts",
    nochmal.ok && !nochmal.changed && nochmal.updatedEntries === 0,
    JSON.stringify(nochmal),
  );

  const zuKurz = await renameUser(EMAIL, "A");
  check("Zu kurzer Name wird abgewiesen", !zuKurz.ok);
  const leer = await renameUser(EMAIL, "   ");
  check("Leerer Name wird abgewiesen", !leer.ok);
  const spitz = await renameUser(EMAIL, "Hans <script>");
  check("Name mit spitzen Klammern wird abgewiesen", !spitz.ok);
  const unveraendert = await findById<User>(Collections.users, EMAIL);
  check("Nach den Abweisungen steht der gültige Name", unveraendert?.name === NEU, unveraendert?.name);
} finally {
  await aufraeumen();
  console.log("Prüfdaten entfernt.");
}

const fehler = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - fehler.length}/${results.length} Prüfungen bestanden.`);
process.exit(fehler.length === 0 ? 0 : 1);
