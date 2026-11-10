"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { transcriptionStatusAction } from "@/app/actions/recordings";
import { liveFailures, subscribeLive, type LiveState } from "@/lib/live-client";
import type { TranscriptionStatus } from "@/lib/types";

export type WatchedRecording = {
  id: string;
  status: TranscriptionStatus;
  /** Fertige Abschnitte eines laufenden Auftrags; eine Änderung lädt die Ansicht neu. */
  progressDone?: number | null;
};

/** Mindestabstand zweier Neuladungen im Modus „alles“. */
const REFRESH_GAP_MS = 5000;

function signatureOf(
  entries: { id: string; status: TranscriptionStatus; progressDone?: number | null }[],
): string {
  return entries
    .map((entry) => `${entry.id}:${entry.status}:${entry.progressDone ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Hält die Ansicht offener Transkriptionen aktuell. Der Live-Kanal meldet
 * jede Änderung an Status, Fortschritt oder Lebenszeichen; daraufhin wird der
 * Stand der beobachteten Aufnahmen frisch aus der Datenbank gelesen und die
 * Ansicht neu geladen, sobald sich etwas verändert hat. Beobachtet werden
 * laufende und wartende Aufträge sowie fehlgeschlagene mit ausstehender
 * Wiederholung; ist nichts mehr offen, endet die Verbindung.
 *
 * `mode="alles"` (Admin-Dashboard): jede Meldung lädt die Ansicht neu,
 * höchstens alle 5 s, damit auch neu begonnene Aufträge und das
 * Lebenszeichen sofort erscheinen. Die Verbindung bleibt dort offen, solange
 * die Seite offen ist.
 */
export function TranscriptionWatcher({
  entries,
  mode = "eintraege",
  quiet = false,
}: {
  entries: WatchedRecording[];
  mode?: "eintraege" | "alles";
  quiet?: boolean;
}) {
  const router = useRouter();
  const [liveState, setLiveState] = useState<LiveState>("verbindet");

  const ids = entries.map((entry) => entry.id);
  // Im Modus „alles“ besteht die Verbindung auch ohne offene Einträge: Neue Aufträge erscheinen sofort.
  const key = mode === "alles" ? "alles" : ids.join(",");
  const initialSignature = signatureOf(entries);
  const openCount = entries.filter(
    (entry) => entry.status === "wartend" || entry.status === "in_arbeit",
  ).length;
  const retryCount = entries.length - openCount;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let running = false;
    let again = false;
    let signature = initialSignature;
    let lastRefresh = 0;
    let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | null = null;

    const refresh = () => {
      const wait = lastRefresh + REFRESH_GAP_MS - Date.now();
      if (wait > 0) {
        pendingRefresh ??= setTimeout(() => {
          pendingRefresh = undefined;
          lastRefresh = Date.now();
          router.refresh();
        }, wait);
        return;
      }
      lastRefresh = Date.now();
      router.refresh();
    };

    const check = async () => {
      if (mode === "alles") {
        refresh();
        return;
      }
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const updates = await transcriptionStatusAction(key.split(","));
        if (cancelled) return;
        const next = signatureOf(updates);
        if (next !== signature) {
          signature = next;
          router.refresh();
        }
        const open = updates.some(
          (update) =>
            update.status === "wartend" ||
            update.status === "in_arbeit" ||
            (update.status === "fehlgeschlagen" && !!update.nextAttemptAt),
        );
        if (!open) {
          unsubscribe?.();
          unsubscribe = null;
        }
      } catch {
        // Die nächste Meldung des Live-Kanals versucht es erneut.
      } finally {
        running = false;
        if (again && !cancelled && unsubscribe) {
          again = false;
          void check();
        }
      }
    };

    unsubscribe = subscribeLive(() => void check(), setLiveState);
    return () => {
      cancelled = true;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      unsubscribe?.();
    };
    // `initialSignature` beschreibt denselben Datenstand wie `key` und würde die
    // Verbindung sonst bei jedem Render neu aufbauen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mode, router]);

  if (!key) return null;
  const disconnected = liveState === "getrennt" && liveFailures() >= 3;

  if (disconnected) {
    return (
      <div className="notice notice-warn" role="status">
        Die Live-Aktualisierung ist unterbrochen. Laden Sie die Seite neu, um den aktuellen Stand zu
        sehen.
      </div>
    );
  }
  if (quiet) return null;

  return (
    <div className="notice notice-info" role="status">
      {openCount > 0
        ? `${openCount} ${openCount === 1 ? "Aufnahme wird" : "Aufnahmen werden"} transkribiert. Die Ansicht aktualisiert sich automatisch, sobald das Transkript vorliegt.`
        : `${retryCount} ${retryCount === 1 ? "fehlgeschlagene Transkription wird" : "fehlgeschlagene Transkriptionen werden"} vom System automatisch erneut versucht. Die Ansicht aktualisiert sich dabei selbst.`}
    </div>
  );
}
