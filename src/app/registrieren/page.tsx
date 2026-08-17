import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "@/components/auth-forms";

export const dynamic = "force-static";

export const metadata: Metadata = { title: "Registrieren" };

export default function RegistrierenPage() {
  return (
    <AuthShell
      title="Konto erstellen"
      intro="Die Registrierung steht Mitarbeitenden mit einer Adresse @immotrustag.ch offen. Nach dem Anlegen bestätigen Sie Ihre E-Mail-Adresse und können sich danach anmelden."
      footer={
        <span className="text-ink-soft">
          Bereits registriert?{" "}
          <Link prefetch={false} href="/anmelden" className="font-semibold text-petrol underline underline-offset-2">
            Zur Anmeldung
          </Link>
        </span>
      }
    >
      <RegisterForm />
    </AuthShell>
  );
}
