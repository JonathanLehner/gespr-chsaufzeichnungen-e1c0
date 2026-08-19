import "server-only";
import { normalizeEmail } from "./auth";
import { Collections, findById, updateMany, updateOne } from "./db";
import { nameProblem, normalizeName } from "./profile-name";
import { invalidateRecordingCache } from "./recordings";
import type { User } from "./types";

/**
 * Anzeigename des eigenen Kontos.
 *
 * Der Name steht nicht nur im Kopfbereich, sondern ist in Kommentaren,
 * Bewertungen und an hochgeladenen Aufnahmen mitgespeichert. Diese Kopien
 * werden beim Umbenennen mitgezogen, damit nicht zwei Schreibweisen derselben
 * Person nebeneinander stehen bleiben.
 */

export { nameProblem, normalizeName } from "./profile-name";

export type RenameResult =
  | { ok: true; name: string; changed: boolean; updatedEntries: number }
  | { ok: false; error: string };

/**
 * Setzt den Anzeigenamen eines Kontos und gleicht die mitgespeicherten Namen
 * an. Der Aufruf ist wiederholbar: Ist der Name bereits gesetzt, wird nichts
 * geschrieben und `changed` bleibt falsch.
 */
export async function renameUser(email: string, rawName: string): Promise<RenameResult> {
  const problem = nameProblem(rawName);
  if (problem) return { ok: false, error: problem };

  const address = normalizeEmail(email);
  const name = normalizeName(rawName);
  const user = await findById<User>(Collections.users, address);
  if (!user) return { ok: false, error: "Zu diesem Konto besteht kein Datensatz mehr." };
  if (user.name === name) return { ok: true, name, changed: false, updatedEntries: 0 };

  await updateOne(Collections.users, { _id: address }, { $set: { name } });

  const [comments, ratings, recordings] = await Promise.all([
    updateMany(Collections.comments, { authorEmail: address }, { $set: { authorName: name } }),
    updateMany(Collections.ratings, { authorEmail: address }, { $set: { authorName: name } }),
    updateMany(
      Collections.recordings,
      { uploadedByEmail: address },
      { $set: { uploadedByName: name } },
    ),
  ]);
  invalidateRecordingCache();

  return {
    ok: true,
    name,
    changed: true,
    updatedEntries: comments.modified + ratings.modified + recordings.modified,
  };
}
