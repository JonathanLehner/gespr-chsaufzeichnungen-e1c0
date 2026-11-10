import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { formatDateTimeWithSeconds, renderTimestamp } from "@/lib/time";
import { haltText } from "@/lib/queue-halt";
import { queueHealth, queueOverview, type QueueHealth, type QueueJobRow } from "@/lib/transcription";
import { StatusBadge } from "@/components/status";
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

export const metadata: Metadata = { title: "Transkription verwalten" };

export default async function TranskriptionAdminPage() {
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

  const health = await queueHealth();
  const overview = await queueOverview(health);
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

        <JobTable
          title={`Laufend und wartend (${overview.counts.in_arbeit + overview.counts.wartend})`}
          note={
            overview.counts.in_arbeit + overview.counts.wartend > overview.waiting.length
              ? `Die ersten ${overview.waiting.length} in Bearbeitungsreihenfolge.`
              : undefined
          }
          empty="Keine offenen Aufträge."
          rows={overview.waiting}
          now={now}
          action={(job) =>
            job.status === "wartend" ? (
              <JobActionButton recordingId={job._id} action="vorne" label="Nach vorne" />
            ) : (
              <span className="text-[12px] text-ink-faint">–</span>
            )
          }
        />

        <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
            Fehlgeschlagen ({overview.counts.fehlgeschlagen})
          </h3>
          <RequeueAllFailedButton count={overview.counts.fehlgeschlagen} />
        </div>
        <JobTable
          empty="Keine fehlgeschlagenen Aufträge."
          rows={overview.failed}
          now={now}
          action={(job) => <JobActionButton recordingId={job._id} action="wiederholen" label="Erneut starten" />}
        />

        <JobTable
          title="Zuletzt abgeschlossen"
          empty="Noch keine abgeschlossenen Aufträge."
          rows={overview.recentlyFinished}
          now={now}
          action={(job) => <JobActionButton recordingId={job._id} action="wiederholen" label="Erneut starten" />}
        />
      </section>

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

function JobTable({
  title,
  note,
  rows,
  empty,
  now,
  action,
}: {
  title?: string;
  note?: string;
  rows: QueueJobRow[];
  empty: string;
  now: number;
  action: (job: QueueJobRow) => React.ReactNode;
}) {
  return (
    <div className={title ? "mt-5" : "mt-2"}>
      {title && <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">{title}</h3>}
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-soft">{empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Datei</th>
                <th className="th">Status</th>
                <th className="th">Eingereiht</th>
                <th className="th">Letzter Versuch</th>
                <th className="th">Versuche</th>
                <th className="th">Meldung</th>
                <th className="th">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => (
                <tr key={job._id}>
                  <td className="td">
                    <Link href={`/aufnahmen/${job._id}`} className="font-mono text-[11.5px] text-petrol hover:underline wrap-anywhere">
                      {job.originalFilename}
                    </Link>
                    {job.priority && job.status === "wartend" ? (
                      <span className="ml-1.5 badge bg-petrol-soft text-petrol">vorgezogen</span>
                    ) : null}
                  </td>
                  <td className="td">
                    <StatusBadge status={job.status} />
                    {job.status === "wartend" && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now && (
                      <span className="mt-0.5 block text-[12px] text-ink-soft tabular-nums">
                        ab {formatDateTimeWithSeconds(job.nextAttemptAt)}
                      </span>
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-[12px] tabular-nums">{formatDateTimeWithSeconds(job.createdAt)}</td>
                  <td className="td whitespace-nowrap text-[12px] tabular-nums">{formatDateTimeWithSeconds(job.finishedAt)}</td>
                  <td className="td tabular-nums">{job.attempts ?? 0}</td>
                  <td className="td max-w-[280px] text-[11.5px] text-bad wrap-anywhere">{job.lastError ?? "–"}</td>
                  <td className="td">{action(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="mt-1.5 text-[12px] text-ink-faint">{note}</p>}
    </div>
  );
}
