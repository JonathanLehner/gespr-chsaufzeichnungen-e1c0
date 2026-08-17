"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { transcriptionStatusAction } from "@/app/actions/recordings";

/**
 * Fragt den Status offener Transkriptionen nach und lädt die Ansicht neu,
 * sobald ein Auftrag abgeschlossen oder fehlgeschlagen ist. Die Abfrage endet,
 * sobald keine offenen Aufträge mehr in der Liste stehen.
 */
export function TranscriptionWatcher({ ids }: { ids: string[] }) {
  const router = useRouter();
  const key = ids.join(",");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const updates = await transcriptionStatusAction(key.split(","));
        if (cancelled) return;
        const done = updates.some(
          (update) => update.status === "abgeschlossen" || update.status === "fehlgeschlagen",
        );
        const pending = updates.some(
          (update) => update.status === "wartend" || update.status === "in_arbeit",
        );
        if (done) router.refresh();
        if (pending) timer = setTimeout(tick, 8000);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    timer = setTimeout(tick, 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, router]);

  if (!key) return null;

  return (
    <div className="notice notice-info" role="status">
      {failed
        ? "Der Status der Transkription konnte nicht abgefragt werden. Bitte laden Sie die Seite neu."
        : `${ids.length} ${ids.length === 1 ? "Aufnahme wird" : "Aufnahmen werden"} transkribiert. Die Ansicht aktualisiert sich automatisch, sobald das Transkript vorliegt.`}
    </div>
  );
}
