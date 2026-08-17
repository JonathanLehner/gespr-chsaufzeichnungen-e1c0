import Link from "next/link";

export const LOGO_SRC = "/marke/logo-112.webp";

/** Seitenverhältnis der Originalmarke (public/logo.png, 195 × 197). */
const LOGO_RATIO = 197 / 195;

/** Bildmarke der Immotrust AG. */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  const height = Math.round(size * LOGO_RATIO);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Die Anzeigevariante entsteht zur Bauzeit, eine Optimierung zur Laufzeit ist nicht erwünscht.
    <img
      src={LOGO_SRC}
      width={size}
      height={height}
      alt=""
      aria-hidden
      decoding="async"
      className={className}
      style={{ width: size, height, aspectRatio: "195 / 197" }}
    />
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={32} />
      <span className="leading-tight">
        <span className="block text-[13px] font-semibold tracking-tight text-ink">Immotrust AG</span>
        {!compact && (
          // Auf schmalen Viewports würde die Unterzeile gegen die Kopfzeilen-Schaltflächen laufen.
          <span className="hidden text-[11px] text-ink-faint sm:block">Gesprächsaufzeichnungen</span>
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
        <p className="flex items-center gap-2">
          <Logo size={18} />
          Immotrust AG · Interne Anwendung für Gesprächsaufzeichnungen
        </p>
        <p>© Immotrust AG</p>
      </div>
    </footer>
  );
}
