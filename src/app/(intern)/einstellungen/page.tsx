import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { Collections, findById } from "@/lib/db";
import { formatDateTimeWithSeconds } from "@/lib/time";
import { ProfileNameForm } from "@/components/profile-form";
import type { User } from "@/lib/types";

export const metadata: Metadata = { title: "Einstellungen" };

export default async function EinstellungenPage() {
  const session = await requireUser();
  const account = await findById<User>(Collections.users, session.email);
  const name = account?.name ?? session.name;

  const details: [string, React.ReactNode][] = [
    ["E-Mail-Adresse", <span key="e" className="font-mono text-[12px]">{session.email}</span>],
    [
      "Rolle",
      session.isAdmin ? (
        <span key="r" className="badge bg-petrol-soft text-petrol">
          Superuser
        </span>
      ) : (
        "Mitarbeitend"
      ),
    ],
    ["Konto angelegt", formatDateTimeWithSeconds(account?.createdAt ?? null)],
    ["Letzte Anmeldung", formatDateTimeWithSeconds(account?.lastLoginAt ?? null)],
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Einstellungen</h1>
        <p className="mt-1 text-[13px] text-ink-soft">
          Angaben zu Ihrem Konto. Die E-Mail-Adresse bleibt unverändert – sie ist zugleich die
          Kennung Ihres Kontos.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Angezeigter Name</h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
          Beim Anlegen eines Kontos wird der Name aus der Registrierung übernommen und, wo keiner
          angegeben wurde, aus der E-Mail-Adresse abgeleitet. Passt die Schreibweise nicht, ändern
          Sie sie hier selbst.
        </p>
        <ProfileNameForm currentName={name} />
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Konto</h2>
        <dl className="mt-3 space-y-1.5">
          {details.map(([term, value]) => (
            <div key={term} className="flex gap-3 border-b border-line/70 pb-1.5 last:border-0">
              <dt className="w-[46%] shrink-0 text-[12.5px] text-ink-faint sm:w-[32%]">{term}</dt>
              <dd className="min-w-0 flex-1 text-[13px] text-ink wrap-anywhere">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink">Passwort</h2>
        {/* Die Adresse des Superusers steht hier bewusst nicht: Die Seite sehen
            alle Mitarbeitenden, und die Anwendung gibt sie sonst nirgends preis. */}
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
          Das Passwort wird über den Link „Passwort vergessen“ auf der Anmeldeseite neu gesetzt.
          Kommt die E-Mail nicht an, erzeugt die Administration im Admin-Dashboard einen Link.
        </p>
        <Link href="/passwort-vergessen" className="btn btn-secondary mt-4">
          Passwort zurücksetzen
        </Link>
      </section>
    </div>
  );
}
