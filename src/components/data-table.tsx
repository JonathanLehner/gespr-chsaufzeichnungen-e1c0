"use client";

import { Fragment, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";

export type SortDir = "asc" | "desc";

export const dataTableFeatures = tableFeatures({ rowSortingFeature });
export type DataColumn<T extends RowData> = ColumnDef<typeof dataTableFeatures, T>;

/** Zellattribute je Spalte; `data-cell` steuert die Kartenansicht unter 700 px. */
export type CellProps = { className: string; dataCell: string };

/** Sortierbare Spalte; der Accessor ist nötig, damit TanStack Table sie als sortierbar führt. */
export function sortableColumn<T extends RowData>(
  id: string,
  header: string,
  accessor: (row: T) => string | number | boolean | null,
  cell: (row: T) => ReactNode,
  descFirst: boolean,
): DataColumn<T> {
  return {
    id,
    header,
    accessorFn: accessor,
    cell: ({ row }) => cell(row.original),
    enableSorting: true,
    sortDescFirst: descFirst,
  };
}

/** Beschriftete Zeile in der Kartenansicht; ab 700 px trägt der Tabellenkopf die Beschriftung. */
export function labelled(label: string, content: ReactNode) {
  return (
    <>
      <CardLabel>{label}</CardLabel>
      <span className="block">{content}</span>
    </>
  );
}

/**
 * Tabelle mit Kartenansicht unter 700 px. Sortiert, gefiltert und geblättert
 * wird auf dem Server (`manualSorting`); ein Klick auf einen Spaltenkopf
 * schreibt nur `sort` und `dir` in die URL und springt auf Seite 1 zurück.
 */
export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  cellProps,
  sort,
  defaultSort,
  isSortKey,
  empty,
  wrapCells,
  afterRow,
  tableClassName,
  keepScroll = false,
}: {
  columns: DataColumn<T>[];
  data: T[];
  getRowId: (row: T) => string;
  cellProps: Record<string, CellProps>;
  /** Aktive Sortierung; `null` = Standardreihenfolge ohne markierte Spalte. */
  sort: { key: string; dir: SortDir } | null;
  /** Sortierung, die ohne `sort`/`dir` in der URL gilt. */
  defaultSort: { key: string; dir: SortDir } | null;
  isSortKey: (value: string) => boolean;
  empty: ReactNode;
  /** Umschliesst die Zellen einer Zeile, etwa mit einem gemeinsamen Zustand. */
  wrapCells?: (row: T, cells: ReactNode) => ReactNode;
  /** Zusatzzeile unter einer Zeile, etwa Suchtreffer. */
  afterRow?: (row: T, colSpan: number) => ReactNode;
  /** Breite und Abstände der Tabelle ab 700 px. */
  tableClassName: string;
  /** Beim Sortieren an der Stelle bleiben (Tabelle mitten auf der Seite). */
  keepScroll?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const sorting: SortingState = sort ? [{ id: sort.key, desc: sort.dir === "desc" }] : [];

  function onSortingChange(updater: Updater<SortingState>) {
    const next = (typeof updater === "function" ? updater(sorting) : updater)[0];
    if (!next || !isSortKey(next.id)) return;
    const dir: SortDir = next.desc ? "desc" : "asc";
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    if (defaultSort && next.id === defaultSort.key && dir === defaultSort.dir) {
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", next.id);
      params.set("dir", dir);
    }
    const search = params.toString();
    const href = search ? `${pathname}?${search}` : pathname;
    startTransition(() => router.push(href, { scroll: !keepScroll }));
  }

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
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
          className={`stack-cards w-full min-w-0 border-collapse transition-opacity ${tableClassName} ${pending ? "opacity-60" : ""}`}
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
            {data.length === 0 && (
              <tr>
                <td className="td text-center text-ink-soft" colSpan={columns.length} data-cell="leer">
                  {empty}
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => {
              const cells = row.getAllCells().map((cell) => {
                const props = cellProps[cell.column.id];
                return (
                  <td key={cell.id} className={props.className} data-cell={props.dataCell}>
                    <table.FlexRender cell={cell} />
                  </td>
                );
              });
              return (
                <Fragment key={row.id}>
                  <tr className="min-[700px]:hover:bg-canvas/60">
                    {wrapCells ? wrapCells(row.original, cells) : cells}
                  </tr>
                  {afterRow?.(row.original, columns.length)}
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
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none text-[11px] font-bold uppercase tracking-[0.06em] text-ink-soft min-[700px]:hidden">
      {children}
    </span>
  );
}
