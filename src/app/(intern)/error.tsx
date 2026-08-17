"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function InternError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const notLoggedIn = error.message === "NICHT_ANGEMELDET";
  const forbidden = error.message === "KEINE_BERECHTIGUNG";

  return (
    <div className="mx-auto max-w-2xl">
      <div className="card p-8">
        <h1 className="text-lg font-semibold text-ink">
          {notLoggedIn
            ? "Ihre Sitzung ist abgelaufen"
            : forbidden
              ? "Keine Berechtigung"
              : "Die Ansicht konnte nicht geladen werden"}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          {notLoggedIn
            ? "Bitte melden Sie sich erneut an, um weiterzuarbeiten."
            : forbidden
              ? "Für diesen Bereich fehlt Ihrem Konto die erforderliche Berechtigung."
              : "Beim Laden der Daten ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut."}
        </p>
        <div className="mt-6 flex gap-2">
          {notLoggedIn ? (
            <Link href="/anmelden" className="btn btn-primary">
              Zur Anmeldung
            </Link>
          ) : (
            <button type="button" className="btn btn-primary" onClick={reset}>
              Erneut versuchen
            </button>
          )}
          <Link href="/aufnahmen" className="btn btn-secondary">
            Zur Aufnahmenübersicht
          </Link>
        </div>
      </div>
    </div>
  );
}
