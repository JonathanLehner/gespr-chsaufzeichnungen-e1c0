import { AppHeader } from "@/components/app-header";
import type { SessionUser } from "@/lib/types";

export function AppShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-6">{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1500px] px-5 py-4 text-[11px] text-ink-faint">
          Immotrust AG · Alle Aufnahmen sind für sämtliche angemeldeten Mitarbeitenden sichtbar.
        </div>
      </footer>
    </div>
  );
}
