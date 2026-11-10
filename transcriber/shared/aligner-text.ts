/**
 * Aufbereitung des Transkripttexts für das akustische Modell.
 *
 * Das Ausrichtungsmodell (MMS_FA) kennt nur die Kleinbuchstaben a–z und den
 * Apostroph. Angezeigt wird weiterhin der Originaltext; hier entsteht für jedes
 * Wort nur die Buchstabenfolge, die tatsächlich gesprochen wurde: Zahlen,
 * Uhrzeiten, Abkürzungen und Akronyme werden ausgeschrieben, Umlaute und
 * Akzente auf den Grundbuchstaben gebracht (so wie das Modell trainiert wurde),
 * Satzzeichen entfernt.
 *
 * Ein Wort, das danach leer ist (ein Gedankenstrich, „…“), wird nicht
 * ausgerichtet; seine Zeit ergibt sich aus den Nachbarn.
 */

const ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
const TEENS = [
  "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn",
];
const TENS = ["", "", "zwanzig", "dreissig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];

function below100(n: number): string {
  if (n < 10) return n === 1 ? "eins" : ONES[n];
  if (n < 20) return TEENS[n - 10];
  const one = n % 10;
  const ten = TENS[Math.floor(n / 10)];
  return one === 0 ? ten : `${one === 1 ? "ein" : ONES[one]}und${ten}`;
}

function below1000(n: number): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundred > 0 ? `${hundred === 1 ? "ein" : ONES[hundred]}hundert` : "";
  return head + (rest > 0 ? below100(rest) : "");
}

/** Grundzahl als deutsches Zahlwort („1135“ → „eintausendeinhundertfünfunddreissig“). */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "null";
  if (n >= 1_000_000_000) return String(n).split("").map((digit) => ONES[Number(digit)]).join(" ");
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions > 0) parts.push(millions === 1 ? "eine million" : `${below1000(millions)} millionen`);
  if (thousands > 0) parts.push(`${thousands === 1 ? "ein" : below1000(thousands)}tausend`);
  if (rest > 0) parts.push(below1000(rest));
  return parts.join(" ");
}

/** Jahreszahlen 1100–1999 werden in Hunderten gesprochen („neunzehnhundertneunzig“). */
function yearToWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return `${below100(hundreds)}hundert${rest > 0 ? below100(rest) : ""}`;
}

function ordinalToWords(n: number): string {
  const special: Record<number, string> = { 1: "erste", 3: "dritte", 7: "siebte", 8: "achte" };
  if (special[n]) return special[n];
  const base = numberToWords(n).replace(/eins$/, "ein");
  return n < 20 ? `${base}te` : `${base}ste`;
}

const DIGITS_SPOKEN_SINGLY = /^0\d/;

/** Ziffernfolge so, wie sie am Telefon gesprochen wird. */
function digitsToWords(digits: string): string {
  // Führende Null: Telefon-, Konto- oder Postfachnummer, Ziffer für Ziffer.
  if (DIGITS_SPOKEN_SINGLY.test(digits) || digits.length > 9) {
    return digits.split("").map((digit) => ONES[Number(digit)]).join(" ");
  }
  const value = Number(digits);
  if (digits.length === 4 && value >= 1100 && value < 2000) return yearToWords(value);
  return numberToWords(value);
}

const ABBREVIATIONS: Record<string, string> = {
  "z.b.": "zum beispiel",
  "d.h.": "das heisst",
  "u.a.": "unter anderem",
  "usw.": "und so weiter",
  "bzw.": "beziehungsweise",
  "ca.": "circa",
  "evtl.": "eventuell",
  "inkl.": "inklusive",
  "exkl.": "exklusive",
  "zzgl.": "zuzüglich",
  "nr.": "nummer",
  "hr.": "herr",
  "fr.": "frau",
  "dr.": "doktor",
  "prof.": "professor",
  "str.": "strasse",
  "st.": "sankt",
  "tel.": "telefon",
  "min.": "minuten",
  "std.": "stunden",
  "mio.": "millionen",
  "mrd.": "milliarden",
  "chf": "franken",
  "fr": "franken",
  "sfr": "franken",
  "eur": "euro",
  "m²": "quadratmeter",
  "m2": "quadratmeter",
  "qm": "quadratmeter",
  "km": "kilometer",
  "&": "und",
  "%": "prozent",
  "@": "at",
  "+": "plus",
};

/** Kurze Grossbuchstabenfolgen, die als Wort gesprochen werden. */
const SPOKEN_ACRONYMS: Record<string, string> = {
  ok: "okay",
  gmbh: "ge em be ha",
  ag: "a ge",
  ahv: "a ha fau",
  mwst: "mehrwertsteuer",
  immo: "immo",
  nato: "nato",
  ikea: "ikea",
};

const LETTER_NAMES: Record<string, string> = {
  a: "a", b: "be", c: "ze", d: "de", e: "e", f: "ef", g: "ge", h: "ha", i: "i", j: "jot", k: "ka",
  l: "el", m: "em", n: "en", o: "o", p: "pe", q: "ku", r: "er", s: "es", t: "te", u: "u", v: "fau",
  w: "we", x: "iks", y: "ypsilon", z: "zet",
};

/** Umlaute und Akzente auf den Grundbuchstaben, so wie das Modell (uroman) schreibt. */
function romanize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function expandToken(token: string, isLastInSentence: boolean): string {
  const lower = token.toLowerCase();
  if (ABBREVIATIONS[lower]) return ABBREVIATIONS[lower];

  // Uhrzeit „13:30“ / „13.30 Uhr“ wird als Stunden und Minuten gesprochen.
  const time = token.match(/^(\d{1,2}):(\d{2})$/);
  if (time) {
    const minutes = Number(time[2]);
    return `${numberToWords(Number(time[1]))} uhr${minutes > 0 ? ` ${numberToWords(minutes)}` : ""}`;
  }
  // Dezimalzahl „3,5“.
  const decimal = token.match(/^(\d+),(\d+)$/);
  if (decimal) {
    const fraction = decimal[2].split("").map((digit) => ONES[Number(digit)]).join(" ");
    return `${digitsToWords(decimal[1])} komma ${fraction}`;
  }
  // Tausendertrennzeichen „1'250'000“ oder „1.250.000“.
  if (/^\d{1,3}(['’.]\d{3})+$/.test(token)) return numberToWords(Number(token.replace(/['’.]/g, "")));
  // Ordnungszahl „3.“ mitten im Satz; am Satzende ist der Punkt Satzzeichen.
  const ordinal = token.match(/^(\d{1,3})\.$/);
  if (ordinal && !isLastInSentence) return ordinalToWords(Number(ordinal[1]));

  // Zahl mit Einheit oder Suffix („30%“, „5m²“, „3-Zimmer“) wird zerlegt.
  return token
    .replace(/(\d)([^\d\s.,:'’])/g, "$1 $2")
    .replace(/([^\d\s.,:'’])(\d)/g, "$1 $2")
    .split(/[\s\-/–—]+/)
    .filter(Boolean)
    .map((part) => {
      const partLower = part.toLowerCase();
      if (ABBREVIATIONS[partLower]) return ABBREVIATIONS[partLower];
      const bare = part.replace(/^[^\p{L}\p{N}&%+@²]+|[^\p{L}\p{N}&%+@²]+$/gu, "");
      if (!bare) return "";
      const bareLower = bare.toLowerCase();
      if (ABBREVIATIONS[bareLower]) return ABBREVIATIONS[bareLower];
      if (/^\d+$/.test(bare)) return digitsToWords(bare);
      if (/\d/.test(bare)) return bare.replace(/\d+/g, (digits) => ` ${digitsToWords(digits)} `);
      if (SPOKEN_ACRONYMS[bareLower] && bare === bare.toUpperCase()) return SPOKEN_ACRONYMS[bareLower];
      // Akronym („UBS“, „SBB“): Buchstabe für Buchstabe.
      if (/^[A-ZÄÖÜ]{2,4}$/.test(bare)) {
        return bareLower
          .split("")
          .map((letter) => LETTER_NAMES[romanize(letter)] ?? letter)
          .join(" ");
      }
      return bare;
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Buchstabenfolge eines angezeigten Wortes für das Modell: nur Zeichen aus
 * `alphabet`, Leerzeichen zwischen gesprochenen Teilwörtern entfernt.
 */
export function spokenForm(word: string, alphabet: ReadonlySet<string>, isLastInSentence = false): string {
  const expanded = romanize(expandToken(word.trim(), isLastInSentence));
  let out = "";
  for (const char of expanded) {
    if (alphabet.has(char)) out += char;
    else if (char === "’" || char === "`") out += alphabet.has("'") ? "'" : "";
  }
  return out;
}
