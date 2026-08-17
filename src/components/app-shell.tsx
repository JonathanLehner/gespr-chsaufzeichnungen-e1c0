import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { logoutAction } from "@/app/actions/auth";
import type { SessionUser } from "@/lib/types";
import { NavLink } from "@/components/nav-link";

export function AppShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-5">
          <Link href="/aufnahmen" className="rounded-sm">
            <Wordmark />
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink href="/aufnahmen">Aufnahmen</NavLink>
            <NavLink href="/upload">Sammelupload</NavLink>
            {user.isAdmin && <NavLink href="/admin">Admin-Dashboard</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <p className="text-[12px] font-semibold text-ink">{user.name}</p>
              <p className="text-[11px] text-ink-faint">
                {user.email}
                {user.isAdmin && (
                  <span className="ml-1.5 rounded-sm bg-petrol-soft px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-petrol">
                    Superuser
                  </span>
                )}
              </p>
            </div>
            <form action={logoutAction}>
              <button type="submit" className="btn btn-secondary">
                Abmelden
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-6">{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1500px] px-5 py-4 text-[11px] text-ink-faint">
          Immotrust AG · Alle Aufnahmen sind für sämtliche angemeldeten Mitarbeitenden sichtbar.
          Endgültige Löschungen erfolgen ausschliesslich durch die Administration.
        </div>
      </footer>
    </div>
  );
}
