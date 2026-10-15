import "server-only";
import { headers } from "next/headers";

/**
 * Öffentliche Basis-URL der Anwendung. `APP_BASE_URL` hat Vorrang, sonst wird
 * der Host der laufenden Anfrage verwendet. Ohne Anfrage und ohne Vorgabe
 * bleibt sie leer.
 */
export async function appBaseUrl(): Promise<string> {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  try {
    const store = await headers();
    const host = store.get("x-forwarded-host") ?? store.get("host");
    if (!host) return "";
    const proto =
      store.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return "";
  }
}
