import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { randomUUID } from "node:crypto";
import { appBaseUrl } from "./app-url";

/**
 * Dateiablage im R2-Bucket der Anwendung (Binding `BUCKET`).
 *
 * Abgelegte Dateien werden unter `/api/dateien/<schlüssel>` ausgeliefert. Der
 * Schlüssel ist zufällig; die Adresse muss ohne Anmeldung abrufbar sein, weil
 * der Transkriptionsdienst die Audiodatei selbst abholt. Ältere Datensätze
 * verweisen noch auf assets.clawcorp.ai, diese Adressen werden unverändert
 * weiter gelesen.
 */

export const FILE_ROUTE = "/api/dateien/";

type StoredObject = {
  body: ReadableStream;
  size: number;
  range?: { offset?: number; length?: number; suffix?: number };
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
};

type Bucket = {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  get(key: string, options?: { range?: Headers }): Promise<StoredObject | null>;
};

function bucket(): Bucket {
  const binding = (getCloudflareContext().env as { BUCKET?: Bucket }).BUCKET;
  if (!binding) throw new Error("Der Dateispeicher ist nicht eingerichtet (BUCKET).");
  return binding;
}

export type UploadResult = { url: string; bytes: number };

/** Legt Rohbytes ab und liefert die dauerhafte Adresse in dieser Anwendung. */
export async function storeFile(bytes: Uint8Array, contentType: string): Promise<UploadResult> {
  const key = randomUUID();
  await bucket().put(key, bytes, { httpMetadata: { contentType } });
  return { url: `${await appBaseUrl()}${FILE_ROUTE}${key}`, bytes: bytes.byteLength };
}

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Schlüssel einer von `storeFile` erzeugten Adresse, sonst `null`. */
export function storageKeyOf(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, "http://intern").pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(FILE_ROUTE)) return null;
  const key = path.slice(FILE_ROUTE.length);
  return isStorageKey(key) ? key : null;
}

/**
 * Antwort für eine abgelegte Datei, mit Unterstützung für Bereichsanfragen.
 * `null`, wenn der Schlüssel nicht existiert.
 */
export async function storedFileResponse(
  key: string,
  options: { range: string | null; contentType?: string; headers?: Record<string, string> },
): Promise<Response | null> {
  const object = await bucket().get(
    key,
    options.range ? { range: new Headers({ range: options.range }) } : undefined,
  );
  if (!object) return null;

  const headers = new Headers(options.headers);
  headers.set(
    "content-type",
    options.contentType ?? object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  headers.set("accept-ranges", "bytes");

  const range = object.range;
  if (options.range && range) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix ?? range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/** Lädt eine abgelegte Datei als Rohbytes, aus dem Bucket oder von ihrer Adresse. */
export async function readFileBytes(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const key = storageKeyOf(url);
  let binding: Bucket | null = null;
  try {
    binding = key ? bucket() : null;
  } catch {
    // Ausserhalb des Workers (Skripte) gibt es kein Binding; dann über die Adresse lesen.
  }
  if (key && binding) {
    const object = await binding.get(key);
    if (!object) throw new Error("Die Audiodatei wurde im Speicher nicht gefunden.");
    return new Uint8Array(await object.arrayBuffer());
  }

  const res = await fetch(url, {
    cache: "no-store",
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`Die Audiodatei konnte nicht gelesen werden (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}
