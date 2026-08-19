import { Fragment } from "react";
import Link from "next/link";
import { after } from "next/server";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listRecordings, type SortKey } from "@/lib/recordings";
import { sweepQueue } from "@/lib/transcription";
import { describeTranscriptionError } from "@/lib/transcription-errors";
import { cetDayStartUtcIso, formatDateTime, formatDuration } from "@/lib/time";
import { RatingValue, StatusBadge } from "@/components/status";
import { RecordingsFilter, type FilterValues } from "@/components/recordings-filter";
import {
  DeletionFlagBadge,
  DeletionFlagButton,
  DeletionFlagProvider,
} from "@/components/deletion-flag";
import { RetryTranscriptionButton } from "@/components/retry-transcription-button";
import { TranscriptionWatcher, type WatchedRecording } from "@/components/transcription-watcher";
import type { TranscriptionStatus } from "@/lib/types";

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
  if (values.sort !== "gespraech_neu") params.set("sort", values.sort);
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

  const values: FilterValues = {
    q: first(params, "q"),
    von: first(params, "von"),
    bis: first(params, "bis"),
    uploader: first(params, "uploader"),
    status: first(params, "status") || "alle",
    bewertungVon: first(params, "bewertungVon"),
    bewertungBis: first(params, "bewertungBis"),
    loeschstatus: first(params, "loeschstatus") || "alle",
    sort: (first(params, "sort") || "gespraech_neu") as SortKey,
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

  // Beobachtet werden laufende Aufträge und fehlgeschlagene Aufträge, für die
  // noch eine automatische Wiederholung aussteht.
  const watched: WatchedRecording[] = result.rows
    .filter(
      (row) =>
        row.transcriptionStatus === "wartend" ||
        row.transcriptionStatus === "in_arbeit" ||
        (row.transcriptionStatus === "fehlgeschlagen" && !!row.transcriptionNextAttemptAt),
    )
    .map((row) => ({ id: row._id, status: row.transcriptionStatus }));

  // Fällige Wiederholungen anstossen, ohne die Antwort zu verzögern.
  after(() => sweepQueue());

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

      <div className="card overflow-hidden max-[699px]:border-0 max-[699px]:bg-transparent">
        <div className="overflow-x-auto">
          <table className="stack-cards w-full min-w-0 border-collapse min-[700px]:min-w-[1180px]">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Gesprächszeitpunkt (CET)</th>
                <th className="th">Anrufer</th>
                <th className="th">Telefonnummer</th>
                <th className="th">Anrufnr.</th>
                <th className="th">Dauer</th>
                <th className="th">Hochgeladen von</th>
                <th className="th">Bewertung</th>
                <th className="th">Transkription</th>
                <th className="th">Löschmarkierung</th>
                <th className="th">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 && (
                <tr>
                  <td className="td text-center text-ink-soft" colSpan={10} data-cell="leer">
                    {result.totalAll === 0
                      ? "Es sind noch keine Aufnahmen vorhanden. Laden Sie die ersten Gesprächsaufzeichnungen hoch."
                      : "Keine Aufnahme entspricht den gewählten Filtern."}
                  </td>
                </tr>
              )}
              {result.rows.map((row) => (
                <Fragment key={row._id}>
                  <tr className="min-[700px]:hover:bg-canvas/60">
                    <td
                      className="td font-medium min-[700px]:whitespace-nowrap"
                      data-cell="zeitpunkt"
                    >
                      <Link href={`/aufnahmen/${row._id}`} className="text-petrol hover:underline">
                        {formatDateTime(row.callAtUtc)}
                      </Link>
                      <span className="mt-0.5 block break-all font-mono text-[11px] text-ink-faint">
                        {row.originalFilename}
                      </span>
                    </td>
                    <td className="td" data-cell="anrufer">
                      <span className="font-medium text-ink">{row.callerName}</span>
                      {row.metadataSource === "manuell" && (
                        <span className="ml-1.5 badge bg-petrol-soft text-petrol">manuell erfasst</span>
                      )}
                    </td>
                    <td
                      className="td font-mono text-[12px] min-[700px]:whitespace-nowrap"
                      data-cell="wert"
                    >
                      <CardLabel>Telefonnummer</CardLabel>
                      <span className="block">{row.phoneNumber || "–"}</span>
                    </td>
                    <td
                      className="td font-mono text-[12px] min-[700px]:whitespace-nowrap"
                      data-cell="wert"
                    >
                      <CardLabel>Anrufnr.</CardLabel>
                      <span className="block">{row.callNumber || "–"}</span>
                    </td>
                    <td
                      className="td font-mono text-[12px] min-[700px]:whitespace-nowrap"
                      data-cell="wert"
                    >
                      <CardLabel>Dauer</CardLabel>
                      <span className="block">{formatDuration(row.durationMs)}</span>
                    </td>
                    <td className="td min-[700px]:whitespace-nowrap" data-cell="wert">
                      <CardLabel>Hochgeladen von</CardLabel>
                      <span className="block">{row.uploadedByName}</span>
                    </td>
                    <td className="td" data-cell="wert">
                      <CardLabel>Bewertung</CardLabel>
                      <span className="block">
                        <RatingValue average={row.ratingAverage} count={row.ratingCount} />
                      </span>
                    </td>
                    <td className="td" data-cell="wert">
                      <CardLabel>Transkription</CardLabel>
                      <span className="block">
                        <StatusBadge status={row.transcriptionStatus} />
                        {row.transcriptionStatus === "fehlgeschlagen" && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint min-[700px]:max-w-[220px]">
                            {describeTranscriptionError(row.transcriptionError).message}
                          </span>
                        )}
                      </span>
                    </td>
                    {/* Badge und Schaltfläche teilen sich den Zustand, damit die Zeile
                        sofort nach dem Klick umschaltet und nicht erst nach dem Neuladen. */}
                    <DeletionFlagProvider recordingId={row._id} flagged={row.deletionFlagged}>
                      <td className="td" data-cell="wert">
                        <CardLabel>Löschmarkierung</CardLabel>
                        <span className="block">
                          <DeletionFlagBadge
                            flagged={row.deletionFlagged}
                            flaggedBy={row.deletionFlaggedBy}
                          />
                        </span>
                      </td>
                      <td className="td" data-cell="aktion">
                        <div className="flex flex-wrap items-start gap-2 min-[700px]:flex-col min-[700px]:gap-1">
                          <Link href={`/aufnahmen/${row._id}`} className="btn btn-ghost">
                            Öffnen
                          </Link>
                          {row.transcriptionStatus === "fehlgeschlagen" && (
                            <RetryTranscriptionButton
                              key={row.transcriptionFinishedAt ?? "neu"}
                              recordingId={row._id}
                            />
                          )}
                          <DeletionFlagButton
                            recordingId={row._id}
                            flagged={row.deletionFlagged}
                          />
                        </div>
                      </td>
                    </DeletionFlagProvider>
                  </tr>
                  {(row.hits.length > 0 || row.matchedFields.length > 0) && (
                    <tr className="bg-petrol-soft/40" data-row="treffer">
                      <td className="td" colSpan={10} data-cell="treffer">
                        {row.matchedFields.length > 0 && (
                          <p className="text-[12px] text-ink-soft">
                            Treffer in: <strong>{row.matchedFields.join(", ")}</strong>
                          </p>
                        )}
                        {row.hits.map((hit, index) => (
                          <p key={index} className="mt-1 text-[12.5px] leading-relaxed text-ink">
                            <Link
                              href={`/aufnahmen/${row._id}?t=${hit.startMs}&q=${encodeURIComponent(values.q)}`}
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
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {result.pageCount > 1 && (
        <nav className="flex items-center justify-between gap-3" aria-label="Seitennavigation">
          <span className="text-[12px] text-ink-soft">
            Einträge {(result.page - 1) * result.pageSize + 1} bis{" "}
            {Math.min(result.page * result.pageSize, result.total)} von{" "}
            {result.total.toLocaleString("de-CH")}
          </span>
          <div className="flex items-center gap-1">
            <PageLink values={values} page={result.page - 1} disabled={result.page <= 1}>
              Zurück
            </PageLink>
            {pageWindow(result.page, result.pageCount).map((entry, index) =>
              entry === null ? (
                <span key={`l-${index}`} className="px-1 text-[12px] text-ink-faint">
                  …
                </span>
              ) : (
                <Link
                  key={entry}
                  href={buildQuery(values, entry)}
                  aria-current={entry === result.page ? "page" : undefined}
                  className={`btn ${entry === result.page ? "btn-primary" : "btn-secondary"} min-w-9`}
                >
                  {entry}
                </Link>
              ),
            )}
            <PageLink
              values={values}
              page={result.page + 1}
              disabled={result.page >= result.pageCount}
            >
              Weiter
            </PageLink>
          </div>
        </nav>
      )}

      <p className="text-[11px] text-ink-faint">
        Angemeldet als {user.email}. Alle nicht endgültig gelöschten Aufnahmen sind für sämtliche
        Mitarbeitenden sichtbar.
      </p>
    </div>
  );
}

/**
 * Spaltenbezeichnung innerhalb der Karte. Unterhalb von 700 px ersetzt sie den
 * ausgeblendeten Tabellenkopf; ab 700 px trägt der Tabellenkopf die Beschriftung.
 */
function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex-none text-[11px] font-bold uppercase tracking-[0.06em] text-ink-soft min-[700px]:hidden">
      {children}
    </span>
  );
}

function PageLink({
  values,
  page,
  disabled,
  children,
}: {
  values: FilterValues;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="btn btn-secondary opacity-50" aria-disabled>
        {children}
      </span>
    );
  }
  return (
    <Link href={buildQuery(values, page)} className="btn btn-secondary">
      {children}
    </Link>
  );
}

function pageWindow(current: number, total: number): (number | null)[] {
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const output: (number | null)[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) output.push(null);
    output.push(page);
    previous = page;
  }
  return output;
}
