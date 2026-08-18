"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { transcriptionStatusAction } from "@/app/actions/recordings";
import type { TranscriptionStatus } from "@/lib/types";

export type WatchedRecording = {
  id: string;
  status: TranscriptionStatus;
  /** Gesetzt, wenn für einen fehlgeschlagenen Auftrag noch eine Wiederholung aussteht. */
  retryScheduled?: boolean;
};

const OPEN_INTERVAL_MS = 8000;
const RETRY_INTERVAL_MS = 30000;

function signatureOf(entries: { id: string; status: TranscriptionStatus }[]): string {
  return entries
    .map((entry) => `${entry.id}:${entry.status}`)
    .sort()
    .join("|");
}

/**
 * Fragt den Status offener Transkriptionen nach und lädt die Ansicht neu,
 * sobald sich ein Auftrag verändert hat. Beobachtet werden laufende Aufträge
 * und fehlgeschlagene Aufträge, für die noch eine automatische Wiederholung
 * aussteht. Die Abfrage endet, sobald nichts mehr offen ist.
 */
export function TranscriptionWatcher({ entries }: { entries: WatchedRecording[] }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  const ids = entries.map((entry) => entry.id);
  const key = ids.join(",");
  const initialSignature = signatureOf(entries);
  const openCount = entries.filter(
    (entry) => entry.status === "wartend" || entry.status === "in_arbeit",
  ).length;
  const retryCount = entries.length - openCount;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signature = initialSignature;

    const tick = async () => {
      try {
        const updates = await transcriptionStatusAction(key.split(","));
        if (cancelled) return;

        const next = signatureOf(updates);
        if (next !== signature) {
          signature = next;
          router.refresh();
        }

        const open = updates.some(
          (update) => update.status === "wartend" || update.status === "in_arbeit",
        );
        const scheduled = updates.some(
          (update) => update.status === "fehlgeschlagen" && !!update.nextAttemptAt,
        );
        if (open) timer = setTimeout(tick, OPEN_INTERVAL_MS);
        else if (scheduled) timer = setTimeout(tick, RETRY_INTERVAL_MS);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    timer = setTimeout(tick, 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `initialSignature` beschreibt denselben Datenstand wie `key` und würde die
    // Abfrage sonst bei jedem Render neu starten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, router]);

  if (!key) return null;

  return (
    <div className="notice notice-info" role="status">
      {failed
        ? "Der Status der Transkription konnte nicht abgefragt werden. Bitte laden Sie die Seite neu."
        : openCount > 0
          ? `${openCount} ${openCount === 1 ? "Aufnahme wird" : "Aufnahmen werden"} transkribiert. Die Ansicht aktualisiert sich automatisch, sobald das Transkript vorliegt.`
          : `${retryCount} ${retryCount === 1 ? "fehlgeschlagene Transkription wird" : "fehlgeschlagene Transkriptionen werden"} vom System automatisch erneut versucht. Die Ansicht aktualisiert sich dabei selbst.`}
    </div>
  );
}
