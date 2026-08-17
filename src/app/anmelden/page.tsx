import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";

export const dynamic = "force-static";

export const metadata: Metadata = { title: "Anmelden" };

export default function AnmeldenPage() {
  return (
    <AuthShell
      title="Anmelden"
      intro="Melden Sie sich mit Ihrer geschäftlichen E-Mail-Adresse und Ihrem Passwort an."
      footer={
        <div className="flex flex-wrap justify-between gap-3 text-ink-soft">
          <Link prefetch={false} href="/passwort-vergessen" className="underline underline-offset-2">
            Passwort vergessen?
          </Link>
          <span>
            Noch kein Konto?{" "}
            <Link prefetch={false} href="/registrieren" className="font-semibold text-petrol underline underline-offset-2">
              Jetzt registrieren
            </Link>
          </span>
        </div>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
