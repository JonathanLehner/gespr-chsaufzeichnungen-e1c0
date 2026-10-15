import type { NextRequest } from "next/server";
import { isStorageKey, storedFileResponse } from "@/lib/storage";

/**
 * Liefert eine abgelegte Datei aus. Die Adresse ist ohne Anmeldung abrufbar,
 * damit der Transkriptionsdienst die Audiodatei holen kann; der Schlüssel ist
 * zufällig und nicht erratbar.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!isStorageKey(key)) return new Response("Datei nicht gefunden.", { status: 404 });

  const response = await storedFileResponse(key, {
    range: request.headers.get("range"),
    headers: { "cache-control": "private, max-age=3600" },
  });
  return response ?? new Response("Datei nicht gefunden.", { status: 404 });
}
