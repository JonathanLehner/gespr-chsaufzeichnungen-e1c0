import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { MongoClient, MongoServerError, type Filter, type UpdateFilter } from "mongodb";

/**
 * Dünne Schicht über der MongoDB der Anwendung (`MONGODB_URI`).
 *
 * Die Verbindung gehört zur Anfrage, die sie geöffnet hat: Im Worker wird je
 * Anfrage ein eigener Client angelegt und nur innerhalb dieser Anfrage
 * wiederverwendet. Ausserhalb des Workers (Skripte, `next build`) gibt es
 * keinen Anfragekontext, dort genügt ein Client je Prozess.
 *
 * Die Anwendung vergibt für jedes Dokument eine eigene String-`_id`. Doppelte
 * `_id` erzeugen einen Fehler, was für Idempotenz genutzt wird.
 */

type StoredDoc = { _id: string; [field: string]: unknown };

const requestClients = new WeakMap<object, Promise<MongoClient>>();
let processClient: Promise<MongoClient> | null = null;

function connect(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI ist nicht gesetzt.");
  return new MongoClient(uri, { maxPoolSize: 5 }).connect();
}

function requestScope(): object | null {
  try {
    return getCloudflareContext();
  } catch {
    return null;
  }
}

async function collectionOf(name: string) {
  const scope = requestScope();
  let client: Promise<MongoClient>;
  if (scope) {
    client = requestClients.get(scope) ?? connect();
    requestClients.set(scope, client);
  } else {
    client = processClient ??= connect();
  }
  try {
    return (await client).db().collection<StoredDoc>(name);
  } catch (error) {
    // Ein fehlgeschlagener Verbindungsaufbau soll nicht für weitere Aufrufe hängen bleiben.
    if (scope) requestClients.delete(scope);
    else processClient = null;
    throw error;
  }
}

/** Schliesst die Verbindung eines Skripts, damit der Prozess enden kann. */
export async function closeDb(): Promise<void> {
  const client = processClient;
  processClient = null;
  if (client) await (await client).close();
}

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

/** Obergrenze für Abfragen, deren Aufrufer eine abgeschnittene Antwort erkennen. */
export const FIND_LIMIT = 100;

export async function findMany<T>(
  collection: string,
  filter: Record<string, unknown> = {},
  options: { limit?: number } = {},
): Promise<WithId<T>[]> {
  const cursor = (await collectionOf(collection)).find(filter as Filter<StoredDoc>);
  if (options.limit) cursor.limit(options.limit);
  return (await cursor.toArray()) as unknown as WithId<T>[];
}

export async function findOne<T>(
  collection: string,
  filter: Record<string, unknown>,
): Promise<WithId<T> | null> {
  const doc = await (await collectionOf(collection)).findOne(filter as Filter<StoredDoc>);
  return doc as unknown as WithId<T> | null;
}

export async function findById<T>(collection: string, id: string): Promise<WithId<T> | null> {
  if (!id) return null;
  return findOne<T>(collection, { _id: id });
}

export async function countDocuments(
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<number> {
  return (await collectionOf(collection)).countDocuments(filter as Filter<StoredDoc>);
}

/** Fügt ein Dokument ein. Liefert `false`, wenn die `_id` bereits existiert. */
export async function insertUnique(
  collection: string,
  document: Record<string, unknown> & { _id: string },
): Promise<boolean> {
  try {
    await (await collectionOf(collection)).insertOne(document);
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return false;
    throw error;
  }
}

export async function insertOne(
  collection: string,
  document: Record<string, unknown> & { _id: string },
): Promise<void> {
  await (await collectionOf(collection)).insertOne(document);
}

export async function insertMany(
  collection: string,
  documents: (Record<string, unknown> & { _id: string })[],
): Promise<void> {
  if (documents.length === 0) return;
  await (await collectionOf(collection)).insertMany(documents);
}

/** Aktualisiert ein Dokument und meldet, ob es tatsächlich verändert wurde. */
export async function updateOne(
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ matched: number; modified: number }> {
  const result = await (await collectionOf(collection)).updateOne(
    filter as Filter<StoredDoc>,
    update as UpdateFilter<StoredDoc>,
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

export async function updateMany(
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ matched: number; modified: number }> {
  const result = await (await collectionOf(collection)).updateMany(
    filter as Filter<StoredDoc>,
    update as UpdateFilter<StoredDoc>,
  );
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
  const result = await (await collectionOf(collection)).deleteOne({ _id: id } as Filter<StoredDoc>);
  return result.deletedCount;
}

export async function deleteMany(
  collection: string,
  filter: Record<string, unknown>,
): Promise<number> {
  const result = await (await collectionOf(collection)).deleteMany(filter as Filter<StoredDoc>);
  return result.deletedCount;
}
