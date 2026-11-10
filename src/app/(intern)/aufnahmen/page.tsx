import { Fragment } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listRecordings } from "@/lib/recordings";
import { jobProgress, queueHalt, type JobProgress } from "@/lib/transcription";
import { DEFAULT_SORT, parseSort } from "@/lib/recording-sort";
import { cetDayStartUtcIso, renderTimestamp } from "@/lib/time";
import { RecordingsFilter, type FilterValues } from "@/components/recordings-filter";
import { RecordingsTable, type TableRow } from "@/components/recordings-table";
import { Pagination } from "@/components/pagination";
import { DEFAULT_TEMPLATE_EXAMPLE } from "@/lib/filename-template";
import { TranscriptionWatcher, type WatchedRecording } from "@/components/transcription-watcher";
import type { QueueHalt, TranscriptionStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Aufnahmen" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

function buildQuery(values: FilterValues, page: number): string {
  const params = new URLSearchParams();
  if (values.q) params.set("q", values.q);
  if (values.von) params.set("von", values.von);
  if (values.bis) params.set("bis", values.bis);
  if (values.uploader) params.set("uploader", values.uploader);
  if (values.status && values.status !== "alle") params.set("status", values.status);
  if (values.bewertungVon) params.set("bewertungVon", values.bewertungVon);
  if (values.bewertungBis) params.set("bewertungBis", values.bewertungBis);
  if (values.loeschstatus && values.loeschstatus !== "alle") {
    params.set("loeschstatus", values.loeschstatus);
  }
  if (values.sort !== DEFAULT_SORT.key || values.dir !== DEFAULT_SORT.dir) {
    params.set("sort", values.sort);
    params.set("dir", values.dir);
  }
  if (values.pageSize !== "20") params.set("pageSize", values.pageSize);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/aufnahmen?${query}` : "/aufnahmen";
}

export default async function AufnahmenPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const sort = parseSort(first(params, "sort"), first(params, "dir"));
  const values: FilterValues = {
    q: first(params, "q"),
    von: first(params, "von"),
    bis: first(params, "bis"),
    uploader: first(params, "uploader"),
    status: first(params, "status") || "alle",
    bewertungVon: first(params, "bewertungVon"),
    bewertungBis: first(params, "bewertungBis"),
    loeschstatus: first(params, "loeschstatus") || "alle",
    sort: sort.key,
    dir: sort.dir,
    pageSize: first(params, "pageSize") || "20",
  };
  const page = Math.max(1, Number(first(params, "page")) || 1);

  const result = await listRecordings({
    q: values.q,
    von: values.von ? cetDayStartUtcIso(values.von) ?? undefined : undefined,
    bis: values.bis ? cetDayStartUtcIso(values.bis, true) ?? undefined : undefined,
    uploader: values.uploader || undefined,
    status: (values.status as TranscriptionStatus | "alle") || "alle",
    bewertungVon: values.bewertungVon ? Number(values.bewertungVon) : undefined,
    bewertungBis: values.bewertungBis ? Number(values.bewertungBis) : undefined,
    loeschstatus: values.loeschstatus as "alle" | "nur_markiert" | "ohne_markiert",
    sort: values.sort,
    dir: values.dir,
    page,
    pageSize: Number(values.pageSize) || 20,
  });

  const activeFilters = [
    values.q,
    values.von,
    values.bis,
    values.uploader,
    values.status !== "alle" ? values.status : "",
    values.bewertungVon,
    values.bewertungBis,
    values.loeschstatus !== "alle" ? values.loeschstatus : "",
  ].filter(Boolean).length;

  const renderedAt = renderTimestamp();
  const [progress, halt] = await Promise.all([
    jobProgress(result.rows.filter((row) => row.transcriptionStatus === "in_arbeit").map((row) => row._id)),
    result.rows.some((row) => row.transcriptionStatus === "wartend") ? queueHalt() : Promise.resolve(null),
  ]);

  // Beobachtet werden wartende und laufende Aufträge; „fehlgeschlagen“ ist endgültig.
  // Ist die Warteschlange angehalten, ändert sich an wartenden nichts.
  const watched: WatchedRecording[] = result.rows
    .filter(
      (row) =>
        row.transcriptionStatus === "in_arbeit" || (row.transcriptionStatus === "wartend" && !halt),
    )
    .map((row) => ({
      id: row._id,
      status: row.transcriptionStatus,
      progressDone: progress.get(row._id)?.progressDone ?? null,
    }));

  if (result.totalAll === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Aufnahmen</h1>
        <section className="card px-5 py-12 text-center" aria-labelledby="leer-titel">
          <h2 id="leer-titel" className="text-[15px] font-semibold text-ink">
            Noch keine Aufnahmen
          </h2>
          <p className="mx-auto mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-soft">
            Hochgeladene Gespräche werden automatisch auf Deutsch transkribiert und sind danach
            durchsuchbar.
          </p>
          <p className="mt-4 text-[12px] text-ink-soft">Erwarteter Dateiname, zum Beispiel:</p>
          <code className="mt-1 inline-block rounded-sm bg-canvas px-2 py-1 font-mono text-[12px] text-ink">
            {/* Umbruch nur nach den Unterstrichen, nicht mitten in einer Nummer. */}
            {DEFAULT_TEMPLATE_EXAMPLE.split("_").map((part, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <>
                    _<wbr />
                  </>
                )}
                {part}
              </Fragment>
            ))}
          </code>
          <div className="mt-6">
            <Link href="/upload" className="btn btn-primary">
              Aufnahmen hochladen
            </Link>
          </div>
        </section>
        <p className="text-[12px] text-ink-faint">Angemeldet als {user.email}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Aufnahmen</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            {result.total.toLocaleString("de-CH")}{" "}
            {result.total === 1 ? "Aufnahme" : "Aufnahmen"}
            {activeFilters > 0 ? ` gefiltert aus ${result.totalAll.toLocaleString("de-CH")}` : ""} ·
            Seite {result.page} von {result.pageCount}
          </p>
        </div>
        <Link href="/upload" className="btn btn-primary">
          Aufnahmen hochladen
        </Link>
      </div>

      <RecordingsFilter values={values} uploaders={result.uploaders} activeCount={activeFilters} />

      <TranscriptionWatcher entries={watched} />

      <RecordingsTable
        rows={result.rows.map((row) => toTableRow(row, progress.get(row._id), halt))}
        sortKey={values.sort}
        sortDir={values.dir}
        query={values.q}
        renderedAt={renderedAt}
      />

      <Pagination
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        total={result.total}
        href={(page) => buildQuery(values, page)}
      />

      <p className="text-[12px] text-ink-faint">
        Angemeldet als {user.email}.
      </p>
    </div>
  );
}

/** Nur die Felder, die die Tabelle anzeigt, gehen an den Client. */
function toTableRow(
  row: Awaited<ReturnType<typeof listRecordings>>["rows"][number],
  progress: JobProgress | undefined,
  halt: QueueHalt,
): TableRow {
  return {
    transcriptionTiming: {
      status: row.transcriptionStatus,
      queuedAt: row.uploadedAt,
      nextAttemptAt: row.transcriptionNextAttemptAt ?? null,
      finishedAt: row.transcriptionFinishedAt,
      attempts: row.transcriptionAttempts ?? 0,
      progressDone: progress?.progressDone ?? null,
      progressTotal: progress?.progressTotal ?? null,
      updatedAt: progress?.updatedAt ?? row.transcriptionStartedAt,
      halt,
    },
    _id: row._id,
    callAtUtc: row.callAtUtc,
    originalFilename: row.originalFilename,
    callerName: row.callerName,
    metadataSource: row.metadataSource,
    phoneNumber: row.phoneNumber,
    callNumber: row.callNumber,
    durationMs: row.durationMs,
    uploadedByName: row.uploadedByName,
    ratingAverage: row.ratingAverage,
    ratingCount: row.ratingCount,
    transcriptionStatus: row.transcriptionStatus,
    transcriptionError: row.transcriptionError,
    transcriptionFinishedAt: row.transcriptionFinishedAt,
    deletionFlagged: row.deletionFlagged,
    deletionFlaggedBy: row.deletionFlaggedBy,
    hits: row.hits,
    matchedFields: row.matchedFields,
  };
}
