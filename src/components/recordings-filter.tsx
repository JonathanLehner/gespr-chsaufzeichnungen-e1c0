import Link from "next/link";
import type { SortKey } from "@/lib/recordings";

export type FilterValues = {
  q: string;
  von: string;
  bis: string;
  uploader: string;
  status: string;
  bewertungVon: string;
  bewertungBis: string;
  loeschstatus: string;
  sort: SortKey;
  pageSize: string;
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "gespraech_neu", label: "Gespräch – neuste zuerst" },
  { value: "gespraech_alt", label: "Gespräch – älteste zuerst" },
  { value: "hochgeladen_neu", label: "Upload – neuste zuerst" },
  { value: "name_az", label: "Anrufername A–Z" },
  { value: "bewertung_hoch", label: "Bewertung – höchste zuerst" },
  { value: "bewertung_tief", label: "Bewertung – tiefste zuerst" },
];

export function RecordingsFilter({
  values,
  uploaders,
  activeCount,
}: {
  values: FilterValues;
  uploaders: { email: string; name: string }[];
  activeCount: number;
}) {
  return (
    <form action="/aufnahmen" method="get" className="card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1">
          <label className="label" htmlFor="q">
            Suche in Metadaten und Transkripten
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={values.q}
            className="field"
            placeholder="z. B. Seestrasse, Weber, 0447523770 oder Hypothek"
          />
        </div>
        <div>
          <label className="label" htmlFor="von">
            Gespräch von
          </label>
          <input id="von" name="von" type="date" defaultValue={values.von} className="field" />
        </div>
        <div>
          <label className="label" htmlFor="bis">
            Gespräch bis
          </label>
          <input id="bis" name="bis" type="date" defaultValue={values.bis} className="field" />
        </div>
        <div>
          <label className="label" htmlFor="uploader">
            Upload-Autor
          </label>
          <select id="uploader" name="uploader" defaultValue={values.uploader} className="field">
            <option value="">Alle</option>
            {uploaders.map((uploader) => (
              <option key={uploader.email} value={uploader.email}>
                {uploader.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="status">
            Transkription
          </label>
          <select id="status" name="status" defaultValue={values.status} className="field">
            <option value="alle">Alle</option>
            <option value="wartend">Wartend</option>
            <option value="in_arbeit">In Verarbeitung</option>
            <option value="abgeschlossen">Abgeschlossen</option>
            <option value="ohne_sprache">Keine Sprache</option>
            <option value="fehlgeschlagen">Fehlgeschlagen</option>
          </select>
        </div>
        <div>
          <span className="label">Bewertung</span>
          <div className="flex items-center gap-1.5">
            <input
              name="bewertungVon"
              type="number"
              min={1}
              max={10}
              step={1}
              defaultValue={values.bewertungVon}
              className="field w-[70px]"
              placeholder="1"
              aria-label="Bewertung von"
            />
            <span className="text-[13px] text-ink-faint">bis</span>
            <input
              name="bewertungBis"
              type="number"
              min={1}
              max={10}
              step={1}
              defaultValue={values.bewertungBis}
              className="field w-[70px]"
              placeholder="10"
              aria-label="Bewertung bis"
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="loeschstatus">
            Löschstatus
          </label>
          <select id="loeschstatus" name="loeschstatus" defaultValue={values.loeschstatus} className="field">
            <option value="alle">Alle</option>
            <option value="ohne_markiert">Ohne Löschvormerkung</option>
            <option value="nur_markiert">Nur vorgemerkte</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sort">
            Sortierung
          </label>
          <select id="sort" name="sort" defaultValue={values.sort} className="field">
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="pageSize">
            Pro Seite
          </label>
          <select id="pageSize" name="pageSize" defaultValue={values.pageSize} className="field">
            {["5", "10", "20", "50", "100"].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" className="btn btn-primary">
            Anwenden
          </button>
          {activeCount > 0 && (
            <Link href="/aufnahmen" className="btn btn-secondary">
              Zurücksetzen ({activeCount})
            </Link>
          )}
        </div>
      </div>
    </form>
  );
}
