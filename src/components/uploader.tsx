"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { prepareUploadAction, type PreparedProblem } from "@/app/actions/recordings";
import { formatDateTime, localInputToUtcIso, utcIsoToLocalInput } from "@/lib/time";

type Metadata = {
  callerName: string;
  callerFirstName: string;
  callerLastName: string;
  phoneNumber: string;
  callNumber: string;
  callAtUtc: string;
};

type ItemStatus =
  | "bereit"
  | "problem"
  | "gesperrt"
  | "laeuft"
  | "fertig"
  | "fehler"
  | "vorhanden";

type Item = {
  key: string;
  file: File;
  status: ItemStatus;
  problem: string | null;
  reason: PreparedProblem | null;
  duplicate: boolean;
  metadata: Metadata | null;
  source: "dateiname" | "manuell";
  progress: number;
  message: string | null;
  recordingId: string | null;
  durationMs: number | null;
};

const ACCEPTED = [".wav", ".mp3"];

/** Beschriftung des Warnhinweises in der Statusspalte. */
const REASON_LABEL: Record<PreparedProblem, string> = {
  format: "Format nicht unterstützt",
  "zu-gross": "Datei zu gross",
  leer: "Datei leer",
  dateiname: "Dateiname nicht lesbar",
  vorhanden: "Bereits vorhanden",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function itemKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

/** Liest die Spieldauer einer Datei im Browser aus, damit sie in der Übersicht steht. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () =>
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => done(null);
    audio.src = url;
    setTimeout(() => done(null), 8000);
  });
}

function uploadFile(
  item: Item,
  onProgress: (percent: number) => void,
): Promise<{ status: string; id?: string; message: string }> {
  return new Promise((resolve) => {
    const body = new FormData();
    body.append("datei", item.file);
    body.append(
      "metadaten",
      JSON.stringify({
        ...item.metadata,
        metadataSource: item.source,
        durationMs: item.durationMs,
      }),
    );
    const request = new XMLHttpRequest();
    request.open("POST", "/api/upload");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      try {
        resolve(JSON.parse(request.responseText));
      } catch {
        resolve({ status: "fehler", message: `Unerwartete Antwort des Servers (${request.status}).` });
      }
    };
    request.onerror = () =>
      resolve({ status: "fehler", message: "Die Verbindung wurde während des Uploads unterbrochen." });
    request.send(body);
  });
}

export function Uploader({ template }: { template: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [analysing, setAnalysing] = useState(false);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = useCallback((key: string, patch: Partial<Item>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const addFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;
      setAnalysing(true);
      try {
        const fresh = incoming.filter(
          (file) => !items.some((item) => item.key === itemKey(file)),
        );
        if (fresh.length === 0) return;

        const prepared = await prepareUploadAction(
          fresh.map((file) => ({ name: file.name, size: file.size })),
        );
        const durations = await Promise.all(fresh.map(readDuration));

        const next: Item[] = fresh.map((file, index) => {
          const info = prepared.files[index];
          return {
            key: itemKey(file),
            file,
            status: info.ok ? "bereit" : info.blocked ? "gesperrt" : "problem",
            problem: info.problem,
            reason: info.reason,
            duplicate: info.duplicate,
            metadata: info.metadata,
            source: "dateiname",
            progress: 0,
            message: null,
            recordingId: null,
            durationMs: durations[index],
          };
        });
        setItems((current) => [...current, ...next]);
      } finally {
        setAnalysing(false);
      }
    },
    [items],
  );

  // Gelangen Dateien in das Feld, bevor React den change-Handler angehängt hat,
  // geht das Ereignis verloren. Der Feldinhalt wird deshalb beim Einhängen
  // einmalig nachgeholt.
  const initialFilesRead = useRef(false);
  useEffect(() => {
    if (initialFilesRead.current) return;
    initialFilesRead.current = true;
    const input = inputRef.current;
    if (!input?.files?.length) return;
    const pending = Array.from(input.files);
    input.value = "";
    void addFiles(pending);
  }, [addFiles]);

  const startUpload = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      const queue = items.filter((item) => item.status === "bereit" || item.status === "fehler");
      const pool = 2;
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const item = queue[cursor];
          cursor += 1;
          update(item.key, { status: "laeuft", progress: 0, message: null });
          const current = { ...item };
          const result = await uploadFile(current, (percent) =>
            update(item.key, { progress: percent }),
          );
          if (result.status === "ok") {
            update(item.key, {
              status: "fertig",
              progress: 100,
              message: result.message,
              recordingId: result.id ?? null,
            });
          } else if (result.status === "vorhanden") {
            update(item.key, {
              status: "vorhanden",
              progress: 100,
              message: result.message,
              recordingId: result.id ?? null,
            });
          } else {
            update(item.key, { status: "fehler", progress: 0, message: result.message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(pool, queue.length) }, worker));
    } finally {
      setRunning(false);
    }
  }, [items, running, update]);

  const readyCount = items.filter((item) => item.status === "bereit").length;
  const failedCount = items.filter((item) => item.status === "fehler").length;
  const doneCount = items.filter((item) => item.status === "fertig" || item.status === "vorhanden").length;
  const problemCount = items.filter((item) => item.status === "problem").length;
  const blockedCount = items.filter((item) => item.status === "gesperrt").length;
  const editItem = items.find((item) => item.key === editKey) ?? null;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(event.dataTransfer.files);
        }}
        className={`card flex flex-col items-center justify-center gap-2 border-dashed p-10 text-center transition-colors ${
          dragging ? "border-petrol bg-petrol-soft" : "border-line-strong"
        }`}
      >
        <p className="text-[15px] font-semibold text-ink">
          Dateien hierher ziehen oder auswählen
        </p>
        <p className="max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Unterstützt werden WAV- und MP3-Dateien bis 50 MB. Die Metadaten werden anhand der
          aktiven Vorlage aus dem Dateinamen gelesen:{" "}
          <code className="rounded-sm bg-canvas px-1 py-0.5 font-mono text-[12px]">{template}</code>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(",")}
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={analysing}
          onClick={() => inputRef.current?.click()}
        >
          {analysing ? "Dateien werden geprüft …" : "Dateien auswählen"}
        </button>
      </div>

      {items.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={running || readyCount + failedCount === 0}
              onClick={() => void startUpload()}
            >
              {running
                ? "Upload läuft …"
                : failedCount > 0 && readyCount === 0
                  ? `${failedCount} fehlgeschlagene erneut hochladen`
                  : `${readyCount + failedCount} ${readyCount + failedCount === 1 ? "Datei" : "Dateien"} hochladen`}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={running}
              onClick={() => setItems((current) => current.filter((item) => item.status !== "fertig" && item.status !== "vorhanden"))}
            >
              Abgeschlossene ausblenden
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={running}
              onClick={() => setItems([])}
            >
              Liste leeren
            </button>
            <div className="ml-auto flex flex-wrap gap-2 text-[12px]">
              <span className="badge bg-ok-soft text-ok">{doneCount} abgeschlossen</span>
              <span className="badge bg-petrol-soft text-petrol">{readyCount} bereit</span>
              {problemCount > 0 && (
                <span className="badge bg-warn-soft text-warn">{problemCount} zu klären</span>
              )}
              {blockedCount > 0 && (
                <span className="badge bg-bad-soft text-bad">
                  {blockedCount} nicht hochladbar
                </span>
              )}
              {failedCount > 0 && (
                <span className="badge bg-bad-soft text-bad">{failedCount} fehlgeschlagen</span>
              )}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse">
                <thead className="bg-canvas">
                  <tr>
                    <th className="th">Datei</th>
                    <th className="th">Anrufer</th>
                    <th className="th">Telefonnummer</th>
                    <th className="th">Gesprächszeitpunkt (CET)</th>
                    <th className="th">Anrufnr.</th>
                    <th className="th">Status</th>
                    <th className="th">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key}>
                      <td className="td">
                        <span className="block font-mono text-[12px] text-ink">{item.file.name}</span>
                        <span className="text-[11px] text-ink-faint">
                          {formatBytes(item.file.size)}
                          {item.durationMs ? ` · ${Math.round(item.durationMs / 1000)} s` : ""}
                        </span>
                      </td>
                      <td className="td">{item.metadata?.callerName ?? "–"}</td>
                      <td className="td font-mono text-[12px]">{item.metadata?.phoneNumber || "–"}</td>
                      <td className="td whitespace-nowrap">
                        {item.metadata ? formatDateTime(item.metadata.callAtUtc) : "–"}
                      </td>
                      <td className="td font-mono text-[12px]">{item.metadata?.callNumber || "–"}</td>
                      <td className="td">
                        <ItemStatusCell item={item} />
                      </td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1">
                          {item.status !== "fertig" &&
                            item.status !== "vorhanden" &&
                            item.status !== "gesperrt" && (
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={running}
                                onClick={() => setEditKey(item.key)}
                              >
                                {item.metadata ? "Bearbeiten" : "Daten erfassen"}
                              </button>
                            )}
                          {item.recordingId && (
                            <Link href={`/aufnahmen/${item.recordingId}`} className="btn btn-ghost">
                              Öffnen
                            </Link>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost text-ink-faint"
                            disabled={running}
                            onClick={() =>
                              setItems((current) => current.filter((row) => row.key !== item.key))
                            }
                          >
                            Entfernen
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {editItem && editItem.status !== "gesperrt" && (
        <MetadataDialog
          item={editItem}
          onClose={() => setEditKey(null)}
          onSave={(metadata) => {
            update(editItem.key, {
              metadata,
              source: "manuell",
              status: editItem.duplicate ? "problem" : "bereit",
              problem: editItem.duplicate ? "Diese Datei wurde bereits hochgeladen." : null,
              reason: editItem.duplicate ? "vorhanden" : null,
            });
            setEditKey(null);
          }}
        />
      )}
    </div>
  );
}

function ItemStatusCell({ item }: { item: Item }) {
  if (item.status === "laeuft") {
    return (
      <div className="w-40">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full bg-petrol transition-all" style={{ width: `${item.progress}%` }} />
        </div>
        <span className="mt-1 block text-[11px] text-ink-soft">{item.progress}% übertragen</span>
      </div>
    );
  }
  if (item.status === "fertig") {
    return (
      <div>
        <span className="badge bg-ok-soft text-ok">Hochgeladen</span>
        <span className="mt-1 block text-[11px] text-ink-faint">{item.message}</span>
      </div>
    );
  }
  if (item.status === "vorhanden") {
    return (
      <div>
        <span className="badge bg-warn-soft text-warn">Bereits vorhanden</span>
        <span className="mt-1 block text-[11px] text-ink-faint">{item.message}</span>
      </div>
    );
  }
  if (item.status === "fehler") {
    return (
      <div>
        <span className="badge bg-bad-soft text-bad">Fehlgeschlagen</span>
        <span className="mt-1 block text-[11px] text-bad">{item.message}</span>
      </div>
    );
  }
  if (item.status === "gesperrt") {
    return (
      <div>
        <span className="badge bg-bad-soft text-bad">
          {item.reason ? REASON_LABEL[item.reason] : "Datei nicht verwendbar"}
        </span>
        <span className="mt-1 block text-[11px] font-semibold text-bad">
          Kann nicht hochgeladen werden
        </span>
        <span className="mt-0.5 block text-[11px] text-ink-faint">{item.problem}</span>
      </div>
    );
  }
  if (item.status === "problem") {
    return (
      <div>
        <span className="badge bg-warn-soft text-warn">
          {item.reason ? REASON_LABEL[item.reason] : "Dateiname nicht lesbar"}
        </span>
        <span className="mt-1 block text-[11px] text-warn">{item.problem}</span>
      </div>
    );
  }
  return (
    <div>
      <span className="badge bg-petrol-soft text-petrol">Bereit</span>
      {item.source === "manuell" && (
        <span className="mt-1 block text-[11px] text-ink-faint">Metadaten manuell erfasst</span>
      )}
    </div>
  );
}

function MetadataDialog({
  item,
  onClose,
  onSave,
}: {
  item: Item;
  onClose: () => void;
  onSave: (metadata: Metadata) => void;
}) {
  const initial = item.metadata;
  const [firstName, setFirstName] = useState(initial?.callerFirstName ?? "");
  const [lastName, setLastName] = useState(initial?.callerLastName ?? "");
  const [phone, setPhone] = useState(initial?.phoneNumber ?? "");
  const [callNumber, setCallNumber] = useState(initial?.callNumber ?? "");
  const [when, setWhen] = useState(
    initial?.callAtUtc ? utcIsoToLocalInput(initial.callAtUtc) : "",
  );
  const [error, setError] = useState<string | null>(null);

  function save() {
    const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
    if (!name) {
      setError("Bitte erfassen Sie mindestens den Nachnamen der anrufenden Person.");
      return;
    }
    const iso = localInputToUtcIso(when);
    if (!iso) {
      setError("Bitte erfassen Sie Datum und Uhrzeit des Gesprächs.");
      return;
    }
    onSave({
      callerName: name,
      callerFirstName: firstName.trim(),
      callerLastName: lastName.trim(),
      phoneNumber: phone.trim(),
      callNumber: callNumber.trim(),
      callAtUtc: iso,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="metadaten-titel"
    >
      <div className="card w-full max-w-xl p-6">
        <h2 id="metadaten-titel" className="text-[16px] font-semibold text-ink">
          Metadaten manuell erfassen
        </h2>
        <p className="mt-1 font-mono text-[12px] text-ink-faint wrap-anywhere">{item.file.name}</p>
        {item.problem && !item.metadata && (
          <div className="notice notice-warn mt-3">{item.problem}</div>
        )}
        {error && <div className="notice notice-error mt-3">{error}</div>}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="vorname">
              Vorname
            </label>
            <input
              id="vorname"
              className="field"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              placeholder="Samir"
            />
          </div>
          <div>
            <label className="label" htmlFor="nachname">
              Nachname
            </label>
            <input
              id="nachname"
              className="field"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              placeholder="Weber"
            />
          </div>
          <div>
            <label className="label" htmlFor="telefon">
              Telefonnummer
            </label>
            <input
              id="telefon"
              className="field"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="386-0447523770"
            />
          </div>
          <div>
            <label className="label" htmlFor="anrufnummer">
              Anrufnummer
            </label>
            <input
              id="anrufnummer"
              className="field"
              value={callNumber}
              onChange={(event) => setCallNumber(event.target.value)}
              placeholder="1135"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="zeitpunkt">
              Gesprächszeitpunkt (CET)
            </label>
            <input
              id="zeitpunkt"
              type="datetime-local"
              className="field"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
