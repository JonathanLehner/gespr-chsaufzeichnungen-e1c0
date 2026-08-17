"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-[4px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "bg-petrol-soft text-petrol" : "text-ink-soft hover:bg-canvas hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
