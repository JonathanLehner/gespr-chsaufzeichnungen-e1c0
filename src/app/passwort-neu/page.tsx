import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordForm } from "@/components/auth-forms";
import { checkResetTokenAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Neues Passwort setzen" };

export default async function PasswortNeuPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const check = token ? await checkResetTokenAction(token) : null;
  const problem = !token
    ? "Der Link ist unvollständig oder wurde beim Kopieren abgeschnitten. Bitte fordern Sie einen neuen Link zum Zurücksetzen an."
    : check && !check.ok
      ? check.message
      : null;

  if (!token || problem) {
    return (
      <AuthShell
        title="Neues Passwort setzen"
        intro="Dieser Link kann nicht verwendet werden."
        footer={
          <Link href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
            Zurück zur Anmeldung
          </Link>
        }
      >
        <div className="notice notice-error" role="alert">
          {problem}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          Links zum Zurücksetzen sind 60 Minuten gültig und lassen sich nur einmal verwenden.
        </p>
        <Link href="/passwort-vergessen" className="btn btn-primary mt-5">
          Neuen Link anfordern
        </Link>
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
