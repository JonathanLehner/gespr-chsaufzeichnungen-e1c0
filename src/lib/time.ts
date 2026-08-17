export const CALL_TIME_ZONE = "Europe/Zurich"; // CET / CEST

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

/** Rechnet eine Wanduhrzeit der Zeitzone Europe/Zurich in einen UTC-Zeitpunkt um. */
export function cetToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = naive - zoneOffsetMs(naive, CALL_TIME_ZONE);
  const offset = zoneOffsetMs(firstGuess, CALL_TIME_ZONE);
  return naive - offset;
}

/** Zerlegt einen UTC-Zeitpunkt in die Wanduhrzeit von Europe/Zurich. */
export function utcToCetParts(iso: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const date = new Date(iso);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CALL_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

const dateTimeFormatter = new Intl.DateTimeFormat("de-CH", {
  timeZone: CALL_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeSecondsFormatter = new Intl.DateTimeFormat("de-CH", {
  timeZone: CALL_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("de-CH", {
  timeZone: CALL_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return dateTimeFormatter.format(date);
}

export function formatDateTimeWithSeconds(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return dateTimeSecondsFormatter.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return dateFormatter.format(date);
}

/** Formatiert eine Dauer in Millisekunden als mm:ss beziehungsweise h:mm:ss. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Wandelt den Wert eines `datetime-local`-Feldes (CET) in einen UTC-ISO-String um. */
export function localInputToUtcIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = cetToUtcMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? "0"));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Erzeugt aus einem UTC-Zeitpunkt den Wert für ein `datetime-local`-Feld in CET. */
export function utcIsoToLocalInput(iso: string): string {
  const p = utcToCetParts(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Tagesgrenze in CET als UTC-Zeitpunkt, für Datumsfilter. */
export function cetDayStartUtcIso(dateValue: string, endOfDay = false): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  if (!match) return null;
  const [, y, mo, d] = match;
  const ms = endOfDay
    ? cetToUtcMs(Number(y), Number(mo), Number(d), 23, 59, 59)
    : cetToUtcMs(Number(y), Number(mo), Number(d), 0, 0, 0);
  return new Date(ms).toISOString();
}
