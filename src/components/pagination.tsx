import Link from "next/link";
import type { ReactNode } from "react";

/** Seitennavigation unter einer serverseitig geblätterten Tabelle. */
export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  href,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Seitennavigation">
      <span className="text-[12px] text-ink-soft">
        Einträge {(page - 1) * pageSize + 1} bis {Math.min(page * pageSize, total)} von{" "}
        {total.toLocaleString("de-CH")}
      </span>
      <div className="flex items-center gap-1">
        <PageLink href={href(page - 1)} disabled={page <= 1}>
          Zurück
        </PageLink>
        {pageWindow(page, pageCount).map((entry, index) =>
          entry === null ? (
            <span key={`l-${index}`} className="px-1 text-[12px] text-ink-faint">
              …
            </span>
          ) : (
            <Link
              key={entry}
              href={href(entry)}
              aria-current={entry === page ? "page" : undefined}
              className={`btn ${entry === page ? "btn-primary" : "btn-secondary"} min-w-9`}
            >
              {entry}
            </Link>
          ),
        )}
        <PageLink href={href(page + 1)} disabled={page >= pageCount}>
          Weiter
        </PageLink>
      </div>
    </nav>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: ReactNode }) {
  if (disabled) {
    return (
      <span className="btn btn-secondary opacity-50" aria-disabled>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className="btn btn-secondary">
      {children}
    </Link>
  );
}

function pageWindow(current: number, total: number): (number | null)[] {
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const output: (number | null)[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) output.push(null);
    output.push(page);
    previous = page;
  }
  return output;
}
