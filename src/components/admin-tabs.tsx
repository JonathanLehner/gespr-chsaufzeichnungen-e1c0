"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Übersicht" },
  { href: "/admin/transkription", label: "Transkription" },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin-Bereiche" className="mt-3 flex gap-1 border-b border-line">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              active ? "border-petrol text-petrol" : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
