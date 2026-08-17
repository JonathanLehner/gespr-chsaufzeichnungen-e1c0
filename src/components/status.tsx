import type { TranscriptionStatus } from "@/lib/types";

const STATUS_STYLE: Record<TranscriptionStatus, { label: string; className: string }> = {
  wartend: { label: "Wartend", className: "bg-warn-soft text-warn" },
  in_arbeit: { label: "In Verarbeitung", className: "bg-busy-soft text-busy" },
  abgeschlossen: { label: "Abgeschlossen", className: "bg-ok-soft text-ok" },
  fehlgeschlagen: { label: "Fehlgeschlagen", className: "bg-bad-soft text-bad" },
};

export function StatusBadge({ status }: { status: TranscriptionStatus }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.wartend;
  return (
    <span className={`badge ${style.className}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {style.label}
    </span>
  );
}

export function statusLabel(status: TranscriptionStatus): string {
  return (STATUS_STYLE[status] ?? STATUS_STYLE.wartend).label;
}

export function DeletionBadge({ flagged }: { flagged: boolean }) {
  if (!flagged) return <span className="text-[12px] text-ink-faint">–</span>;
  return <span className="badge bg-bad-soft text-bad">Zur Löschung markiert</span>;
}

export function RatingValue({ average, count }: { average: number | null; count: number }) {
  if (average === null || count === 0) {
    return <span className="text-[12px] text-ink-faint">–</span>;
  }
  const tone =
    average >= 8 ? "text-ok" : average >= 5 ? "text-ink" : "text-bad";
  return (
    <span className="whitespace-nowrap">
      <span className={`text-[14px] font-semibold ${tone}`}>
        {average.toLocaleString("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
      </span>
      <span className="text-[11px] text-ink-faint"> /10 · {count}</span>
    </span>
  );
}
