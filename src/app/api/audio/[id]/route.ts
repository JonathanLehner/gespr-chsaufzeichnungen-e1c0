import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { verifyPlaybackToken } from "@/lib/audio";
import { getRecording } from "@/lib/recordings";

export const runtime = "nodejs";

/**
 * Liefert die Audiodatei aus dem Objektspeicher aus. Die Ablage-URL bleibt
 * dadurch intern, der Zugriff erfordert eine gültige Sitzung und ein
 * kurzlebiges signiertes Token. Bereichsanfragen werden durchgereicht, damit
 * im Player gesprungen werden kann.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Nicht angemeldet.", { status: 401 });

  const { id } = await params;
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!verifyPlaybackToken(token, id, user.email)) {
    return new Response("Der Wiedergabe-Link ist abgelaufen. Bitte laden Sie die Seite neu.", {
      status: 403,
    });
  }

  const recording = await getRecording(id);
  if (!recording) return new Response("Aufnahme nicht gefunden.", { status: 404 });

  const range = request.headers.get("range");
  const upstream = await fetch(recording.audioUrl, {
    headers: range ? { Range: range } : undefined,
    cache: "no-store",
  });
  if (!upstream.ok && upstream.status !== 206) {
    return new Response("Die Audiodatei konnte nicht geladen werden.", { status: 502 });
  }

  const headers = new Headers();
  headers.set("content-type", recording.mimeType);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  headers.set(
    "content-disposition",
    `inline; filename="${encodeURIComponent(recording.originalFilename)}"`,
  );
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("content-range", contentRange);

  return new Response(upstream.body, { status: upstream.status, headers });
}
