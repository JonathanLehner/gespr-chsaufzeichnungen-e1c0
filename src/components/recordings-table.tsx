"use client";

import { Fragment, useMemo, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { describeTranscriptionError } from "@/lib/transcription-errors";
import { formatDateTime, formatDuration } from "@/lib/time";
import { DEFAULT_SORT, DESC_FIRST, isSortKey, type SortDir, type SortKey } from "@/lib/recording-sort";
import type { RecordingRow } from "@/lib/recordings";
import { RatingValue, StatusBadge } from "@/components/status";
import {
  DeletionFlagBadge,
  DeletionFlagButton,
  DeletionFlagProvider,
} from "@/components/deletion-flag";
import { RetryTranscriptionButton } from "@/components/retry-transcription-button";
import {
  TranscriptionStatusLine,
  type TranscriptionTiming,
} from "@/components/transcription-status-line";

export type TableRow = { transcriptionTiming: TranscriptionTiming } & Pick<
  RecordingRow,
  | "_id"
  | "callAtUtc"
  | "originalFilename"
  | "callerName"
  | "metadataSource"
  | "phoneNumber"
  | "callNumber"
  | "durationMs"
  | "uploadedByName"
  | "ratingAverage"
  | "ratingCount"
  | "transcriptionStatus"
  | "transcriptionError"
  | "transcriptionFinishedAt"
  | "deletionFlagged"
  | "deletionFlaggedBy"
  | "hits"
  | "matchedFields"
>;

type ColumnId = SortKey | "aktion";

const features = tableFeatures({ rowSortingFeature });

/** Zellattribute je Spalte; `data-cell` steuert die Kartenansicht unter 700 px. */
const CELL_PROPS: Record<ColumnId, { className: string; dataCell: string }> = {
  zeitpunkt: { className: "td font-medium min-[700px]:whitespace-nowrap", dataCell: "zeitpunkt" },
  anrufer: { className: "td", dataCell: "anrufer" },
  telefon: { className: "td font-mono text-[12px] min-[700px]:whitespace-nowrap", dataCell: "wert" },
  anrufnr: { className: "td font-mono text-[12px] min-[700px]:whitespace-nowrap", dataCell: "wert" },
  dauer: { className: "td font-mono text-[12px] min-[700px]:whitespace-nowrap", dataCell: "wert" },
  hochgeladen_von: { className: "td", dataCell: "wert" },
  bewertung: { className: "td", dataCell: "wert" },
  transkription: { className: "td", dataCell: "wert" },
  loeschmarkierung: { className: "td", dataCell: "wert" },
  aktion: { className: "td", dataCell: "aktion" },
};

/** Wert je Spalte; Table braucht einen Accessor, damit die Spalte sortierbar ist. */
const ACCESSORS: Record<SortKey, (row: TableRow) => string | number | boolean | null> = {
  zeitpunkt: (row) => row.callAtUtc,
  anrufer: (row) => row.callerName,
  telefon: (row) => row.phoneNumber,
  anrufnr: (row) => row.callNumber,
  dauer: (row) => row.durationMs,
  hochgeladen_von: (row) => row.uploadedByName,
  bewertung: (row) => row.ratingAverage,
  transkription: (row) => row.transcriptionStatus,
  loeschmarkierung: (row) => row.deletionFlagged,
};

function sortable(
  id: SortKey,
  header: string,
  cell: (row: TableRow) => ReactNode,
): ColumnDef<typeof features, TableRow> {
  return {
    id,
    header,
    accessorFn: ACCESSORS[id],
    cell: ({ row }) => cell(row.original),
    enableSorting: true,
    sortDescFirst: DESC_FIRST.has(id),
  };
}

/** Beschriftete Zeile in der Kartenansicht; ab 700 px trägt der Tabellenkopf die Beschriftung. */
function labelled(label: string, content: ReactNode) {
  return (
    <>
      <CardLabel>{label}</CardLabel>
      <span className="block">{content}</span>
    </>
  );
}

function buildColumns(renderedAt: number): ColumnDef<typeof features, TableRow>[] {
  return [
  sortable("zeitpunkt", "Gesprächs\u00adzeitpunkt (CET)", (row) => (
    <>
      <Link href={`/aufnahmen/${row._id}`} className="text-petrol hover:underline">
        {formatDateTime(row.callAtUtc)}
      </Link>
      {/* Gekürzt, damit die Tabelle nicht nach rechts überläuft; ein Klick
          klappt den vollen Dateinamen auf. */}
      <details className="group mt-0.5 font-mono text-[12px] text-ink-faint">
        <summary
          className="block cursor-pointer list-none truncate hover:text-ink-soft group-open:whitespace-normal group-open:break-all min-[700px]:max-w-[12rem] [&::-webkit-details-marker]:hidden"
          title={row.originalFilename}
        >
          {row.originalFilename}
        </summary>
      </details>
    </>
  )),
  sortable("anrufer", "Anrufer", (row) => (
    <>
      <span className="font-medium text-ink">{row.callerName}</span>
      {row.metadataSource === "manuell" && (
        <span className="ml-1.5 badge bg-petrol-soft text-petrol">manuell erfasst</span>
      )}
    </>
  )),
  sortable("telefon", "Telefon\u00adnummer", (row) => labelled("Telefonnummer", row.phoneNumber || "–")),
  sortable("anrufnr", "Anrufnr.", (row) => labelled("Anrufnr.", row.callNumber || "–")),
  sortable("dauer", "Dauer", (row) => labelled("Dauer", formatDuration(row.durationMs))),
  sortable("hochgeladen_von", "Hochgeladen von", (row) =>
    labelled("Hochgeladen von", row.uploadedByName),
  ),
  sortable("bewertung", "Bewertung", (row) =>
    labelled("Bewertung", <RatingValue average={row.ratingAverage} count={row.ratingCount} />),
  ),
  sortable("transkription", "Tran\u00adskription", (row) =>
    labelled(
      "Transkription",
      <>
        <StatusBadge status={row.transcriptionStatus} />
        <TranscriptionStatusLine
          timing={row.transcriptionTiming}
          renderedAt={renderedAt}
          className="mt-0.5 block text-[12px] leading-snug text-ink-soft tabular-nums min-[700px]:max-w-[220px]"
        />
        {row.transcriptionStatus === "fehlgeschlagen" && (
          <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint min-[700px]:max-w-[220px]">
            {describeTranscriptionError(row.transcriptionError).message}
          </span>
        )}
        {row.transcriptionStatus === "ohne_sprache" && (
          <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint min-[700px]:max-w-[220px]">
            Ausgewertet, aber nichts Gesprochenes zu hören.
          </span>
        )}
      </>,
    ),
  ),
  sortable("loeschmarkierung", "Lösch\u00admarkierung", (row) =>
    labelled(
      "Löschmarkierung",
      <DeletionFlagBadge flagged={row.deletionFlagged} flaggedBy={row.deletionFlaggedBy} />,
    ),
  ),
  {
    id: "aktion",
    header: "Aktion",
    enableSorting: false,
    cell: ({ row: { original: row } }) => (
      <div className="flex flex-wrap items-start gap-2 min-[700px]:flex-col min-[700px]:gap-1">
        <Link href={`/aufnahmen/${row._id}`} className="btn btn-ghost">
          Öffnen
        </Link>
        {row.transcriptionStatus === "fehlgeschlagen" && (
          <RetryTranscriptionButton key={row.transcriptionFinishedAt ?? "neu"} recordingId={row._id} />
        )}
        <DeletionFlagButton recordingId={row._id} flagged={row.deletionFlagged} />
      </div>
    ),
  },
  ];
}

/**
 * Aufnahmeliste. Sortiert wird auf dem Server über den ganzen gefilterten
 * Bestand (`manualSorting`); die Tabelle schreibt nur `sort` und `dir` in die
 * URL und springt dabei auf Seite 1 zurück.
 */
export function RecordingsTable({
  rows,
  sortKey,
  sortDir,
  query,
  renderedAt,
}: {
  rows: TableRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  query: string;
  /** Zeitpunkt des Server-Renders, Bezug für relative Zeitangaben. */
  renderedAt: number;
}) {
  const columns = useMemo(() => buildColumns(renderedAt), [renderedAt]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const sorting: SortingState = [{ id: sortKey, desc: sortDir === "desc" }];

  function onSortingChange(updater: Updater<SortingState>) {
    const next = (typeof updater === "function" ? updater(sorting) : updater)[0];
    if (!next || !isSortKey(next.id)) return;
    const dir: SortDir = next.desc ? "desc" : "asc";
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    if (next.id === DEFAULT_SORT.key && dir === DEFAULT_SORT.dir) {
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", next.id);
      params.set("dir", dir);
    }
    const search = params.toString();
    startTransition(() => router.push(search ? `${pathname}?${search}` : pathname));
  }

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row._id,
    state: { sorting },
    onSortingChange,
    manualSorting: true,
    enableMultiSort: false,
    enableSortingRemoval: false,
  });

  return (
    <div className="card overflow-hidden max-[699px]:border-0 max-[699px]:bg-transparent">
      <div className="overflow-x-auto">
        <table
          className={`stack-cards w-full min-w-0 border-collapse transition-opacity min-[700px]:min-w-[1180px] min-[700px]:[&_.td]:px-2 min-[700px]:[&_th:not(:has(button))]:px-2 ${pending ? "opacity-60" : ""}`}
          aria-busy={pending || undefined}
        >
          <thead className="bg-canvas">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const column = header.column;
                  if (!column.getCanSort()) {
                    return (
                      <th key={header.id} className="th">
                        <table.FlexRender header={header} />
                      </th>
                    );
                  }
                  const sorted = column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="th p-0"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={column.getToggleSortingHandler()}
                        className={`inline-flex w-full items-center gap-0.5 whitespace-normal px-3 py-2 text-left uppercase tracking-[inherit] hover:text-ink min-[700px]:px-2 ${sorted ? "text-ink" : ""}`}
                      >
                        <table.FlexRender header={header} />
                        <SortArrow direction={sorted} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="td text-center text-ink-soft" colSpan={columns.length} data-cell="leer">
                  Keine Aufnahme entspricht den gewählten Filtern.{" "}
                  <Link href="/aufnahmen" className="font-semibold text-petrol hover:underline">
                    Filter zurücksetzen
                  </Link>
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => {
              const data = row.original;
              return (
                <Fragment key={row.id}>
                  <tr className="min-[700px]:hover:bg-canvas/60">
                    {/* Badge und Schaltfläche teilen sich den Zustand, damit die Zeile
                        sofort nach dem Klick umschaltet und nicht erst nach dem Neuladen. */}
                    <DeletionFlagProvider recordingId={data._id} flagged={data.deletionFlagged}>
                      {row.getAllCells().map((cell) => {
                        const props = CELL_PROPS[cell.column.id as ColumnId];
                        return (
                          <td key={cell.id} className={props.className} data-cell={props.dataCell}>
                            <table.FlexRender cell={cell} />
                          </td>
                        );
                      })}
                    </DeletionFlagProvider>
                  </tr>
                  {(data.hits.length > 0 || data.matchedFields.length > 0) && (
                    <tr className="bg-petrol-soft/40" data-row="treffer">
                      <td className="td" colSpan={columns.length} data-cell="treffer">
                        {data.matchedFields.length > 0 && (
                          <p className="text-[12px] text-ink-soft">
                            Treffer in: <strong>{data.matchedFields.join(", ")}</strong>
                          </p>
                        )}
                        {data.hits.map((hit, index) => (
                          <p key={index} className="mt-1 text-[12.5px] leading-relaxed text-ink">
                            <Link
                              href={`/aufnahmen/${data._id}?t=${hit.startMs}&q=${encodeURIComponent(query)}`}
                              className="mr-2 font-mono text-[11px] font-semibold text-petrol hover:underline"
                            >
                              {formatDuration(hit.startMs)}
                            </Link>
                            <span className="text-ink-faint">{hit.speaker}: </span>
                            {hit.before}
                            <mark>{hit.match}</mark>
                            {hit.after}
                            {hit.after.length >= 80 ? " …" : ""}
                          </p>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortArrow({ direction }: { direction: false | SortDir }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 12"
      className={`h-3 w-2 flex-none ${direction ? "text-petrol" : "text-ink-faint opacity-60"}`}
      fill="currentColor"
    >
      {direction !== "desc" && <path d={direction ? "M5 1 9 7H1z" : "M5 0 8.5 4.5h-7z"} />}
      {direction !== "asc" && <path d={direction ? "M5 11 1 5h8z" : "M5 12 1.5 7.5h7z"} />}
    </svg>
  );
}

/** Spaltenbezeichnung innerhalb der Karte; unterhalb von 700 px ersetzt sie den Tabellenkopf. */
function CardLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none text-[11px] font-bold uppercase tracking-[0.06em] text-ink-soft min-[700px]:hidden">
      {children}
    </span>
  );
}
