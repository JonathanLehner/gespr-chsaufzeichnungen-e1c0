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

  if (failed) {
    return (
      <AuthShell
        tone="error"
        title="Die Bestätigung konnte nicht abgeschlossen werden"
        intro={
          <>
            <p>{result.message}</p>
            <p>
              Bestätigungslinks sind 24 Stunden gültig und lassen sich nur einmal verwenden. Mit
              derselben Adresse erhalten Sie einen neuen Link.
            </p>
          </>
        }
      >
        <div className="flex flex-wrap gap-3">
          <Link href="/registrieren" className="btn btn-primary min-h-11">
            Neuen Bestätigungslink anfordern
          </Link>
          <Link href="/anmelden" className="btn btn-secondary min-h-11">
            Zur Anmeldung
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="E-Mail-Adresse bestätigen"
      intro="Ihr Konto ist jetzt freigeschaltet."
      footer={
        <Link href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
          Zur Anmeldung
        </Link>
      }
    >
      <div className="notice notice-ok" role="alert">
        {result.message}
      </div>
    </AuthShell>
  );
}
