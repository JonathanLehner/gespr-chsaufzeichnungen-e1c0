import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { RequestResetForm } from "@/components/auth-forms";

export const dynamic = "force-static";

export const metadata: Metadata = { title: "Passwort zurücksetzen" };

export default function PasswortVergessenPage() {
  return (
    <AuthShell
      title="Passwort zurücksetzen"
      intro="Geben Sie Ihre E-Mail-Adresse an. Sie erhalten per E-Mail einen Link, mit dem Sie innerhalb von 60 Minuten ein neues Passwort setzen können. Aus Sicherheitsgründen wird der Link nie im Browser angezeigt. Kommt keine Nachricht an, hilft die Administration weiter."
      footer={
        <Link prefetch={false} href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
          Zurück zur Anmeldung
        </Link>
      }
    >
      <RequestResetForm />
    </AuthShell>
  );
}
