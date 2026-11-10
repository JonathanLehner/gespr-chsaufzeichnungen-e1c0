import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { formatDateTimeWithSeconds, formatDuration, renderTimestamp } from "@/lib/time";
import { haltText } from "@/lib/queue-halt";
import { listJobs, queueHealth, queueOverview, type QueueHealth } from "@/lib/transcription";
import { TranscriptionWatcher } from "@/components/transcription-watcher";
import {
  JOB_PARAM_KEYS,
  activeJobFilterCount,
  jobQueryParams,
  parseJobFilters,
  type JobFilterValues,
} from "@/lib/job-filter";
import { JobsFilter } from "@/components/jobs-filter";
import { JobsTable } from "@/components/jobs-table";
import { Pagination } from "@/components/pagination";
import { AdminTabs } from "@/components/admin-tabs";
import {
  JobActionButton,
  LiftBlockButton,
  PauseQueueButton,
  QueueFlash,
  QueueSettingsForm,
  RequeueAllFailedButton,
} from "@/components/queue-controls";
import type { TranscriptionStatus } from "@/lib/types";
import {
  DEFAULT_MODEL,
  TRANSCRIPTS_PAGE_SIZE,
  TRANSCRIPT_SORTS,
  actualCostPerMinute,
  costByMonth,
  directKeyConfigured,
  getModelSettings,
  listTranscripts,
  type TranscriptSort,
} from "@/lib/transcription-models";
import {
  TIMING_LABELS,
  TRANSCRIPTION_MODELS,
  availabilityNote,
  estimatedCostPerMinute,
  formatUsd,
  isAvailable,
  type TimingMethod,
} from "../../../../../transcriber/shared/models";
import {
  ModelSettingsForm,
  RetranscribeForm,
  VocabularyForm,
  type ModelOption,
} from "@/components/transcription-model-controls";

export const metadata: Metadata = { title: "Transkription verwalten" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_PATH = "/admin/transkription";
/** Parameter der Transkriptliste weiter unten; die Auftragstabelle lässt sie stehen. */
const TRANSCRIPT_PARAM_KEYS = ["modell", "zeiten", "sortierung", "richtung", "seite"] as const;

function pick(
  query: Record<string, string | string[] | undefined>,
  keys: readonly string[],
): [string, string][] {
  return keys.flatMap((key) => {
    const value = param(query, key);
    return value ? [[key, value] as [string, string]] : [];
  });
}

function pageHref(entries: [string, string][], hash: string): string {
  const search = new URLSearchParams(entries).toString();
  return `${PAGE_PATH}${search ? `?${search}` : ""}#${hash}`;
}

/** Schnellansichten der Auftragstabelle; sie setzen nur den Statusfilter. */
const JOB_VIEWS: { label: string; status: JobFilterValues["status"] }[] = [
  { label: "Alle", status: [] },
  { label: "Laufend und wartend", status: ["in_arbeit", "wartend"] },
  { label: "Fehlgeschlagen", status: ["fehlgeschlagen"] },
  { label: "Abgeschlossen", status: ["abgeschlossen", "ohne_sprache"] },
];

function param(query: Record<string, string | string[] | undefined>, key: string): string {
  const value = query[key];
  return String((Array.isArray(value) ? value[0] : value) ?? "");
}

export default async function TranskriptionAdminPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="card p-8">
          <h1 className="text-lg font-semibold text-ink">Kein Zugriff</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Diese Seite steht nur Administratoren zur Verfügung.
          </p>
          <Link href="/aufnahmen" className="btn btn-primary mt-5">
            Zurück zu den Aufnahmen
          </Link>
        </div>
      </div>
    );
  }

  const query = await searchParams;
  const filterModel = TRANSCRIPTION_MODELS.some((model) => model.id === param(query, "modell")) ? param(query, "modell") : null;
  const filterTiming = (["modell", "schaetzung"] as const).find((value) => value === param(query, "zeiten")) ?? null;
  const sort: TranscriptSort = param(query, "sortierung") in TRANSCRIPT_SORTS ? (param(query, "sortierung") as TranscriptSort) : "datum";
  const direction = param(query, "richtung") === "auf" ? 1 : -1;
  const page = Math.max(1, Number.parseInt(param(query, "seite"), 10) || 1);
  const jobFilters = parseJobFilters(query);
  const transcriptParams = pick(query, TRANSCRIPT_PARAM_KEYS);
  const jobParams = pick(query, JOB_PARAM_KEYS);

  const health = await queueHealth();
  const [overview, jobs, modelSettings, actual, costs, transcripts] = await Promise.all([
    queueOverview(health),
    listJobs(jobFilters),
    getModelSettings(),
    actualCostPerMinute(),
    costByMonth(),
    listTranscripts({ model: filterModel, timing: filterTiming, sort, direction, page }),
  ]);
  const directKey = directKeyConfigured();
  const modelOptions: ModelOption[] = TRANSCRIPTION_MODELS.map((model) => ({
    id: model.id,
    available: isAvailable(model, directKey),
    note: availabilityNote(model, directKey),
    timingLabel: TIMING_LABELS[model.timing],
    estimatedPerMinute: formatUsd(estimatedCostPerMinute(model)),
    actualPerMinute: actual.has(model.id) ? formatUsd(actual.get(model.id)) : null,
  }));
  const now = renderTimestamp();
  const block = overview.spendingBlock;
  const pause = overview.manualPause;

  const counts: { status: TranscriptionStatus; label: string }[] = [
    { status: "wartend", label: "Wartend" },
    { status: "in_arbeit", label: "In Verarbeitung" },
    { status: "abgeschlossen", label: "Abgeschlossen" },
    { status: "ohne_sprache", label: "Keine Sprache" },
    { status: "fehlgeschlagen", label: "Fehlgeschlagen" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Transkription verwalten</h1>
        <AdminTabs />
      </div>
      <QueueFlash />
      {/* Laufende und wartende Aufträge, Lebenszeichen und Zähler bleiben ohne Neuladen aktuell. */}
      <TranscriptionWatcher
        entries={overview.waiting.map((job) => ({ id: job._id, status: job.status }))}
        mode="alles"
        quiet
      />

      {/* Zustand und Steuerung */}
      <section className="card p-5" aria-labelledby="zustand">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="zustand" className="text-[15px] font-semibold text-ink">
              Zustand
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {block ? (
                <span className="badge bg-bad-soft text-bad">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                  Gesperrt wegen API-Limit
                </span>
              ) : pause ? (
                <span className="badge bg-warn-soft text-warn">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                  Pausiert
                </span>
              ) : (
                <span className="badge bg-ok-soft text-ok">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                  Läuft
                </span>
              )}
              {!block && pause && (
                <span className="text-[12.5px] text-ink-soft">
                  Von {pause.by} am {formatDateTimeWithSeconds(pause.at)}
                </span>
              )}
            </div>
          </div>
          {!block && <PauseQueueButton paused={!!pause} />}
        </div>

        {block && (
          <div className="mt-4 rounded-md border border-[#eab8b1] bg-bad-soft p-4" role="alert">
            <p className="text-[14px] font-semibold text-bad">
              Monatliches Kostenlimit erreicht. Es werden keine Anfragen gesendet.
            </p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] text-bad sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">Gesperrt seit</dt>
              <dd className="tabular-nums">{formatDateTimeWithSeconds(block.startedAt)}</dd>
              <dt className="font-medium">Hebt sich auf am</dt>
              <dd className="tabular-nums">{formatDateTimeWithSeconds(block.until)}</dd>
              {block.recordingId && (
                <>
                  <dt className="font-medium">Ausgelöst bei</dt>
                  <dd>
                    <Link href={`/aufnahmen/${block.recordingId}`} className="underline">
                      Aufnahme öffnen
                    </Link>
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-2 font-mono text-[11.5px] break-words text-bad">{block.reason}</p>
            <p className="mt-2 text-[12.5px] text-bad">
              Wartende Aufnahmen behalten ihren Platz. Bei Aufnahmen steht: „{haltText({ kind: "gesperrt", since: block.startedAt, until: block.until })}“.
            </p>
            <div className="mt-3">
              <LiftBlockButton />
            </div>
            {pause && (
              <p className="mt-3 text-[12.5px] text-bad">
                Zusätzlich vom Admin pausiert ({pause.by}). Nach dem Aufheben bleibt die Pause bestehen.
              </p>
            )}
          </div>
        )}

        {!block && overview.lastBlock && (
          <p className="mt-3 text-[12px] text-ink-faint">
            Letzte Sperre: {formatDateTimeWithSeconds(overview.lastBlock.startedAt)} bis{" "}
            {formatDateTimeWithSeconds(overview.lastBlock.liftedAt)}, aufgehoben von {overview.lastBlock.liftedBy}.
          </p>
        )}

        <WorkerHealthPanel health={health} />
      </section>

      {/* Warteschlange */}
      <section className="card p-5" aria-labelledby="warteschlange">
        <h2 id="warteschlange" className="text-[15px] font-semibold text-ink">
          Warteschlange
        </h2>
        <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-line bg-line grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {counts.map((entry) => (
            <div key={entry.status} className="bg-surface p-3">
              <p className="text-xl font-semibold tabular-nums text-ink">
                {overview.counts[entry.status].toLocaleString("de-CH")}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{entry.label}</p>
            </div>
          ))}
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-soft">Durchsatz (60 min)</dt>
          <dd className="text-ink tabular-nums">
            {overview.throughput.recordings.toLocaleString("de-CH")}{" "}
            {overview.throughput.recordings === 1 ? "Aufnahme" : "Aufnahmen"} fertig,{" "}
            {Math.round(overview.throughput.audioMs / 60_000).toLocaleString("de-CH")} Min. Gesprächsdauer
          </dd>
          <dt className="text-ink-soft">Ältester wartender Auftrag</dt>
          <dd className="text-ink">
            {overview.oldestWaiting ? (
              <>
                <Link href={`/aufnahmen/${overview.oldestWaiting._id}`} className="font-mono text-[12px] text-petrol hover:underline">
                  {overview.oldestWaiting.originalFilename}
                </Link>
                <span className="text-ink-soft"> · eingereiht {formatDateTimeWithSeconds(overview.oldestWaiting.createdAt)}</span>
              </>
            ) : (
              "–"
            )}
          </dd>
        </dl>

        <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
          Nächste geplante Versuche ({overview.nextAttempts.length})
        </h3>
        {overview.nextAttempts.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Keine Wiederholung geplant.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {overview.nextAttempts.map((job) => (
              <li key={job._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <Link href={`/aufnahmen/${job._id}`} className="font-mono text-[12px] text-petrol hover:underline wrap-anywhere">
                    {job.originalFilename}
                  </Link>
                  <p className="text-[12px] text-ink-soft tabular-nums">
                    {formatDateTimeWithSeconds(job.nextAttemptAt)} · {job.attempts}{" "}
                    {job.attempts === 1 ? "Versuch" : "Versuche"} bisher
                  </p>
                </div>
                <JobActionButton recordingId={job._id} action="wiederholen" label="Jetzt versuchen" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Aufträge */}
      <section id="auftraege" className="scroll-mt-20 space-y-3" aria-labelledby="auftraege-titel">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="auftraege-titel" className="text-[15px] font-semibold text-ink">
              Aufträge
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              {jobs.total.toLocaleString("de-CH")} {jobs.total === 1 ? "Auftrag" : "Aufträge"}
              {activeJobFilterCount(jobFilters) > 0
                ? ` gefiltert aus ${jobs.totalAll.toLocaleString("de-CH")}`
                : ""}{" "}
              · Seite {jobs.page} von {jobs.pageCount}
            </p>
          </div>
          <RequeueAllFailedButton count={overview.counts.fehlgeschlagen} />
        </div>
        <nav aria-label="Ansichten" className="flex flex-wrap gap-1.5 text-[12px]">
          {JOB_VIEWS.map((view) => {
            const active =
              activeJobFilterCount(jobFilters) === (view.status.length > 0 ? 1 : 0) &&
              view.status.join(",") === jobFilters.status.join(",");
            return (
              <Link
                key={view.label}
                href={pageHref(
                  [
                    ...transcriptParams,
                    ...jobQueryParams({ ...jobFilters, status: view.status }, 1),
                  ],
                  "auftraege",
                )}
                aria-current={active ? "true" : undefined}
                className={`badge ${active ? "bg-petrol text-white" : "bg-surface border border-line text-ink-soft hover:text-petrol"}`}
              >
                {view.label}
              </Link>
            );
          })}
        </nav>
        <JobsFilter
          action={`${PAGE_PATH}#auftraege`}
          values={jobFilters}
          uploaders={jobs.uploaders}
          models={jobs.models}
          activeCount={activeJobFilterCount(jobFilters)}
          keep={transcriptParams}
          resetHref={pageHref(transcriptParams, "auftraege")}
        />
        <JobsTable
          rows={jobs.rows}
          sort={jobFilters.sort}
          renderedAt={now}
          resetHref={pageHref(transcriptParams, "auftraege")}
        />
        <Pagination
          page={jobs.page}
          pageCount={jobs.pageCount}
          pageSize={jobs.pageSize}
          total={jobs.total}
          href={(target) =>
            pageHref([...transcriptParams, ...jobQueryParams(jobFilters, target)], "auftraege")
          }
        />
      </section>

      {/* Modell */}
      <section className="card p-5" aria-labelledby="modell">
        <h2 id="modell" className="text-[15px] font-semibold text-ink">
          Transkriptionsmodell
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">
          Gilt für neue Aufträge. Verwendet wird derzeit{" "}
          <span className="font-mono text-[12.5px] text-ink">{modelSettings.effective}</span>.
          {modelSettings.updatedBy && modelSettings.updatedAt
            ? ` Zuletzt geändert von ${modelSettings.updatedBy} am ${formatDateTimeWithSeconds(modelSettings.updatedAt)}.`
            : ""}
        </p>
        <ModelSettingsForm models={modelOptions} selected={modelSettings.effective} defaultId={DEFAULT_MODEL} />
      </section>

      {/* Vokabular */}
      <section className="card p-5" aria-labelledby="vokabular">
        <h2 id="vokabular" className="text-[15px] font-semibold text-ink">
          Vokabular
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">
          Namen und Begriffe in der richtigen Schreibweise, etwa Firmen-, Orts- und Strassennamen.
        </p>
        <VocabularyForm initial={modelSettings.vocabulary} stored={modelSettings.vocabularyStored} />
      </section>

      {/* Neu erstellen */}
      <section className="card p-5" aria-labelledby="neu-erstellen">
        <h2 id="neu-erstellen" className="text-[15px] font-semibold text-ink">
          Bestehende Transkripte neu erstellen
        </h2>
        <RetranscribeForm models={modelOptions} defaultModel={modelSettings.effective} />
      </section>

      {/* Kosten */}
      <section className="card p-5" aria-labelledby="kosten">
        <h2 id="kosten" className="text-[15px] font-semibold text-ink">
          Kosten
        </h2>
        {costs.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Noch keine gemessenen Läufe.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[800px] border-collapse">
              <thead className="bg-canvas">
                <tr>
                  <th className="th">Monat</th>
                  <th className="th">Modell</th>
                  <th className="th">Läufe</th>
                  <th className="th">Audio</th>
                  <th className="th">Tokens Ein / Aus / Denken</th>
                  <th className="th">Kosten</th>
                  <th className="th">Je Minute</th>
                  <th className="th">Ungültige Antworten</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((row) => (
                  <tr key={`${row.month}-${row.model}`}>
                    <td className="td tabular-nums">{row.month}</td>
                    <td className="td font-mono text-[12px]">{row.model}</td>
                    <td className="td tabular-nums">{row.runs.toLocaleString("de-CH")}</td>
                    <td className="td tabular-nums">{Math.round(row.audioMinutes).toLocaleString("de-CH")} Min.</td>
                    <td className="td text-[12px] tabular-nums">
                      {(row.usage.audioInput + row.usage.textInput).toLocaleString("de-CH")} /{" "}
                      {row.usage.output.toLocaleString("de-CH")} / {row.usage.thinking.toLocaleString("de-CH")}
                    </td>
                    <td className="td tabular-nums">{formatUsd(row.costUsd, 2)}</td>
                    <td className="td tabular-nums">
                      {row.audioMinutes > 0 ? formatUsd(row.costUsd / row.audioMinutes) : "–"}
                    </td>
                    <td className="td tabular-nums">{row.invalidReplies.toLocaleString("de-CH")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Transkripte */}
      <TranscriptTable
        rows={transcripts.rows}
        keep={jobParams}
        total={transcripts.total}
        page={page}
        filterModel={filterModel}
        filterTiming={filterTiming}
        sort={sort}
        direction={direction}
      />

      {/* Grenzen */}
      <section className="card p-5" aria-labelledby="grenzen">
        <h2 id="grenzen" className="text-[15px] font-semibold text-ink">
          Anfragegrenzen
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">
          Gilt sofort für alle Instanzen.{" "}
          {overview.settings
            ? `Zuletzt geändert von ${overview.settings.updatedBy} am ${formatDateTimeWithSeconds(overview.settings.updatedAt)}.`
            : "Derzeit gelten die Standardwerte."}
        </p>
        <QueueSettingsForm
          initial={{
            maxConcurrent: overview.effective.maxConcurrent,
            minGapSeconds: Math.round(overview.effective.minGapMs / 1000),
            jobsPerInstance: overview.effective.jobsPerInstance,
          }}
        />
      </section>

      {/* Fehler */}
      <section className="card p-5" aria-labelledby="fehler">
        <h2 id="fehler" className="text-[15px] font-semibold text-ink">
          Letzte Fehler
        </h2>
        {overview.errors.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Keine Fehler.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead className="bg-canvas">
                <tr>
                  <th className="th">Zeit</th>
                  <th className="th">Aufnahme</th>
                  <th className="th">Meldung</th>
                </tr>
              </thead>
              <tbody>
                {overview.errors.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td className="td whitespace-nowrap text-[12px] tabular-nums">
                      {formatDateTimeWithSeconds(entry.at)}
                    </td>
                    <td className="td">
                      {entry.recordingId ? (
                        <Link href={`/aufnahmen/${entry.recordingId}`} className="font-mono text-[11.5px] text-petrol hover:underline wrap-anywhere">
                          {entry.filename ?? entry.recordingId}
                        </Link>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="td text-[12px] text-bad wrap-anywhere">{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function WorkerHealthPanel({ health }: { health: QueueHealth }) {
  const active = health.workers.filter((worker) => worker.alive);
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">Instanzen</h3>
        <WorkerBadge
          alive={active.length > 0}
          label={active.length > 1 ? `${active.length} Instanzen aktiv` : undefined}
        />
        <span className="text-[12px] text-ink-faint">
          {health.lastHeartbeatAt
            ? `Letztes Lebenszeichen: ${formatDateTimeWithSeconds(health.lastHeartbeatAt)}`
            : "Noch kein Lebenszeichen"}
        </span>
      </div>

      {health.workers.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Instanz</th>
                <th className="th">Status</th>
                <th className="th">Gestartet</th>
                <th className="th">Letztes Lebenszeichen</th>
                <th className="th">Plätze</th>
                <th className="th">Laufend</th>
                <th className="th">Erledigt</th>
                <th className="th">Zurückgestellt</th>
                <th className="th">Fehlgeschlagen</th>
              </tr>
            </thead>
            <tbody>
              {health.workers.map((worker) => (
                <tr key={worker.id}>
                  <td className="td font-mono text-[11.5px]">{worker.id}</td>
                  <td className="td">
                    {worker.stoppedAt && !worker.alive ? (
                      <span className="badge bg-canvas text-ink-soft">Beendet</span>
                    ) : (
                      <WorkerBadge alive={worker.alive} />
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-[12px]">{formatDateTimeWithSeconds(worker.startedAt)}</td>
                  <td className="td whitespace-nowrap text-[12px]">{formatDateTimeWithSeconds(worker.lastHeartbeatAt)}</td>
                  <td className="td tabular-nums">{worker.concurrency}</td>
                  <td className="td tabular-nums">{worker.activeJobs.length}</td>
                  <td className="td tabular-nums">{worker.processed}</td>
                  <td className="td tabular-nums">{worker.deferred ?? 0}</td>
                  <td className="td tabular-nums">{worker.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LimiterPanel limiter={health.limiter} />
    </div>
  );
}

/** Gemeinsame Drossel aller Instanzen: tatsächliche Rate und aktuelle Grenzen. */
function LimiterPanel({ limiter }: { limiter: QueueHealth["limiter"] }) {
  if (!limiter) return null;
  const number = (value: number, digits = 1) =>
    value.toLocaleString("de-CH", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const stats = [
    { label: "Anfragen pro Minute (10 min)", value: number(limiter.perMinute) },
    {
      label:
        limiter.allowedNow < limiter.maxConcurrent
          ? `Laufend / erlaubt (Anlauf, sonst ${limiter.maxConcurrent})`
          : "Laufend / erlaubt",
      value: `${limiter.running} / ${limiter.allowedNow}`,
    },
    { label: "Mindestabstand", value: `${number(limiter.minGapMs / 1000, 0)} s` },
    { label: "Fehler (10 min)", value: String(limiter.failedLast10Min) },
    {
      label: "Mittlere Antwortzeit (10 min)",
      value: limiter.avgMs === null ? "–" : `${number(limiter.avgMs / 1000)} s`,
    },
  ];
  return (
    <div className="mt-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">Anfragerate, alle Instanzen</h3>
      {limiter.pausedUntil && (
        <p className="notice notice-warn mt-2" role="status">
          Nach einer Störung pausiert bis {formatDateTimeWithSeconds(limiter.pausedUntil)}
          {limiter.lastPauseReason ? `: ${limiter.lastPauseReason}` : "."}
        </p>
      )}
      <div className="mt-2 grid gap-px overflow-hidden rounded-md border border-line bg-line grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-surface p-3">
            <p className="text-xl font-semibold tabular-nums text-ink">{stat.value}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkerBadge({ alive, label }: { alive: boolean; label?: string }) {
  return (
    <span className={`badge ${alive ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? (alive ? "Aktiv" : "Keine Rückmeldung")}
    </span>
  );
}

type TranscriptTableProps = {
  rows: Awaited<ReturnType<typeof listTranscripts>>["rows"];
  /** Parameter der Auftragstabelle, die beim Blättern erhalten bleiben. */
  keep: [string, string][];
  total: number;
  page: number;
  filterModel: string | null;
  filterTiming: TimingMethod | null;
  sort: TranscriptSort;
  direction: 1 | -1;
};

/** Abgeschlossene Transkripte mit Herkunft; Filter und Sortierung über die Adresse. */
function TranscriptTable({ rows, keep, total, page, filterModel, filterTiming, sort, direction }: TranscriptTableProps) {
  const href = (patch: Record<string, string | null>) => {
    const values: Record<string, string | null> = {
      modell: filterModel,
      zeiten: filterTiming,
      sortierung: sort === "datum" ? null : sort,
      richtung: direction === 1 ? "auf" : null,
      seite: page > 1 ? String(page) : null,
      ...patch,
    };
    const search = new URLSearchParams([
      ...keep,
      ...Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]),
    ]).toString();
    return `/admin/transkription${search ? `?${search}` : ""}#transkripte`;
  };
  const sortLink = (key: TranscriptSort, label: string) => {
    const active = sort === key;
    const next = active && direction === -1 ? "auf" : null;
    return (
      <Link
        href={href({ sortierung: key === "datum" ? null : key, richtung: next, seite: null })}
        className={`hover:text-petrol ${active ? "text-ink" : ""}`}
        aria-sort={active ? (direction === 1 ? "ascending" : "descending") : undefined}
      >
        {label}
        {active ? (direction === 1 ? " ↑" : " ↓") : ""}
      </Link>
    );
  };
  const pages = Math.max(1, Math.ceil(total / TRANSCRIPTS_PAGE_SIZE));
  const chip = (active: boolean) =>
    `badge ${active ? "bg-petrol text-white" : "bg-canvas text-ink-soft hover:text-petrol"}`;

  return (
    <section id="transkripte" className="card scroll-mt-20 p-5" aria-labelledby="transkripte-titel">
      <h2 id="transkripte-titel" className="text-[15px] font-semibold text-ink">
        Transkripte ({total.toLocaleString("de-CH")})
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="mr-1 text-ink-soft">Modell</span>
        <Link href={href({ modell: null, seite: null })} className={chip(!filterModel)}>
          Alle
        </Link>
        {TRANSCRIPTION_MODELS.map((model) => (
          <Link key={model.id} href={href({ modell: model.id, seite: null })} className={`${chip(filterModel === model.id)} font-mono`}>
            {model.id}
          </Link>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="mr-1 text-ink-soft">Zeiten</span>
        <Link href={href({ zeiten: null, seite: null })} className={chip(!filterTiming)}>
          Alle
        </Link>
        {(Object.keys(TIMING_LABELS) as TimingMethod[]).map((key) => (
          <Link key={key} href={href({ zeiten: key, seite: null })} className={chip(filterTiming === key)}>
            {TIMING_LABELS[key]}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-soft">Keine Transkripte für diese Auswahl.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Datei</th>
                <th className="th">{sortLink("modell", "Modell")}</th>
                <th className="th">Zeiten</th>
                <th className="th">{sortLink("datum", "Transkribiert")}</th>
                <th className="th">{sortLink("dauer", "Dauer")}</th>
                <th className="th">Tokens Ein / Aus</th>
                <th className="th">{sortLink("kosten", "Kosten")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = row.transcript;
                const tokensIn = meta?.usage ? meta.usage.audioInput + meta.usage.textInput : null;
                return (
                  <tr key={row._id}>
                    <td className="td">
                      <Link href={`/aufnahmen/${row._id}`} className="font-mono text-[11.5px] text-petrol hover:underline wrap-anywhere">
                        {row.originalFilename}
                      </Link>
                      {row.historyCount > 0 && (
                        <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                          {row.historyCount} {row.historyCount === 1 ? "frühere Fassung" : "frühere Fassungen"}
                        </span>
                      )}
                    </td>
                    <td className="td font-mono text-[12px]">{meta?.model ?? "–"}</td>
                    <td className="td text-[12px]">{meta ? TIMING_LABELS[meta.timing] : "–"}</td>
                    <td className="td whitespace-nowrap text-[12px] tabular-nums">
                      {meta?.at ? formatDateTimeWithSeconds(meta.at) : "–"}
                    </td>
                    <td className="td tabular-nums">{formatDuration(row.durationMs)}</td>
                    <td className="td text-[12px] tabular-nums">
                      {tokensIn !== null && meta?.usage
                        ? `${tokensIn.toLocaleString("de-CH")} / ${(meta.usage.output + meta.usage.thinking).toLocaleString("de-CH")}`
                        : "–"}
                    </td>
                    <td className="td tabular-nums">{formatUsd(meta?.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="mt-3 flex items-center gap-3 text-[12.5px]" aria-label="Seiten">
          {page > 1 ? (
            <Link href={href({ seite: page - 1 > 1 ? String(page - 1) : null })} className="btn btn-ghost">
              Zurück
            </Link>
          ) : null}
          <span className="tabular-nums text-ink-soft">
            Seite {page} von {pages}
          </span>
          {page < pages ? (
            <Link href={href({ seite: String(page + 1) })} className="btn btn-ghost">
              Weiter
            </Link>
          ) : null}
        </nav>
      )}
    </section>
  );
}
