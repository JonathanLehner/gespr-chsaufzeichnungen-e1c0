"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { logoutAction } from "@/app/actions/auth";
import { NavLink } from "@/components/nav-link";
import type { SessionUser } from "@/lib/types";

/**
 * Kopfbereich des angemeldeten Bereichs.
 *
 * Ab 768 px stehen Marke, Navigation und Kontoangaben nebeneinander. Darunter
 * reicht die Breite dafür nicht: Die Zeile würde die Seite über die
 * Bildschirmbreite hinaus dehnen und damit die gesamte Anwendung herauszoomen.
 * Deshalb bleiben auf schmalen Geräten nur Marke und Menü-Schaltfläche stehen;
 * Navigation, Kontoangaben und Abmelden liegen im aufklappbaren Menü.
 */
export function AppHeader({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const menuId = useId();

  // Der Zustand merkt sich die Seite, auf der das Menü geöffnet wurde. Nach
  // einem Seitenwechsel gilt es damit als geschlossen, ohne dass ein Effekt
  // nachträglich Zustand setzen müsste.
  const [menu, setMenu] = useState({ open: false, path: pathname });
  const open = menu.open && menu.path === pathname;

  const links = (
    <>
      <NavLink href="/aufnahmen">Aufnahmen</NavLink>
      <NavLink href="/upload">Sammelupload</NavLink>
      <NavLink href="/einstellungen">Einstellungen</NavLink>
      {user.isAdmin && <NavLink href="/admin">Admin-Dashboard</NavLink>}
    </>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-5">
        <Link href="/aufnahmen" className="min-w-0 rounded-sm">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">{links}</nav>

        <div className="ml-auto hidden items-center gap-3 md:flex">
          <AccountDetails user={user} align="right" />
          <form action={logoutAction}>
            <button type="submit" className="btn btn-secondary">
              Abmelden
            </button>
          </form>
        </div>

        <button
          type="button"
          className="btn btn-secondary ml-auto px-2.5 md:hidden"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setMenu({ open: !open, path: pathname })}
        >
          <MenuIcon open={open} />
          {open ? "Schliessen" : "Menü"}
        </button>
      </div>

      <div id={menuId} className={`${open ? "block" : "hidden"} border-t border-line md:hidden`}>
        {open && (
          <>
            <nav className="flex flex-col gap-1 px-5 py-3">{links}</nav>
            <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
              <AccountDetails user={user} align="left" />
              <form action={logoutAction}>
                <button type="submit" className="btn btn-secondary w-full">
                  Abmelden
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function AccountDetails({ user, align }: { user: SessionUser; align: "left" | "right" }) {
  return (
    <div className={`min-w-0 leading-tight ${align === "right" ? "text-right" : "text-left"}`}>
      <p className="text-[12px] font-semibold text-ink">{user.name}</p>
      <p className="text-[11px] break-words text-ink-faint">
        {user.email}
        {user.isAdmin && (
          <span className="ml-1.5 rounded-sm bg-petrol-soft px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-petrol">
            Superuser
          </span>
        )}
      </p>
    </div>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      {open ? (
        <>
          <path d="M5 5l10 10" />
          <path d="M15 5L5 15" />
        </>
      ) : (
        <>
          <path d="M3 6h14" />
          <path d="M3 10h14" />
          <path d="M3 14h14" />
        </>
      )}
    </svg>
  );
}
