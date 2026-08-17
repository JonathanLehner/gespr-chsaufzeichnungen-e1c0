import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Neues Passwort setzen" };

export default async function PasswortNeuPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <AuthShell
        title="Neues Passwort setzen"
        intro="Dieser Aufruf enthält keinen gültigen Link."
        footer={
          <Link
            href="/passwort-vergessen"
            className="font-semibold text-petrol underline underline-offset-2"
          >
            Neuen Link anfordern
          </Link>
        }
      >
        <div className="notice notice-error" role="alert">
          Der Link ist unvollständig oder wurde beim Kopieren abgeschnitten. Bitte fordern Sie einen
          neuen Link zum Zurücksetzen an.
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Neues Passwort setzen"
      intro="Vergeben Sie ein neues Passwort. Alle bestehenden Sitzungen werden dabei abgemeldet."
      footer={
        <Link href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
          Zurück zur Anmeldung
        </Link>
      }
    >
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
