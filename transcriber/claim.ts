import { claimableFilter, iso, staleLockFilter } from "./shared/queue";

/**
 * Nur die benötigte Methode und ohne Typen des Treibers, damit Dienst und
 * Prüfskripte (jeweils eigene Kopie von `mongodb`) dieselbe Funktion nutzen.
 */
type JobCollection<T> = {
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { sort: Record<string, 1 | -1>; returnDocument: "before" },
  ): Promise<T | null>;
};

/**
 * Übernimmt einen fälligen Auftrag exklusiv: `findOneAndUpdate` prüft Filter
 * und setzt die Sperre in einem Schritt, zwei Plätze können denselben Auftrag
 * also nie gleichzeitig erhalten. Geliefert wird der Stand vor der Übernahme,
 * daran entscheidet sich, ob fortgesetzt oder neu begonnen wird.
 *
 * Verwaiste Aufträge kommen zuerst, älteste Sperre vorne: Sie liefen bereits
 * und sollen nicht hinter der ganzen Warteschlange auf einen Platz warten.
 * Das gilt auch für Aufträge aus der früheren Verarbeitung in der Anfrage, die
 * weder `workerId` noch `lockId` tragen.
 */
export async function claimJob<T>(
  jobs: JobCollection<T>,
  options: { lockId: string; workerId: string; newestFirst: boolean; allowBackground?: boolean; now?: number },
): Promise<T | null> {
  const now = options.now ?? Date.now();
  const lock = {
    $set: { status: "in_arbeit", lockedAt: iso(now), lockId: options.lockId, workerId: options.workerId },
  };
  const reclaimed = await jobs.findOneAndUpdate(staleLockFilter(now), lock, {
    sort: { lockedAt: 1 },
    returnDocument: "before",
  });
  if (reclaimed) return reclaimed;
  // Nachrangige Neu-Transkriptionen (`background`) erst, wenn kein anderer Auftrag fällig ist.
  const regular = await jobs.findOneAndUpdate({ $and: [claimableFilter(now), { background: { $ne: true } }] }, lock, {
    sort: { priority: -1, createdAt: options.newestFirst ? -1 : 1 },
    returnDocument: "before",
  });
  if (regular || options.allowBackground === false) return regular;
  return jobs.findOneAndUpdate({ $and: [claimableFilter(now), { background: true }] }, lock, {
    sort: { priority: -1, createdAt: 1 },
    returnDocument: "before",
  });
}
