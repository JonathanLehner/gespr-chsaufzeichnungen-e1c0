import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export type AudioMime = "audio/wav" | "audio/mpeg";

export const ACCEPTED_EXTENSIONS = [".wav", ".mp3"];
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filename.trim());
  return match ? match[0].toLowerCase() : "";
}

export function mimeFromExtension(filename: string): AudioMime | null {
  const extension = extensionOf(filename);
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  return null;
}

/**
 * Prüft die Dateisignatur. WAV beginnt mit einem RIFF/WAVE-Kopf, MP3 mit einem
 * ID3-Tag oder einem Frame-Sync. Vorangestellte Nullbytes werden übersprungen.
 */
export function detectAudioSignature(bytes: Uint8Array): AudioMime | null {
  if (bytes.length < 12) return null;
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));

  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";

  for (let index = 0; index < Math.min(bytes.length - 1, 4096); index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
      const layer = (bytes[index + 1] >> 1) & 0x03;
      const version = (bytes[index + 1] >> 3) & 0x03;
      if (layer !== 0 && version !== 1) return "audio/mpeg";
    }
    if (index > 0 && bytes[index] !== 0x00) break;
  }
  return null;
}

/** Liest die Spieldauer aus dem WAV-Kopf. MP3 wird im Browser vermessen. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return null;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (id === "data" && byteRate > 0) {
      const dataSize = Math.min(size, bytes.length - offset - 8);
      return Math.round((dataSize / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/* ------------------------------------------------- Kurzlebige Wiedergabe-URLs */

function secret(): string {
  return process.env.AUTH_SECRET ?? "entwicklungs-geheimnis";
}

const PLAYBACK_TTL_MS = 60 * 60 * 1000;

export function signPlaybackToken(recordingId: string, email: string): string {
  const expires = Date.now() + PLAYBACK_TTL_MS;
  const payload = `${recordingId}.${email}.${expires}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${expires}.${signature}`;
}

export function verifyPlaybackToken(token: string, recordingId: string, email: string): boolean {
  const [expiresRaw, signature] = token.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now() || !signature) return false;
  const expected = createHmac("sha256", secret())
    .update(`${recordingId}.${email}.${expires}`)
    .digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fingerabdruck zur Erkennung bereits vorhandener Dateien. */
export function fingerprintOf(filename: string, byteSize: number): string {
  return `${filename.trim().toLowerCase()}::${byteSize}`;
}
