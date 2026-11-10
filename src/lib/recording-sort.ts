/**
 * Sortierung der Aufnahmeliste. Ohne Server-Abhängigkeiten, damit Seite,
 * Tabelle (Client) und `listRecordings` dieselben Schlüssel verwenden.
 */

/** Sortierbare Spalten; die Werte stehen so in der URL (`?sort=…&dir=…`). */
export const SORT_KEYS = [
  "zeitpunkt",
  "anrufer",
  "telefon",
  "anrufnr",
  "dauer",
  "hochgeladen_von",
  "bewertung",
  "transkription",
  "loeschmarkierung",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "zeitpunkt", dir: "desc" };

/** Spalten, die beim ersten Klick absteigend sortieren (neuste, längste, höchste, markierte zuerst). */
export const DESC_FIRST: ReadonlySet<SortKey> = new Set<SortKey>([
  "zeitpunkt",
  "dauer",
  "bewertung",
  "loeschmarkierung",
]);

export function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

/** Liest `sort` und `dir` aus der URL; Unbekanntes fällt auf die Standardsortierung zurück. */
export function parseSort(sort: string, dir: string): { key: SortKey; dir: SortDir } {
  if (!isSortKey(sort)) return DEFAULT_SORT;
  if (dir === "asc" || dir === "desc") return { key: sort, dir };
  return { key: sort, dir: DESC_FIRST.has(sort) ? "desc" : "asc" };
}
