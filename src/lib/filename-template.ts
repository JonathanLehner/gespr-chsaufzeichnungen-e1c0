import { cetToUtcMs } from "./time";

/**
 * Dateinamensvorlagen bestehen aus wörtlichen Zeichen und Platzhaltern in
 * geschweiften Klammern. Aus der Vorlage wird ein regulärer Ausdruck erzeugt,
 * der auf den Dateinamen ohne Endung angewendet wird.
 */

export const DEFAULT_TEMPLATE = "[{Nachname}, {Vorname}]_{Telefonnummer}_{DatumZeit}({Anrufnummer})";
export const DEFAULT_TEMPLATE_EXAMPLE = "[Weber, Samir]_386-0447523770_20260601130748(1135)";

export type PlaceholderKey =
  | "Nachname"
  | "Vorname"
  | "Name"
  | "Telefonnummer"
  | "DatumZeit"
  | "Anrufnummer"
  | "Beliebig";

export const PLACEHOLDERS: {
  key: PlaceholderKey;
  token: string;
  label: string;
  description: string;
}[] = [
  { key: "Nachname", token: "{Nachname}", label: "Nachname", description: "Nachname der anrufenden Person" },
  { key: "Vorname", token: "{Vorname}", label: "Vorname", description: "Vorname der anrufenden Person" },
  { key: "Name", token: "{Name}", label: "Vollständiger Name", description: "Vollständiger Name, falls nicht getrennt" },
  { key: "Telefonnummer", token: "{Telefonnummer}", label: "Telefonnummer", description: "Ziffern, Bindestriche, Klammern und Plus" },
  {
    key: "DatumZeit",
    token: "{DatumZeit}",
    label: "Datum und Uhrzeit",
    description: "Standardformat yyyyMMddHHmmss, Zeitzone CET",
  },
  { key: "Anrufnummer", token: "{Anrufnummer}", label: "Anrufnummer", description: "Laufende Nummer des Anrufs" },
  { key: "Beliebig", token: "{Beliebig}", label: "Beliebiger Text", description: "Wird gelesen, aber nicht gespeichert" },
];

const PLACEHOLDER_KEYS = new Set<string>(PLACEHOLDERS.map((p) => p.key));

const DATE_TOKENS: { token: string; pattern: string; key: "y" | "M" | "d" | "H" | "m" | "s" }[] = [
  { token: "yyyy", pattern: "(\\d{4})", key: "y" },
  { token: "MM", pattern: "(\\d{2})", key: "M" },
  { token: "dd", pattern: "(\\d{2})", key: "d" },
  { token: "HH", pattern: "(\\d{2})", key: "H" },
  { token: "mm", pattern: "(\\d{2})", key: "m" },
  { token: "ss", pattern: "(\\d{2})", key: "s" },
];

export const DEFAULT_DATE_FORMAT = "yyyyMMddHHmmss";

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CaptureSlot =
  | { kind: "placeholder"; key: Exclude<PlaceholderKey, "DatumZeit"> }
  | { kind: "date"; part: "y" | "M" | "d" | "H" | "m" | "s" };

type CompiledTemplate = {
  regex: RegExp;
  slots: CaptureSlot[];
  hasDateTime: boolean;
  hasName: boolean;
};

export type TemplateValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function buildDatePattern(format: string): { pattern: string; slots: CaptureSlot[] } | null {
  let pattern = "";
  const slots: CaptureSlot[] = [];
  let index = 0;
  while (index < format.length) {
    const match = DATE_TOKENS.find((token) => format.startsWith(token.token, index));
    if (match) {
      pattern += match.pattern;
      slots.push({ kind: "date", part: match.key });
      index += match.token.length;
      continue;
    }
    const char = format[index];
    if (/[A-Za-z]/.test(char)) return null;
    pattern += escapeLiteral(char);
    index += 1;
  }
  return { pattern, slots };
}

function compile(template: string): { compiled?: CompiledTemplate; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!template.trim()) {
    return { errors: ["Die Vorlage darf nicht leer sein."], warnings };
  }
  if (/\.(wav|mp3)$/i.test(template.trim())) {
    warnings.push("Die Dateiendung wird automatisch entfernt und gehört nicht in die Vorlage.");
  }

  let pattern = "^";
  const slots: CaptureSlot[] = [];
  const used = new Set<string>();
  let index = 0;
  let dateFormat = DEFAULT_DATE_FORMAT;

  while (index < template.length) {
    const char = template[index];
    if (char === "}") {
      errors.push("Schliessende Klammer } ohne zugehörige öffnende Klammer.");
      return { errors, warnings };
    }
    if (char !== "{") {
      pattern += escapeLiteral(char);
      index += 1;
      continue;
    }
    const end = template.indexOf("}", index);
    if (end === -1) {
      errors.push("Ein Platzhalter wurde nicht mit } geschlossen.");
      return { errors, warnings };
    }
    const raw = template.slice(index + 1, end);
    index = end + 1;
    const [name, argument] = raw.split(":");
    const key = name.trim();

    if (!PLACEHOLDER_KEYS.has(key)) {
      errors.push(
        `Unbekannter Platzhalter {${raw}}. Erlaubt sind: ${PLACEHOLDERS.map((p) => p.token).join(", ")}.`,
      );
      continue;
    }
    if (key !== "Beliebig" && used.has(key)) {
      errors.push(`Der Platzhalter {${key}} darf nur einmal vorkommen.`);
      continue;
    }
    used.add(key);

    if (key === "DatumZeit") {
      const format = (argument ?? DEFAULT_DATE_FORMAT).trim() || DEFAULT_DATE_FORMAT;
      const built = buildDatePattern(format);
      if (!built) {
        errors.push(
          `Ungültiges Datumsformat "${format}". Erlaubte Bausteine: yyyy, MM, dd, HH, mm, ss sowie Trennzeichen.`,
        );
        continue;
      }
      if (!/yyyy/.test(format) || !/MM/.test(format) || !/dd/.test(format)) {
        errors.push(`Das Datumsformat "${format}" muss mindestens yyyy, MM und dd enthalten.`);
        continue;
      }
      dateFormat = format;
      pattern += built.pattern;
      slots.push(...built.slots);
      continue;
    }

    switch (key) {
      case "Telefonnummer":
        pattern += "([0-9+()\\/\\-. ]+?)";
        slots.push({ kind: "placeholder", key: "Telefonnummer" });
        break;
      case "Anrufnummer":
        pattern += "([A-Za-z0-9\\-]+?)";
        slots.push({ kind: "placeholder", key: "Anrufnummer" });
        break;
      case "Beliebig":
        pattern += "(.*?)";
        slots.push({ kind: "placeholder", key: "Beliebig" });
        break;
      default:
        pattern += "(.+?)";
        slots.push({ kind: "placeholder", key: key as Exclude<PlaceholderKey, "DatumZeit"> });
        break;
    }
  }
  pattern += "$";

  const hasDateTime = used.has("DatumZeit");
  const hasName = used.has("Name") || used.has("Nachname") || used.has("Vorname");
  if (!hasDateTime) errors.push("Die Vorlage muss den Platzhalter {DatumZeit} enthalten.");
  if (!hasName) {
    errors.push("Die Vorlage muss {Name} oder {Nachname} und {Vorname} enthalten.");
  }
  if (!used.has("Telefonnummer")) {
    warnings.push("Ohne {Telefonnummer} bleibt das Feld Telefonnummer beim Import leer.");
  }
  if (!used.has("Anrufnummer")) {
    warnings.push("Ohne {Anrufnummer} bleibt das Feld Anrufnummer beim Import leer.");
  }
  if (errors.length > 0) return { errors, warnings };

  void dateFormat;
  return { compiled: { regex: new RegExp(pattern), slots, hasDateTime, hasName }, errors, warnings };
}

export function validateTemplate(template: string): TemplateValidation {
  const { compiled, errors, warnings } = compile(template);
  return { valid: Boolean(compiled) && errors.length === 0, errors, warnings };
}

export type ParsedMetadata = {
  callerLastName: string;
  callerFirstName: string;
  callerName: string;
  phoneNumber: string;
  callNumber: string;
  callAtUtc: string;
};

export type ParseResult =
  | { ok: true; data: ParsedMetadata }
  | { ok: false; error: string; field?: "dateiname" | "datum" | "vorlage" };

export function stripExtension(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/** Wendet eine Vorlage auf einen Dateinamen an und liefert die Metadaten. */
export function parseFilename(filename: string, template: string): ParseResult {
  const { compiled, errors } = compile(template);
  if (!compiled) {
    return { ok: false, error: errors[0] ?? "Die Dateinamensvorlage ist ungültig.", field: "vorlage" };
  }

  const base = stripExtension(filename.trim());
  const match = compiled.regex.exec(base);
  if (!match) {
    return {
      ok: false,
      error: "Der Dateiname entspricht nicht der konfigurierten Vorlage.",
      field: "dateiname",
    };
  }

  const values: Partial<Record<PlaceholderKey, string>> = {};
  const date: Record<string, number> = { y: 0, M: 1, d: 1, H: 0, m: 0, s: 0 };

  compiled.slots.forEach((slot, position) => {
    const value = match[position + 1] ?? "";
    if (slot.kind === "date") {
      date[slot.part] = Number(value);
    } else if (slot.key !== "Beliebig") {
      values[slot.key] = value.trim();
    }
  });

  let lastName = values.Nachname ?? "";
  let firstName = values.Vorname ?? "";
  const fullNameRaw = values.Name ?? "";
  if (!lastName && !firstName && fullNameRaw) {
    if (fullNameRaw.includes(",")) {
      const [last, first] = fullNameRaw.split(",");
      lastName = last.trim();
      firstName = (first ?? "").trim();
    } else {
      const parts = fullNameRaw.trim().split(/\s+/);
      firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
      lastName = parts[parts.length - 1] ?? "";
    }
  }
  const callerName = [firstName, lastName].filter(Boolean).join(" ").trim() || fullNameRaw.trim();
  if (!callerName) {
    return { ok: false, error: "Im Dateinamen wurde kein Name gefunden.", field: "dateiname" };
  }

  const { y, M, d, H, m, s } = date;
  if (M < 1 || M > 12 || d < 1 || d > 31 || H > 23 || m > 59 || s > 59) {
    return {
      ok: false,
      error: `Datum oder Uhrzeit im Dateinamen sind ungültig (${String(d).padStart(2, "0")}.${String(M).padStart(2, "0")}.${y}).`,
      field: "datum",
    };
  }
  const utcMs = cetToUtcMs(y, M, d, H, m, s);
  const callAt = new Date(utcMs);
  if (Number.isNaN(callAt.getTime())) {
    return { ok: false, error: "Datum und Uhrzeit im Dateinamen konnten nicht gelesen werden.", field: "datum" };
  }

  return {
    ok: true,
    data: {
      callerLastName: lastName,
      callerFirstName: firstName,
      callerName,
      phoneNumber: (values.Telefonnummer ?? "").trim(),
      callNumber: (values.Anrufnummer ?? "").trim(),
      callAtUtc: callAt.toISOString(),
    },
  };
}
