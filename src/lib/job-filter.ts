/**
 * Filter, Sortierung und Seiten der Auftragstabelle im Admin-Bereich. Ohne
 * Server-Abhängigkeiten, damit Seite, Tabelle (Client) und `listJobs`
 * dieselben Schlüssel verwenden. Alles steht in der URL.
 */
import type { TranscriptionStatus } from "./types";

/** Sortierbare Spalten; die Werte stehen so in der URL (`?sort=…&dir=…`). */
export const JOB_SORT_KEYS = [
  "datei",
  "status",
  "erstellt",
  "gestartet",
  "beendet",
  "versuche",
  "meldung",
] as const;
export type JobSortKey = (typeof JOB_SORT_KEYS)[number];
export type JobSortDir = "asc" | "desc";

/** Spalten, die beim ersten Klick absteigend sortieren (neuste und meiste zuerst). */
export const JOB_DESC_FIRST: ReadonlySet<JobSortKey> = new Set<JobSortKey>([
  "erstellt",
  "gestartet",
  "beendet",
  "versuche",
]);

export function isJobSortKey(value: string): value is JobSortKey {
  return (JOB_SORT_KEYS as readonly string[]).includes(value);
}

export const JOB_STATUSES: { value: TranscriptionStatus; label: string }[] = [
  { value: "in_arbeit", label: "In Verarbeitung" },
  { value: "wartend", label: "Wartend" },
  { value: "fehlgeschlagen", label: "Fehlgeschlagen" },
  { value: "abgeschlossen", label: "Abgeschlossen" },
  { value: "ohne_sprache", label: "Keine Sprache" },
];

export const JOB_PAGE_SIZES = ["10", "25", "50", "100"] as const;
const DEFAULT_PAGE_SIZE = "25";

export type JobFilterValues = {
  status: TranscriptionStatus[];
  datei: string;
  uploader: string;
  erstelltVon: string;
  erstelltBis: string;
  gestartetVon: string;
  gestartetBis: string;
  beendetVon: string;
  beendetBis: string;
  versucheMin: string;
  meldung: boolean;
  modell: string;
  /** `null` = Standardreihenfolge: laufend, dann wartend in Bearbeitungsreihenfolge, dann neuste. */
  sort: { key: JobSortKey; dir: JobSortDir } | null;
  pageSize: string;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

function all(params: SearchParams, key: string): string[] {
  const value = params[key];
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((entry) => entry.split(","));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (value: string) => (DATE.test(value) ? value : "");

/**
 * Parameter der Auftragstabelle. `auftragsmodell` heisst so, weil `modell`
 * auf derselben Seite bereits die Transkriptliste filtert.
 */
export function parseJobFilters(params: SearchParams): JobFilterValues {
  const sortKey = first(params, "sort");
  const dir = first(params, "dir");
  const statuses = new Set(all(params, "status"));
  const versuche = first(params, "versucheMin");
  const pageSize = first(params, "pageSize");
  return {
    status: JOB_STATUSES.map((entry) => entry.value).filter((value) => statuses.has(value)),
    datei: first(params, "datei").slice(0, 200),
    uploader: first(params, "uploader"),
    erstelltVon: date(first(params, "erstelltVon")),
    erstelltBis: date(first(params, "erstelltBis")),
    gestartetVon: date(first(params, "gestartetVon")),
    gestartetBis: date(first(params, "gestartetBis")),
    beendetVon: date(first(params, "beendetVon")),
    beendetBis: date(first(params, "beendetBis")),
    versucheMin: /^\d{1,3}$/.test(versuche) && Number(versuche) > 0 ? String(Number(versuche)) : "",
    meldung: first(params, "meldung") === "1",
    modell: first(params, "auftragsmodell").slice(0, 100),
    sort: isJobSortKey(sortKey)
      ? {
          key: sortKey,
          dir: dir === "asc" || dir === "desc" ? dir : JOB_DESC_FIRST.has(sortKey) ? "desc" : "asc",
        }
      : null,
    pageSize: (JOB_PAGE_SIZES as readonly string[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    page: Math.max(1, Number.parseInt(first(params, "page"), 10) || 1),
  };
}

/** Zahl der gesetzten Filter (ohne Sortierung und Seite). */
export function activeJobFilterCount(values: JobFilterValues): number {
  return [
    values.status.length > 0,
    values.datei,
    values.uploader,
    values.erstelltVon || values.erstelltBis,
    values.gestartetVon || values.gestartetBis,
    values.beendetVon || values.beendetBis,
    values.versucheMin,
    values.meldung,
    values.modell,
  ].filter(Boolean).length;
}

/** Schlüssel der Auftragstabelle; andere Parameter der Seite bleiben unberührt. */
export const JOB_PARAM_KEYS = [
  "status",
  "datei",
  "uploader",
  "erstelltVon",
  "erstelltBis",
  "gestartetVon",
  "gestartetBis",
  "beendetVon",
  "beendetBis",
  "versucheMin",
  "meldung",
  "auftragsmodell",
  "sort",
  "dir",
  "pageSize",
  "page",
] as const;

/** URL-Parameter der Auftragstabelle; Standardwerte bleiben weg. */
export function jobQueryParams(values: JobFilterValues, page = values.page): [string, string][] {
  const entries: [string, string][] = [];
  if (values.status.length > 0) entries.push(["status", values.status.join(",")]);
  if (values.datei) entries.push(["datei", values.datei]);
  if (values.uploader) entries.push(["uploader", values.uploader]);
  for (const key of [
    "erstelltVon",
    "erstelltBis",
    "gestartetVon",
    "gestartetBis",
    "beendetVon",
    "beendetBis",
    "versucheMin",
  ] as const) {
    if (values[key]) entries.push([key, values[key]]);
  }
  if (values.meldung) entries.push(["meldung", "1"]);
  if (values.modell) entries.push(["auftragsmodell", values.modell]);
  if (values.sort) entries.push(["sort", values.sort.key], ["dir", values.sort.dir]);
  if (values.pageSize !== DEFAULT_PAGE_SIZE) entries.push(["pageSize", values.pageSize]);
  if (page > 1) entries.push(["page", String(page)]);
  return entries;
}
