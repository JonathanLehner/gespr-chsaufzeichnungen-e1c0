import "server-only";
import { platformDb, PlatformError } from "./platform";

/**
 * Dünne Schicht über der ClawCorp-Plattformdatenbank (MongoDB).
 *
 * Wichtige Eigenschaften des Endpunkts, an denen sich der Rest der Anwendung
 * ausrichtet:
 *  - Es gibt keine serverseitige Sortierung, Begrenzung oder Projektion.
 *  - `find` liefert höchstens 100 Dokumente.
 *  - Automatisch erzeugte ObjectIds lassen sich nicht wieder abfragen, deshalb
 *    vergibt die Anwendung für jedes Dokument eine eigene String-`_id`.
 *  - Doppelte `_id` erzeugen einen Fehler, was für Idempotenz genutzt wird.
 */

export const Collections = {
  users: "users",
  sessions: "sessions",
  tokens: "auth_tokens",
  mailOutbox: "mail_outbox",
  settings: "settings",
  recordings: "recordings",
  transcriptIndex: "transcript_index",
  transcriptParts: "transcript_parts",
  comments: "comments",
  ratings: "ratings",
  jobs: "jobs",
} as const;

export type WithId<T> = T & { _id: string };

export const FIND_LIMIT = 100;

export async function findMany<T>(
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<WithId<T>[]> {
  const result = await platformDb<WithId<T>[] | null>({ collection, action: "find", filter });
  return result ?? [];
}

export async function findOne<T>(
  collection: string,
  filter: Record<string, unknown>,
): Promise<WithId<T> | null> {
  return platformDb<WithId<T> | null>({ collection, action: "findOne", filter });
}

export async function findById<T>(collection: string, id: string): Promise<WithId<T> | null> {
  if (!id) return null;
  return findOne<T>(collection, { _id: id });
}

export async function countDocuments(
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<number> {
  return platformDb<number>({ collection, action: "countDocuments", filter });
}

/** Fügt ein Dokument ein. Liefert `false`, wenn die `_id` bereits existiert. */
export async function insertUnique(
  collection: string,
  document: Record<string, unknown> & { _id: string },
): Promise<boolean> {
  try {
    await platformDb({ collection, action: "insertOne", document });
    return true;
  } catch (error) {
    if (error instanceof PlatformError && error.detail.includes("E11000")) return false;
    throw error;
  }
}

export async function insertOne(
  collection: string,
  document: Record<string, unknown> & { _id: string },
): Promise<void> {
  await platformDb({ collection, action: "insertOne", document });
}

export async function insertMany(
  collection: string,
  documents: (Record<string, unknown> & { _id: string })[],
): Promise<void> {
  if (documents.length === 0) return;
  await platformDb({ collection, action: "insertMany", documents });
}

/** Aktualisiert ein Dokument und meldet, ob es tatsächlich verändert wurde. */
export async function updateOne(
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ matched: number; modified: number }> {
  const result = await platformDb<{ matchedCount: number; modifiedCount: number }>({
    collection,
    action: "updateOne",
    filter,
    update,
  });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

export async function updateMany(
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ matched: number; modified: number }> {
  const result = await platformDb<{ matchedCount: number; modifiedCount: number }>({
    collection,
    action: "updateMany",
    filter,
    update,
  });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/** Setzt Felder oder legt das Dokument an, falls es noch nicht existiert. */
export async function upsertById(
  collection: string,
  id: string,
  document: Record<string, unknown>,
): Promise<void> {
  // `_id` ist unveränderlich und darf nicht Teil von $set sein.
  const fields = { ...document };
  delete fields._id;
  const { matched } = await updateOne(collection, { _id: id }, { $set: fields });
  if (matched > 0) return;
  const created = await insertUnique(collection, { _id: id, ...fields });
  if (!created) {
    await updateOne(collection, { _id: id }, { $set: fields });
  }
}

/**
 * Erhöht einen Zähler und liefert den neuen Stand. Der Wert dient nur zur
 * gleichmässigen Verteilung der Aufnahmen auf Lesefenster (`bucket`), er muss
 * daher nicht streng eindeutig sein.
 */
export async function nextCounter(name: string): Promise<number> {
  const id = `counter_${name}`;
  const { matched } = await updateOne(Collections.settings, { _id: id }, { $inc: { value: 1 } });
  if (matched === 0) {
    const created = await insertUnique(Collections.settings, { _id: id, value: 1 });
    if (!created) await updateOne(Collections.settings, { _id: id }, { $inc: { value: 1 } });
  }
  const doc = await findById<{ value: number }>(Collections.settings, id);
  return doc?.value ?? 1;
}

export async function readCounter(name: string): Promise<number> {
  const doc = await findById<{ value: number }>(Collections.settings, `counter_${name}`);
  return doc?.value ?? 0;
}

export async function deleteById(collection: string, id: string): Promise<number> {
  const result = await platformDb<{ deletedCount: number }>({
    collection,
    action: "deleteOne",
    filter: { _id: id },
  });
  return result.deletedCount;
}

export async function deleteMany(
  collection: string,
  filter: Record<string, unknown>,
): Promise<number> {
  const result = await platformDb<{ deletedCount: number }>({
    collection,
    action: "deleteMany",
    filter,
  });
  return result.deletedCount;
}
