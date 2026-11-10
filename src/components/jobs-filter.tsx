import Link from "next/link";
import { JOB_PAGE_SIZES, JOB_STATUSES, type JobFilterValues } from "@/lib/job-filter";

const RANGES = [
  { label: "Erstellt", von: "erstelltVon", bis: "erstelltBis" },
  { label: "Gestartet", von: "gestartetVon", bis: "gestartetBis" },
  { label: "Beendet", von: "beendetVon", bis: "beendetBis" },
] as const;

/**
 * Filter der Auftragstabelle als GET-Formular: Alles steht in der URL.
 * `keep` sind Parameter anderer Bereiche derselben Seite, die erhalten bleiben.
 */
export function JobsFilter({
  action,
  values,
  uploaders,
  models,
  activeCount,
  keep,
  resetHref,
}: {
  action: string;
  values: JobFilterValues;
  uploaders: { email: string; name: string }[];
  models: string[];
  activeCount: number;
  keep: [string, string][];
  resetHref: string;
}) {
  return (
    <form action={action} method="get" className="card p-4">
      {keep.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {values.sort && (
        <>
          <input type="hidden" name="sort" value={values.sort.key} />
          <input type="hidden" name="dir" value={values.sort.dir} />
        </>
      )}

      <fieldset>
        <legend className="label">Status</legend>
        <div className="flex flex-wrap gap-1.5">
          {JOB_STATUSES.map((status) => (
            <label
              key={status.value}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2 py-1 text-[12.5px] text-ink has-[:checked]:border-petrol has-[:checked]:bg-petrol-soft has-[:checked]:text-petrol"
            >
              <input
                type="checkbox"
                name="status"
                value={status.value}
                defaultChecked={values.status.includes(status.value)}
                className="accent-petrol"
              />
              {status.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label className="label" htmlFor="job-datei">
            Datei
          </label>
          <input
            id="job-datei"
            name="datei"
            type="search"
            defaultValue={values.datei}
            className="field"
            placeholder="Name oder Nummer im Dateinamen"
          />
        </div>
        <div>
          <label className="label" htmlFor="job-uploader">
            Hochgeladen von
          </label>
          <select id="job-uploader" name="uploader" defaultValue={values.uploader} className="field">
            <option value="">Alle</option>
            {uploaders.map((uploader) => (
              <option key={uploader.email} value={uploader.email}>
                {uploader.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="job-modell">
            Modell
          </label>
          <select id="job-modell" name="auftragsmodell" defaultValue={values.modell} className="field">
            <option value="">Alle</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label whitespace-nowrap" htmlFor="job-versuche">
            Versuche ab
          </label>
          <input
            id="job-versuche"
            name="versucheMin"
            type="number"
            min={1}
            max={999}
            step={1}
            defaultValue={values.versucheMin}
            className="field w-[80px]"
          />
        </div>
        <label className="flex h-[38px] cursor-pointer items-center gap-1.5 text-[13px] text-ink">
          <input
            type="checkbox"
            name="meldung"
            value="1"
            defaultChecked={values.meldung}
            className="accent-petrol"
          />
          Nur mit Meldung
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {RANGES.map((range) => (
          <fieldset key={range.von} className="max-[699px]:w-full">
            <legend className="label">{range.label}</legend>
            <div className="flex items-center gap-1.5">
              <input
                name={range.von}
                type="date"
                defaultValue={values[range.von]}
                className="field min-w-0 flex-1 min-[700px]:w-[9.5rem] min-[700px]:flex-none"
                aria-label={`${range.label} von`}
              />
              <span className="text-[13px] text-ink-faint">bis</span>
              <input
                name={range.bis}
                type="date"
                defaultValue={values[range.bis]}
                className="field min-w-0 flex-1 min-[700px]:w-[9.5rem] min-[700px]:flex-none"
                aria-label={`${range.label} bis`}
              />
            </div>
          </fieldset>
        ))}
        <div>
          <label className="label" htmlFor="job-pageSize">
            Pro Seite
          </label>
          <select id="job-pageSize" name="pageSize" defaultValue={values.pageSize} className="field">
            {JOB_PAGE_SIZES.map((size) => (
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
            <Link href={resetHref} className="btn btn-secondary">
              Zurücksetzen ({activeCount})
            </Link>
          )}
        </div>
      </div>
    </form>
  );
}
