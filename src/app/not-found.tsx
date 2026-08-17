import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-5">
          <Link href="/" className="rounded-sm">
            <Wordmark />
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 items-center px-5">
        <div className="card w-full p-8">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-petrol">
            Fehler 404
          </p>
          <h1 className="mt-2 text-xl font-semibold text-ink">Seite nicht gefunden</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Die angeforderte Seite existiert nicht oder die Aufnahme wurde endgültig gelöscht.
          </p>
          <div className="mt-6 flex gap-2">
            <Link href="/aufnahmen" className="btn btn-primary">
              Zur Aufnahmenübersicht
            </Link>
            <Link href="/" className="btn btn-secondary">
              Zur Startseite
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
