"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { formatDateTimeWithSeconds } from "@/lib/time";
import {
  currentChunk,
  formatChunkRate,
  formatRemaining,
  formatSecondsAgo,
  hasChunkProgress,
  remainingMs,
} from "@/lib/progress-text";
import { STALE_LOCK_MS } from "../../transcriber/shared/queue";
import {
  JOB_DESC_FIRST,
  isJobSortKey,
  type JobSortDir,
  type JobSortKey,
} from "@/lib/job-filter";
import type { JobListRow } from "@/lib/transcription";
import { StatusBadge } from "@/components/status";
import { JobActionButton } from "@/components/queue-controls";
import {
  DataTable,
  labelled,
  sortableColumn,
  type CellProps,
  type DataColumn,
} from "@/components/data-table";

type ColumnId = JobSortKey | "aktion";

const DATE_CELL = "td text-[12px] tabular-nums min-[700px]:whitespace-nowrap";

const CELL_PROPS: Record<ColumnId, CellProps> = {
  datei: { className: "td", dataCell: "titel" },
  status: { className: "td", dataCell: "wert" },
  erstellt: { className: DATE_CELL, dataCell: "wert" },
  gestartet: { className: DATE_CELL, dataCell: "wert" },
  beendet: { className: DATE_CELL, dataCell: "wert" },
  versuche: { className: "td tabular-nums", dataCell: "wert" },
  meldung: { className: "td", dataCell: "text" },
  aktion: { className: "td", dataCell: "aktion" },
};

const ACCESSORS: Record<JobSortKey, (row: JobListRow) => string | number | null> = {
  datei: (row) => row.originalFilename,
  status: (row) => row.status,
  erstellt: (row) => row.createdAt,
  gestartet: (row) => row.startedAt,
  beendet: (row) => row.finishedAt,
  versuche: (row) => row.attempts ?? 0,
  meldung: (row) => row.lastError,
};

function sortable(id: JobSortKey, header: string, cell: (row: JobListRow) => ReactNode): DataColumn<JobListRow> {
  return sortableColumn(id, header, ACCESSORS[id], cell, JOB_DESC_FIRST.has(id));
}

/** Datum und Uhrzeit untereinander, damit die Tabelle bei 1280 px nicht überläuft. */
function Stamp({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-ink-faint">–</span>;
  const [day, time] = formatDateTimeWithSeconds(iso).split(", ");
  return (
    <span className="inline-block">
      {day}
      {time && (
        <>
          {" "}
          <span className="text-ink-soft min-[700px]:block">{time}</span>
        </>
      )}
    </span>
  );
}

function buildColumns(now: number): DataColumn<JobListRow>[] {
  return [
    sortable("datei", "Datei", (job) => (
      <>
        <Link
          href={`/aufnahmen/${job._id}`}
          className="font-mono text-[11.5px] text-petrol hover:underline wrap-anywhere"
        >
          {job.originalFilename}
        </Link>
        {job.priority && job.status === "wartend" ? (
          <span className="ml-1.5 badge bg-petrol-soft text-petrol">vorgezogen</span>
        ) : null}
        {job.background ? (
          <span className="ml-1.5 badge bg-canvas text-ink-soft">
            {job.kind === "neu_ausrichten" ? "Neu ausrichten" : "Neu transkribieren"}
          </span>
        ) : null}
        {(job.uploaderName || job.modelUsed) && (
          <span className="mt-0.5 block text-[11.5px] text-ink-faint">
            {job.uploaderName}
            {job.uploaderName && job.modelUsed ? " · " : ""}
            {job.modelUsed && <span className="font-mono text-[11px]">{job.modelUsed}</span>}
          </span>
        )}
      </>
    )),
    sortable("status", "Status", (job) =>
      labelled(
        "Status",
        <>
          <StatusBadge status={job.status} />
          {job.status === "wartend" && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now && (
            <span className="mt-0.5 block text-[12px] text-ink-soft tabular-nums">
              ab {formatDateTimeWithSeconds(job.nextAttemptAt)}
            </span>
          )}
          {job.status === "in_arbeit" && <RunningProgress job={job} now={now} />}
        </>,
      ),
    ),
    sortable("erstellt", "Erstellt", (job) => labelled("Erstellt", <Stamp iso={job.createdAt} />)),
    sortable("gestartet", "Gestartet", (job) => labelled("Gestartet", <Stamp iso={job.startedAt} />)),
    sortable("beendet", "Beendet", (job) => labelled("Beendet", <Stamp iso={job.finishedAt} />)),
    sortable("versuche", "Versuche", (job) => labelled("Versuche", job.attempts ?? 0)),
    sortable("meldung", "Meldung", (job) =>
      job.lastError ? (
        labelled(
          "Meldung",
          <span className="text-[11.5px] leading-snug text-bad wrap-anywhere min-[700px]:line-clamp-4" title={job.lastError}>
            {job.lastError}
          </span>,
        )
      ) : (
        <span className="text-ink-faint max-[699px]:hidden">–</span>
      ),
    ),
    {
      id: "aktion",
      header: "Aktion",
      enableSorting: false,
      cell: ({ row: { original: job } }) => <JobAction job={job} now={now} />,
    },
  ];
}

function JobAction({ job, now }: { job: JobListRow; now: number }) {
  if (job.status === "in_arbeit") {
    return <span className="text-[12px] text-ink-faint" data-leer>–</span>;
  }
  if (job.status === "wartend") {
    return job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now ? (
      <JobActionButton recordingId={job._id} action="wiederholen" label="Jetzt versuchen" />
    ) : (
      <JobActionButton recordingId={job._id} action="vorne" label="Nach vorne" />
    );
  }
  return <JobActionButton recordingId={job._id} action="wiederholen" label="Erneut starten" />;
}

/** Fortschritt eines laufenden Auftrags: Abschnitt, gemessene Geschwindigkeit, Lebenszeichen. */
function RunningProgress({ job, now }: { job: JobListRow; now: number }) {
  const progress = job.progress;
  const heartbeat = progress.heartbeatAt;
  if (!heartbeat || now - Date.parse(heartbeat) > STALE_LOCK_MS) {
    return (
      <span className="mt-0.5 block text-[12px] text-warn tabular-nums">
        Keine Rückmeldung{heartbeat ? ` seit ${formatDateTimeWithSeconds(heartbeat)}` : ""}, wird neu
        vergeben
      </span>
    );
  }
  const chunked = hasChunkProgress(progress);
  const total = progress.progressTotal ?? 0;
  const percent = chunked ? Math.round((Math.min(progress.progressDone ?? 0, total) / total) * 100) : null;
  const rate = chunked ? formatChunkRate(progress) : null;
  const remaining = chunked ? remainingMs(progress) : null;
  return (
    <span className="mt-1 block text-[12px] text-ink-soft tabular-nums min-[700px]:min-w-[150px]">
      {chunked ? `Abschnitt ${currentChunk(progress)}/${total}` : "Fortschritt unbestimmt"}
      {rate ? ` · ${rate}` : ""}
      {percent !== null && (
        <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-busy-soft" aria-hidden>
          <span className="block h-full rounded-full bg-busy" style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="mt-0.5 block text-ink-faint">
        Lebenszeichen {formatSecondsAgo(heartbeat, now)}
        {remaining !== null ? ` · ${formatRemaining(remaining)}` : ""}
      </span>
    </span>
  );
}

/**
 * Alle Transkriptionsaufträge. Sortiert, gefiltert und geblättert wird auf
 * dem Server über den ganzen Bestand; ohne `sort` gilt die Bearbeitungsreihenfolge.
 */
export function JobsTable({
  rows,
  sort,
  renderedAt,
  resetHref,
}: {
  rows: JobListRow[];
  sort: { key: JobSortKey; dir: JobSortDir } | null;
  /** Zeitpunkt des Server-Renders, Bezug für Lebenszeichen und geplante Versuche. */
  renderedAt: number;
  resetHref: string;
}) {
  const columns = useMemo(() => buildColumns(renderedAt), [renderedAt]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row._id}
      cellProps={CELL_PROPS}
      sort={sort}
      defaultSort={null}
      isSortKey={isJobSortKey}
      keepScroll
      tableClassName="min-[700px]:table-fixed min-[700px]:[&_.td]:px-2 min-[700px]:[&_th:not(:has(button))]:px-2 [&_th:nth-child(1)]:w-[24%] [&_th:nth-child(2)]:w-[17%] [&_th:nth-child(3)]:w-[9%] [&_th:nth-child(4)]:w-[9%] [&_th:nth-child(5)]:w-[9%] [&_th:nth-child(6)]:w-[7%] [&_th:nth-child(8)]:w-[10%]"
      empty={
        <>
          Kein Auftrag entspricht den gewählten Filtern.{" "}
          <Link href={resetHref} className="font-semibold text-petrol hover:underline">
            Filter zurücksetzen
          </Link>
        </>
      }
    />
  );
}
