/**
 * Texte zum Fortschritt einer laufenden Transkription. Reine Funktionen, im
 * Browser und auf dem Server nutzbar.
 */
import { msPerChunk, remainingMs, type ProgressFields } from "../../transcriber/shared/queue";

export { msPerChunk, remainingMs };

const number = (value: number, digits = 1) =>
  value.toLocaleString("de-CH", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** „vor 12 s“, ab einer Minute „vor 3 Min.“. */
export function formatSecondsAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "–";
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `vor ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  return `vor ${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
}

/** Verstrichene Zeit: „45 s“, „3 Min. 05 s“, „1 Std. 12 Min.“. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} Min. ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
}

/** „ca. 3 Min. verbleibend“; unter einer Minute „weniger als 1 Min. verbleibend“. */
export function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return "weniger als 1 Min. verbleibend";
  if (minutes < 60) return `ca. ${minutes} Min. verbleibend`;
  return `ca. ${Math.floor(minutes / 60)} Std. ${minutes % 60} Min. verbleibend`;
}

/** Gemessene Geschwindigkeit: „1.4 Abschnitte/Min.“; `null` ohne Messung. */
export function formatChunkRate(fields: ProgressFields): string | null {
  const perChunk = msPerChunk(fields);
  if (perChunk === null) return null;
  return `${number(60_000 / perChunk)} Abschnitte/Min.`;
}

/** Abschnitt in Arbeit (1-basiert), höchstens die Gesamtzahl. */
export function currentChunk(fields: Pick<ProgressFields, "progressDone" | "progressTotal">): number {
  const total = fields.progressTotal ?? 0;
  return Math.min((fields.progressDone ?? 0) + 1, total);
}

/** Abschnitte lassen sich nur zählen, wenn der Auftrag in mehreren Anfragen läuft. */
export function hasChunkProgress(fields: Pick<ProgressFields, "progressTotal">): boolean {
  return (fields.progressTotal ?? 0) > 1;
}
