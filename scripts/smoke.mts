/** Kurzer Funktionstest der Datenschicht und der Dateinamensanalyse. */
import { countDocuments, Collections } from "../src/lib/db";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_EXAMPLE, parseFilename, validateTemplate } from "../src/lib/filename-template";
import { formatDateTimeWithSeconds } from "../src/lib/time";

const parsed = parseFilename(`${DEFAULT_TEMPLATE_EXAMPLE}.wav`, DEFAULT_TEMPLATE);
console.log("Standardvorlage gültig:", validateTemplate(DEFAULT_TEMPLATE));
console.log("Beispiel geparst:", parsed);
if (parsed.ok) console.log("Zeitpunkt CET:", formatDateTimeWithSeconds(parsed.data.callAtUtc));

console.log("Abweichende Vorlage:", parseFilename(
  "2026-06-01_13-07-48_Weber_Samir.mp3",
  "{DatumZeit:yyyy-MM-dd_HH-mm-ss}_{Nachname}_{Vorname}",
));
console.log("Unlesbar:", parseFilename("Aufnahme_ohne_Muster.wav", DEFAULT_TEMPLATE));
console.log("Aufnahmen in der Datenbank:", await countDocuments(Collections.recordings, {}));
