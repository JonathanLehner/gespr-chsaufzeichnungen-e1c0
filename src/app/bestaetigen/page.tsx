import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { verifyEmailAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "E-Mail-Adresse bestätigen" };

export default async function BestaetigenPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = await verifyEmailAction(token ?? "");
  const failed = result.status === "fehler";

  return (
    <AuthShell
      title="E-Mail-Adresse bestätigen"
      intro={
        failed
          ? "Die Bestätigung konnte nicht abgeschlossen werden."
          : "Ihr Konto ist jetzt freigeschaltet."
      }
      footer={
        <div className="flex flex-wrap gap-4 text-ink-soft">
          <Link href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
            Zur Anmeldung
          </Link>
          {failed && (
            <Link
              href="/registrieren"
              className="font-semibold text-petrol underline underline-offset-2"
            >
              Neuen Bestätigungslink anfordern
            </Link>
          )}
        </div>
      }
    >
      <div className={`notice ${failed ? "notice-error" : "notice-ok"}`} role="alert">
        {result.message}
      </div>
      {failed && (
        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          Bestätigungslinks sind 24 Stunden gültig und lassen sich nur einmal verwenden. Melden Sie
          sich erneut an oder registrieren Sie sich mit derselben Adresse, um einen frischen Link zu
          erhalten.
        </p>
      )}
    </AuthShell>
  );
}
