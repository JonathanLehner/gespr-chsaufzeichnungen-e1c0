import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentUser, SUPERUSER_EMAIL } from "@/lib/auth";
import { Collections, countDocuments, findMany } from "@/lib/db";
import { displayableLink } from "@/lib/mail-outbox";
import { DELIVERY_LABELS, PROVIDER_LABELS } from "@/lib/mail-config";
import { mailOverview } from "@/lib/mailer";
import { getTemplateSettings } from "@/lib/settings";
import { countByStatus, listAllComments, listJobs, listRecordings } from "@/lib/recordings";
import { formatDateTime, formatDateTimeWithSeconds } from "@/lib/time";
import { StatusBadge } from "@/components/status";
import { TemplateEditor } from "@/components/template-editor";
import { MailSettingsEditor } from "@/components/mail-settings-editor";
import {
  CommentDeleteButton,
  HardDeleteButton,
  ResetLinkButton,
  RetryButton,
  RunQueueButton,
} from "@/components/admin-controls";
import type { MailDeliveryStatus, MailOutboxEntry, User } from "@/lib/types";

export const metadata: Metadata = { title: "Admin-Dashboard" };

export default async function AdminPage() {
  const user = await getCurrentUser();

  if (!user?.isAdmin) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="card p-8">
          <h1 className="text-lg font-semibold text-ink">Kein Zugriff</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Das Admin-Dashboard steht ausschliesslich {SUPERUSER_EMAIL} zur Verfügung. Ihr Konto
            {user ? ` (${user.email})` : ""} verfügt nicht über die erforderliche Berechtigung. Alle
            administrativen Endpunkte prüfen diese Berechtigung zusätzlich serverseitig.
          </p>
          <Link href="/aufnahmen" className="btn btn-primary mt-5">
            Zurück zu den Aufnahmen
          </Link>
        </div>
      </div>
    );
  }

  const [settings, jobs, statusCounts, flagged, users, outbox, totalRecordings, mailSetup] =
    await Promise.all([
      getTemplateSettings(),
      listJobs(),
      countByStatus(),
      listRecordings({ loeschstatus: "nur_markiert", pageSize: 100, sort: "hochgeladen_neu" }),
      findMany<User>(Collections.users, {}),
      findMany<MailOutboxEntry>(Collections.mailOutbox, {}),
      countDocuments(Collections.recordings, {}),
      mailOverview(),
    ]);

  const [commentCount, ratingCount, commentOverview] = await Promise.all([
    countDocuments(Collections.comments, {}),
    countDocuments(Collections.ratings, {}),
    listAllComments(),
  ]);

  const flaggedCommentCounts = new Map(
    await Promise.all(
      flagged.rows.map(
        async (row) =>
          [row._id, await countDocuments(Collections.comments, { recordingId: row._id })] as const,
      ),
    ),
  );

  const running = jobs.filter((job) => job.status === "in_arbeit" || job.status === "wartend");
  const failed = jobs.filter((job) => job.status === "fehlgeschlagen");
  const finished = jobs
    .filter((job) => job.status === "abgeschlossen")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, 10);

  // Der Reset-Link wird schon beim Laden entfernt und erreicht den Browser
  // dadurch gar nicht erst – die Anzeige weiter unten kann ihn nicht versehentlich
  // wieder hervorholen.
  const recentMails = [...outbox]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .map((mail) => ({ ...mail, link: displayableLink(mail) }));

  const metrics = [
    { label: "Aufnahmen gesamt", value: totalRecordings },
    { label: "Transkription abgeschlossen", value: statusCounts.abgeschlossen },
    { label: "Wartend", value: statusCounts.wartend },
    { label: "In Verarbeitung", value: statusCounts.in_arbeit },
    { label: "Fehlgeschlagen", value: statusCounts.fehlgeschlagen },
    { label: "Zur Löschung markiert", value: flagged.total },
    { label: "Kommentare", value: commentCount },
    { label: "Bewertungen", value: ratingCount },
    { label: "Konten", value: users.length },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Admin-Dashboard</h1>
        <p className="mt-1 text-[13px] text-ink-soft">
          Angemeldet als Superuser {user.email}. Dateinamensvorlage, Verarbeitungsaufträge und
          endgültige Löschungen werden hier gesteuert.
        </p>
      </div>

      <section className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.label} className="bg-surface p-4">
            <p className="text-2xl font-semibold tabular-nums text-ink">
              {metric.value.toLocaleString("de-CH")}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">{metric.label}</p>
          </div>
        ))}
      </section>

      <TemplateEditor
        initialTemplate={settings.template}
        version={settings.version}
        updatedAt={settings.updatedAt}
        updatedBy={settings.updatedBy}
        history={settings.history}
      />

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-ink">Upload- und Transkriptionsaufträge</h2>
          <RunQueueButton />
        </div>

        <JobTable
          title={`Laufend und wartend (${running.length})`}
          empty="Keine offenen Aufträge."
          rows={running.map((job) => ({
            id: job.recordingId,
            filename: job.originalFilename,
            status: job.status,
            created: job.createdAt,
            started: job.startedAt,
            finished: job.finishedAt,
            attempts: job.attempts,
            error: job.lastError,
            action: null,
          }))}
        />

        <JobTable
          title={`Fehlgeschlagen (${failed.length})`}
          empty="Keine fehlgeschlagenen Aufträge."
          rows={failed.map((job) => ({
            id: job.recordingId,
            filename: job.originalFilename,
            status: job.status,
            created: job.createdAt,
            started: job.startedAt,
            finished: job.finishedAt,
            attempts: job.attempts,
            error: job.lastError,
            action: <RetryButton recordingId={job.recordingId} />,
          }))}
        />

        <JobTable
          title={`Zuletzt abgeschlossen (${finished.length})`}
          empty="Noch keine abgeschlossenen Aufträge."
          rows={finished.map((job) => ({
            id: job.recordingId,
            filename: job.originalFilename,
            status: job.status,
            created: job.createdAt,
            started: job.startedAt,
            finished: job.finishedAt,
            attempts: job.attempts,
            error: null,
            action: <RetryButton recordingId={job.recordingId} />,
          }))}
        />
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">
          Zur Löschung markierte Aufnahmen ({flagged.total})
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">
          Markierungen von Mitarbeitenden entfernen keine Daten. Erst die Bestätigung an dieser
          Stelle löscht Audio, Transkript, Kommentare und Bewertungen endgültig.
        </p>

        {flagged.rows.length === 0 ? (
          <p className="mt-4 text-[13px] text-ink-soft">
            Zurzeit ist keine Aufnahme zur Löschung markiert.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead className="bg-canvas">
                <tr>
                  <th className="th">Aufnahme</th>
                  <th className="th">Gesprächszeitpunkt</th>
                  <th className="th">Markiert von</th>
                  <th className="th">Markiert am</th>
                  <th className="th">Grund</th>
                  <th className="th">Bewertungen</th>
                  <th className="th">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {flagged.rows.map((row) => (
                  <tr key={row._id}>
                    <td className="td">
                      <Link href={`/aufnahmen/${row._id}`} className="text-petrol hover:underline">
                        {row.callerName}
                      </Link>
                      <span className="mt-0.5 block font-mono text-[11px] text-ink-faint">
                        {row.originalFilename}
                      </span>
                    </td>
                    <td className="td whitespace-nowrap">{formatDateTime(row.callAtUtc)}</td>
                    <td className="td">{row.deletionFlaggedBy}</td>
                    <td className="td whitespace-nowrap">
                      {formatDateTimeWithSeconds(row.deletionFlaggedAt)}
                    </td>
                    <td className="td">{row.deletionReason || "–"}</td>
                    <td className="td tabular-nums">{row.ratingCount}</td>
                    <td className="td">
                      <HardDeleteButton
                        recordingId={row._id}
                        filename={row.originalFilename}
                        callerName={row.callerName}
                        commentCount={flaggedCommentCounts.get(row._id) ?? 0}
                        ratingCount={row.ratingCount}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Kommentare ({commentCount})</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
          Mitarbeitende bearbeiten und löschen ausschliesslich ihre eigenen Kommentare. Fremde
          Beiträge – etwa eine falsch zugeordnete Beobachtung – entfernen Sie hier. Die Aufnahme
          selbst bleibt dabei unberührt.
          {commentOverview.truncated
            ? " Es werden nicht alle Kommentare geladen; öffnen Sie in diesem Fall die Aufnahme direkt."
            : ""}
        </p>

        {commentOverview.rows.length === 0 ? (
          <p className="mt-4 text-[13px] text-ink-soft">Es besteht noch kein Kommentar.</p>
        ) : (
          <>
            <ul className="mt-4 space-y-2">
              {commentOverview.rows.map((comment) => (
                <li key={comment._id} className="rounded-[4px] border border-line bg-canvas/60 p-3">
                  <div className="flex flex-wrap items-baseline gap-2 wrap-anywhere">
                    <span className="text-[13px] font-semibold text-ink">{comment.authorName}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {comment.authorEmail}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      {formatDateTimeWithSeconds(comment.createdAt)}
                    </span>
                    {comment.editedAt && (
                      <span className="text-[11px] italic text-ink-faint">
                        bearbeitet am {formatDateTimeWithSeconds(comment.editedAt)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] text-ink-faint wrap-anywhere">
                    zu{" "}
                    <Link
                      href={`/aufnahmen/${comment.recordingId}`}
                      className="text-petrol hover:underline"
                    >
                      {comment.callerName}
                    </Link>{" "}
                    <span className="font-mono">{comment.originalFilename}</span>
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink wrap-anywhere">
                    {comment.text}
                  </p>
                  <div className="mt-2">
                    <CommentDeleteButton
                      commentId={comment._id}
                      authorName={comment.authorName}
                    />
                  </div>
                </li>
              ))}
            </ul>
            {commentOverview.total > commentOverview.rows.length && (
              <p className="mt-3 text-[12px] text-ink-faint">
                Angezeigt werden die {commentOverview.rows.length} neuesten von{" "}
                {commentOverview.total} geladenen Kommentaren.
              </p>
            )}
          </>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Konten ({users.length})</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
          Kommt eine Reset-Mail nicht an, erzeugt „Reset-Link erzeugen“ einen neuen Link. Er wird
          zusätzlich per E-Mail verschickt und Ihnen einmalig angezeigt, damit Sie ihn persönlich
          weitergeben können. Geben Sie ihn ausschliesslich an die Person weiter, der das Konto
          gehört – wer den Link hat, kann das Passwort setzen.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Name</th>
                <th className="th">E-Mail</th>
                <th className="th">Rolle</th>
                <th className="th">Bestätigt</th>
                <th className="th">Passwort</th>
              </tr>
            </thead>
            <tbody>
              {users.map((account) => (
                <tr key={account._id}>
                  <td className="td">{account.name}</td>
                  <td className="td font-mono text-[11.5px]">{account.email}</td>
                  <td className="td">
                    {account.role === "admin" ? (
                      <span className="badge bg-petrol-soft text-petrol">Superuser</span>
                    ) : (
                      "Mitarbeitend"
                    )}
                  </td>
                  <td className="td">
                    {account.emailVerified ? (
                      <span className="badge bg-ok-soft text-ok">ja</span>
                    ) : (
                      <span className="badge bg-warn-soft text-warn">offen</span>
                    )}
                  </td>
                  <td className="td w-[22rem] align-top">
                    <ResetLinkButton email={account.email} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <MailSettingsEditor
        settings={mailSetup.settings}
        config={mailSetup.config}
        testAddress={user.email}
      />

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Postausgang</h2>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink-soft">
          Protokoll der zuletzt verschickten Bestätigungs- und Reset-Mails samt Zustellstand.
          Bestätigungslinks bleiben einsehbar, Links zum Zurücksetzen des Passworts nicht: Sie
          entstehen ausschliesslich per E-Mail oder über „Reset-Link erzeugen“ in der Kontenliste,
          wo sie genau einmal angezeigt werden.
        </p>
        {recentMails.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-soft">Noch keine Links erzeugt.</p>
        ) : (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {recentMails.map((mail) => (
              <li key={mail._id} className="rounded-[4px] border border-line bg-canvas/60 p-2">
                <p className="text-[12.5px] text-ink wrap-anywhere">
                  <strong>{mail.to}</strong> ·{" "}
                  {mail.kind === "bestaetigung" ? "E-Mail-Bestätigung" : "Passwort zurücksetzen"}{" "}
                  <DeliveryBadge status={mail.deliveryStatus} />
                </p>
                <p className="text-[11px] text-ink-faint">
                  erzeugt {formatDateTimeWithSeconds(mail.createdAt)} · gültig bis{" "}
                  {formatDateTimeWithSeconds(mail.expiresAt)}
                  {mail.deliveryProvider && mail.deliveryProvider !== "protokoll"
                    ? ` · ${PROVIDER_LABELS[mail.deliveryProvider]}`
                    : ""}
                  {mail.issuedBy ? ` · erzeugt von ${mail.issuedBy}` : ""}
                </p>
                {mail.deliveryError && (
                  <p className="mt-0.5 text-[11px] text-bad">{mail.deliveryError}</p>
                )}
                {mail.link ? (
                  <Link
                    href={mail.link}
                    className="mt-0.5 block truncate font-mono text-[11px] text-petrol hover:underline"
                  >
                    {mail.link}
                  </Link>
                ) : (
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    Link aus Sicherheitsgründen ausgeblendet.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DeliveryBadge({ status }: { status: MailDeliveryStatus | undefined }) {
  if (!status) return null;
  const tone =
    status === "gesendet"
      ? "bg-ok-soft text-ok"
      : status === "fehlgeschlagen"
        ? "bg-bad-soft text-bad"
        : "bg-warn-soft text-warn";
  return <span className={`badge ${tone}`}>{DELIVERY_LABELS[status]}</span>;
}

type JobRow = {
  id: string;
  filename: string;
  status: "wartend" | "in_arbeit" | "abgeschlossen" | "fehlgeschlagen";
  created: string;
  started: string | null;
  finished: string | null;
  attempts: number;
  error: string | null;
  action: React.ReactNode;
};

function JobTable({ title, rows, empty }: { title: string; rows: JobRow[]; empty: string }) {
  return (
    <div className="mt-5">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-soft">{empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead className="bg-canvas">
              <tr>
                <th className="th">Datei</th>
                <th className="th">Status</th>
                <th className="th">Erstellt</th>
                <th className="th">Gestartet</th>
                <th className="th">Beendet</th>
                <th className="th">Versuche</th>
                <th className="th">Meldung</th>
                <th className="th">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="td">
                    <Link href={`/aufnahmen/${row.id}`} className="font-mono text-[11.5px] text-petrol hover:underline">
                      {row.filename}
                    </Link>
                  </td>
                  <td className="td">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="td whitespace-nowrap text-[12px]">
                    {formatDateTimeWithSeconds(row.created)}
                  </td>
                  <td className="td whitespace-nowrap text-[12px]">
                    {formatDateTimeWithSeconds(row.started)}
                  </td>
                  <td className="td whitespace-nowrap text-[12px]">
                    {formatDateTimeWithSeconds(row.finished)}
                  </td>
                  <td className="td tabular-nums">{row.attempts}</td>
                  <td className="td max-w-[280px] text-[11.5px] text-bad">{row.error ?? "–"}</td>
                  <td className="td">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
