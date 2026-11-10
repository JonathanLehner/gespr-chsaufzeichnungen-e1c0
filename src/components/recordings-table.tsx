"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
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
import {
  DataTable,
  labelled,
  sortableColumn,
  type CellProps,
  type DataColumn,
} from "@/components/data-table";

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

/** Zellattribute je Spalte; `data-cell` steuert die Kartenansicht unter 700 px. */
const CELL_PROPS: Record<ColumnId, CellProps> = {
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

function sortable(id: SortKey, header: string, cell: (row: TableRow) => ReactNode): DataColumn<TableRow> {
  return sortableColumn(id, header, ACCESSORS[id], cell, DESC_FIRST.has(id));
}

function buildColumns(renderedAt: number): DataColumn<TableRow>[] {
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
 * Bestand; die Tabelle schreibt nur `sort` und `dir` in die URL.
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

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row._id}
      cellProps={CELL_PROPS}
      sort={{ key: sortKey, dir: sortDir }}
      defaultSort={DEFAULT_SORT}
      isSortKey={isSortKey}
      tableClassName="min-[700px]:min-w-[1180px] min-[700px]:[&_.td]:px-2 min-[700px]:[&_th:not(:has(button))]:px-2"
      empty={
        <>
          Keine Aufnahme entspricht den gewählten Filtern.{" "}
          <Link href="/aufnahmen" className="font-semibold text-petrol hover:underline">
            Filter zurücksetzen
          </Link>
        </>
      }
      // Badge und Schaltfläche teilen sich den Zustand, damit die Zeile
      // sofort nach dem Klick umschaltet und nicht erst nach dem Neuladen.
      wrapCells={(data, cells) => (
        <DeletionFlagProvider recordingId={data._id} flagged={data.deletionFlagged}>
          {cells}
        </DeletionFlagProvider>
      )}
      afterRow={(data, colSpan) =>
        (data.hits.length > 0 || data.matchedFields.length > 0) && (
          <tr className="bg-petrol-soft/40" data-row="treffer">
            <td className="td" colSpan={colSpan} data-cell="treffer">
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
        )
      }
    />
  );
}
