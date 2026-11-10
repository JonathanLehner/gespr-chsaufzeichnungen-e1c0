"use client";

import { useEffect, useState } from "react";
import { formatAgo, formatClock, formatDateTime } from "@/lib/time";
import type { TranscriptionStatus } from "@/lib/types";

export type TranscriptionTiming = {
  status: TranscriptionStatus;
  /** Upload oder Neueinreihung; für wartende Aufträge ohne geplanten Versuch. */
  queuedAt: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
  attempts: number;
  progressDone: number | null;
  progressTotal: number | null;
  /** Letzter gesicherter Fortschritt eines laufenden Auftrags. */
  updatedAt: string | null;
};

/** Text hinter dem Status, z. B. „nächster Versuch 17:10“ oder „Abschnitt 3/7 · aktualisiert vor 1 Min.“ */
export function timingText(timing: TranscriptionTiming, nowMs: number): string {
  switch (timing.status) {
    case "wartend": {
      const retry = timing.nextAttemptAt && Date.parse(timing.nextAttemptAt) > nowMs;
      const parts = [
        retry
          ? `nächster Versuch ${formatClock(timing.nextAttemptAt, nowMs)}`
          : `eingereiht ${formatClock(timing.nextAttemptAt ?? timing.queuedAt, nowMs)}`,
      ];
      if (timing.attempts > 0) {
        parts.push(`${timing.attempts} ${timing.attempts === 1 ? "Versuch" : "Versuche"} bisher`);
      }
      return parts.join(" · ");
    }
    case "in_arbeit": {
      const parts: string[] = [];
      const total = timing.progressTotal ?? 0;
      if (total > 1) {
        parts.push(`Abschnitt ${Math.min((timing.progressDone ?? 0) + 1, total)}/${total}`);
      }
      if (timing.updatedAt) parts.push(`aktualisiert ${formatAgo(timing.updatedAt, nowMs)}`);
      return parts.join(" · ");
    }
    default:
      return timing.finishedAt ? formatDateTime(timing.finishedAt) : "";
  }
}

/**
 * Zeitangabe zum Transkriptionsstatus. Startet mit der Zeit des Server-Renders
 * (kein Unterschied bei der Hydrierung) und zählt für offene Aufträge lokal
 * weiter, damit „vor 1 Min.“ nicht veraltet.
 */
export function TranscriptionStatusLine({
  timing,
  renderedAt,
  className = "",
}: {
  timing: TranscriptionTiming;
  renderedAt: number;
  className?: string;
}) {
  const [now, setNow] = useState(renderedAt);
  const open = timing.status === "wartend" || timing.status === "in_arbeit";

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const text = timingText(timing, Math.max(now, renderedAt));
  if (!text) return null;
  return <span className={className}>{text}</span>;
}
