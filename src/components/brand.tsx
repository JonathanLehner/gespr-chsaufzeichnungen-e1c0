import Link from "next/link";

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-petrol text-white"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 13v-2M8 16V8M12 19V5M16 16V8M20 13v-2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-[13px] font-semibold tracking-tight text-ink">Immotrust AG</span>
        {!compact && (
          <span className="block text-[11px] text-ink-faint">Gesprächsaufzeichnungen</span>
        )}
      </span>
    </span>
  );
}

export function PublicHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
        <Link prefetch={false} href="/" className="rounded-sm">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-2 text-[13px]">
          <Link prefetch={false} href="/registrieren" className="btn btn-secondary">
            Konto erstellen
          </Link>
          <Link prefetch={false} href="/anmelden" className="btn btn-primary">
            Anmelden
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-[12px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
        <p>Immotrust AG · Interne Anwendung für Gesprächsaufzeichnungen</p>
        <p>Zugang ausschliesslich für Mitarbeitende mit Adresse @immotrustag.ch</p>
      </div>
    </footer>
  );
}
