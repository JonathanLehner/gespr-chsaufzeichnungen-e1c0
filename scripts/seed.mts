/**
 * Legt Demodaten an: Konten, Gesprächsaufzeichnungen, Transkripte, Kommentare
 * und Bewertungen. Die Audiodateien werden mit der Sprachsynthese von Gemini
 * erzeugt, als WAV in den Objektspeicher gelegt und anschliessend durch die
 * reguläre Transkriptionsstrecke der Anwendung verarbeitet.
 *
 * Ausführen mit:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/seed.ts
 */
import { randomUUID } from "node:crypto";
import { Collections, deleteMany, findMany, insertUnique, upsertById } from "../src/lib/db";
import { platformGemini, platformUploadAudio } from "../src/lib/platform";
import { hashPassword } from "../src/lib/passwords";
import { createRecording, refreshRatingSummary, setDeletionFlag } from "../src/lib/recordings";
import { transcribeRecording } from "../src/lib/transcription";
import { fingerprintOf } from "../src/lib/audio";
import { cetToUtcMs } from "../src/lib/time";

const DEMO_PASSWORD = "Immotrust2026!";

const ACCOUNTS = [
  { email: "jonathanslehner@gmail.com", name: "Jonathan Slehner", role: "admin" as const },
  { email: "samir.weber@immotrustag.ch", name: "Samir Weber", role: "user" as const },
  { email: "lena.brunner@immotrustag.ch", name: "Lena Brunner", role: "user" as const },
  { email: "marco.fischer@immotrustag.ch", name: "Marco Fischer", role: "user" as const },
];

type CallSpec = {
  agent: { last: string; first: string; voice: string };
  client: { name: string; voice: string };
  phone: string;
  callNumber: string;
  when: [number, number, number, number, number, number]; // Jahr, Monat, Tag, Stunde, Minute, Sekunde (CET)
  uploader: string;
  topic: string;
  dialogue: string[];
};

const AGENTS = {
  weber: { last: "Weber", first: "Samir", voice: "Charon" },
  brunner: { last: "Brunner", first: "Lena", voice: "Aoede" },
  fischer: { last: "Fischer", first: "Marco", voice: "Fenrir" },
};

const CALLS: CallSpec[] = [
  {
    agent: AGENTS.weber,
    client: { name: "Frau Bachmann", voice: "Kore" },
    phone: "386-0447523770",
    callNumber: "1135",
    when: [2026, 6, 1, 13, 7, 48],
    uploader: "samir.weber@immotrustag.ch",
    topic: "Erstkontakt zur 4,5-Zimmer-Wohnung an der Seestrasse in Küsnacht",
    dialogue: [
      "Samir: Guten Tag Frau Bachmann, hier ist Samir Weber von der Immotrust AG. Sie haben sich für die Wohnung an der Seestrasse interessiert.",
      "Nadine: Guten Tag Herr Weber. Ja, genau, ich habe das Inserat gesehen. Ist die Wohnung noch verfügbar?",
      "Samir: Die viereinhalb Zimmer Wohnung ist noch frei. Wir haben allerdings bereits drei Besichtigungen für diese Woche vereinbart.",
      "Nadine: Und der Preis von einer Million zweihundertfünfzigtausend Franken, ist da noch Spielraum?",
      "Samir: Der Eigentümer hat den Preis bewusst marktnah angesetzt. Bei einem raschen Abschluss lässt sich über die Küche und den Parkplatz sprechen.",
      "Nadine: Wie hoch sind denn die Nebenkosten pro Monat?",
      "Samir: Rund vierhundertachtzig Franken inklusive Heizung und Erneuerungsfonds. Ich schicke Ihnen die Aufstellung gerne per Mail.",
      "Nadine: Sehr gut. Können wir eine Besichtigung am Donnerstagnachmittag machen?",
      "Samir: Donnerstag um sechzehn Uhr passt. Ich trage Sie ein und sende Ihnen die Bestätigung mit dem Grundriss.",
      "Nadine: Perfekt, vielen Dank für die schnelle Rückmeldung.",
    ],
  },
  {
    agent: AGENTS.brunner,
    client: { name: "Herr Odermatt", voice: "Puck" },
    phone: "412-0442117845",
    callNumber: "1136",
    when: [2026, 6, 2, 9, 22, 15],
    uploader: "lena.brunner@immotrustag.ch",
    topic: "Verkaufsauftrag für ein Einfamilienhaus in Wädenswil",
    dialogue: [
      "Lena: Guten Morgen Herr Odermatt, Lena Brunner von der Immotrust AG. Danke, dass Sie sich Zeit nehmen.",
      "Thomas: Guten Morgen. Es geht um das Haus meiner Eltern in Wädenswil, wir möchten es verkaufen.",
      "Lena: Sehr gerne. Können Sie mir kurz die Eckdaten nennen, Baujahr, Wohnfläche und Grundstück?",
      "Thomas: Baujahr neunzehnhundertsiebenundsechzig, etwa hundertsechzig Quadratmeter Wohnfläche, siebenhundert Quadratmeter Land.",
      "Lena: Wurde in den letzten Jahren renoviert, Fenster, Heizung oder Bad?",
      "Thomas: Die Ölheizung ist von zweitausendsieben, die Fenster wurden zweitausendfünfzehn ersetzt.",
      "Lena: Verstanden. Für eine seriöse Einschätzung möchte ich das Objekt besichtigen und eine Marktwertanalyse erstellen. Die ist für Sie kostenlos.",
      "Thomas: Und was verlangen Sie im Erfolgsfall?",
      "Lena: Unser Honorar liegt bei zwei Prozent des Verkaufspreises zuzüglich Mehrwertsteuer, fällig erst bei Beurkundung.",
      "Thomas: Das klingt fair. Machen wir einen Termin nächste Woche.",
    ],
  },
  {
    agent: AGENTS.fischer,
    client: { name: "Frau Steiner", voice: "Leda" },
    phone: "386-0443398102",
    callNumber: "1137",
    when: [2026, 6, 3, 15, 41, 3],
    uploader: "marco.fischer@immotrustag.ch",
    topic: "Rückfrage zur Finanzierung einer Eigentumswohnung",
    dialogue: [
      "Marco: Guten Tag Frau Steiner, Marco Fischer von der Immotrust AG. Sie hatten Fragen zur Finanzierung der Wohnung in Horgen.",
      "Petra: Ja, genau. Unsere Bank verlangt zwanzig Prozent Eigenkapital. Wir haben aber nur fünfzehn Prozent flüssig.",
      "Marco: Ein Teil kann über die Pensionskasse oder die Säule 3a eingebracht werden. Haben Sie das schon geprüft?",
      "Petra: Mein Mann hat etwa achtzigtausend Franken in der dritten Säule.",
      "Marco: Damit kommen Sie auf die geforderte Quote. Wichtig ist, dass mindestens zehn Prozent hartes Eigenkapital ausserhalb der Pensionskasse stammen.",
      "Petra: Und die Tragbarkeit, wie rechnet die Bank das?",
      "Marco: Mit einem kalkulatorischen Zins von fünf Prozent plus Nebenkosten und Amortisation, das Ganze darf ein Drittel des Bruttoeinkommens nicht übersteigen.",
      "Petra: Können Sie uns einen Finanzierungspartner empfehlen?",
      "Marco: Ich stelle Ihnen gerne den Kontakt zu zwei unabhängigen Hypothekarvermittlern her. Der Vergleich lohnt sich fast immer.",
      "Petra: Das wäre sehr hilfreich, vielen Dank.",
    ],
  },
  {
    agent: AGENTS.weber,
    client: { name: "Herr Lombardi", voice: "Orus" },
    phone: "386-0447523770",
    callNumber: "1138",
    when: [2026, 6, 8, 11, 5, 27],
    uploader: "samir.weber@immotrustag.ch",
    topic: "Preisverhandlung nach der zweiten Besichtigung",
    dialogue: [
      "Samir: Guten Tag Herr Lombardi, Samir Weber. Sie waren gestern das zweite Mal in der Wohnung am Zürichberg.",
      "Paolo: Ja, die Wohnung gefällt uns. Aber der Preis ist deutlich über unserem Budget.",
      "Samir: Was hätten Sie sich vorgestellt?",
      "Paolo: Wir könnten eine Million vierhunderttausend anbieten, das sind achtzigtausend unter dem Inserat.",
      "Samir: Ich verstehe. Ich leite das Angebot weiter, muss aber offen sagen, dass eine zweite Partei ebenfalls Interesse angemeldet hat.",
      "Paolo: Wir würden im Gegenzug auf die Sanierungszusage verzichten und schnell beurkunden.",
      "Samir: Das ist ein starkes Argument. Ein verbindlicher Termin bei der Notarin innerhalb von vier Wochen hilft.",
      "Paolo: Das können wir zusagen.",
      "Samir: Gut, ich melde mich bis morgen Abend mit der Antwort des Eigentümers.",
      "Paolo: Danke, ich warte auf Ihren Anruf.",
    ],
  },
  {
    agent: AGENTS.brunner,
    client: { name: "Frau Kälin", voice: "Kore" },
    phone: "412-0442117845",
    callNumber: "1139",
    when: [2026, 6, 9, 16, 33, 51],
    uploader: "lena.brunner@immotrustag.ch",
    topic: "Vermietung einer Dreizimmerwohnung, Fragen zur Bewerbung",
    dialogue: [
      "Lena: Guten Tag Frau Kälin, Lena Brunner von der Immotrust AG. Es geht um Ihre Bewerbung für die Dreizimmerwohnung in Thalwil.",
      "Sandra: Guten Tag. Ja, wir hoffen sehr auf die Wohnung.",
      "Lena: Ihre Unterlagen sind vollständig. Es fehlt noch der aktuelle Betreibungsregisterauszug.",
      "Sandra: Den habe ich gestern bestellt, er sollte diese Woche kommen.",
      "Lena: Sehr gut. Der Mietzins beträgt zweitausendvierhundert Franken netto plus zweihundertzwanzig Nebenkosten.",
      "Sandra: Ist ein Haustier erlaubt? Wir haben eine Katze.",
      "Lena: Eine Katze ist in Absprache mit der Verwaltung möglich, das halten wir im Mietvertrag fest.",
      "Sandra: Wann würde die Wohnung frei?",
      "Lena: Per ersten August. Ein früherer Bezug wäre gegen Absprache mit dem Vormieter denkbar.",
      "Sandra: Das passt uns gut. Vielen Dank für die Auskunft.",
    ],
  },
  {
    agent: AGENTS.fischer,
    client: { name: "Herr Zumbrunn", voice: "Puck" },
    phone: "386-0443398102",
    callNumber: "1140",
    when: [2026, 6, 15, 10, 12, 9],
    uploader: "marco.fischer@immotrustag.ch",
    topic: "Reklamation zur Übergabe einer Neubauwohnung",
    dialogue: [
      "Marco: Guten Tag Herr Zumbrunn, Marco Fischer von der Immotrust AG. Sie haben wegen der Übergabe angerufen.",
      "Beat: Ja, bei der Abnahme waren drei Mängel offen. Bis heute ist nichts passiert.",
      "Marco: Das tut mir leid. Um welche Punkte geht es konkret?",
      "Beat: Der Parkettkratzer im Wohnzimmer, die fehlende Silikonfuge im Bad und die defekte Storensteuerung.",
      "Marco: Ich habe das Abnahmeprotokoll vor mir. Die Storensteuerung ist beim Elektriker bestellt, Liefertermin nächste Woche.",
      "Beat: Und das Parkett?",
      "Marco: Da hake ich heute beim Bodenleger nach und melde mich bis Freitag mit einem Termin.",
      "Beat: Ich erwarte eine schriftliche Bestätigung.",
      "Marco: Selbstverständlich, Sie erhalten heute noch eine Mail mit den Fristen.",
      "Beat: Danke, so lässt sich das regeln.",
    ],
  },
  {
    agent: AGENTS.weber,
    client: { name: "Frau Hauser", voice: "Leda" },
    phone: "386-0447523770",
    callNumber: "1141",
    when: [2026, 6, 22, 14, 48, 36],
    uploader: "samir.weber@immotrustag.ch",
    topic: "Nachfassen nach einer Besichtigung ohne Rückmeldung",
    dialogue: [
      "Samir: Guten Tag Frau Hauser, Samir Weber von der Immotrust AG. Ich melde mich wegen der Attikawohnung in Zollikon.",
      "Irene: Guten Tag. Ja, wir haben sie besichtigt, sind uns aber noch unsicher.",
      "Samir: Was hält Sie zurück, ist es der Preis oder die Lage?",
      "Irene: Vor allem die Lärmsituation an der Hauptstrasse.",
      "Samir: Das ist ein berechtigter Punkt. Die Fenster sind dreifach verglast, im Schlafzimmer liegt der Wert bei rund vierunddreissig Dezibel.",
      "Irene: Das klingt besser, als ich dachte.",
      "Samir: Ich schlage vor, Sie kommen an einem Werktagmorgen noch einmal vorbei, dann hören Sie den Verkehr in der Spitzenzeit.",
      "Irene: Das ist eine gute Idee. Dienstag um acht Uhr?",
      "Samir: Dienstag acht Uhr ist notiert. Ich bringe auch die Lärmmessung mit.",
      "Irene: Danke, bis Dienstag.",
    ],
  },
  {
    agent: AGENTS.brunner,
    client: { name: "Herr Trüb", voice: "Orus" },
    phone: "412-0442117845",
    callNumber: "1142",
    when: [2026, 7, 6, 8, 55, 12],
    uploader: "lena.brunner@immotrustag.ch",
    topic: "Testanruf zur Prüfung der Aufzeichnungsanlage",
    dialogue: [
      "Lena: Guten Morgen, hier Lena Brunner von der Immotrust AG. Dies ist ein Testanruf zur Prüfung der Aufzeichnungsanlage.",
      "Beat: Guten Morgen, ich höre Sie gut.",
      "Lena: Wir prüfen kurz die Aufnahmequalität und die Übertragung ins neue System.",
      "Beat: Die Verbindung ist stabil, kein Rauschen.",
      "Lena: Danke, dann beenden wir den Test hier.",
    ],
  },
];

function wavFromPcm16(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function filenameFor(call: CallSpec): string {
  const [y, mo, d, h, mi, s] = call.when;
  return `[${call.agent.last}, ${call.agent.first}]_${call.phone}_${y}${pad(mo)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}(${call.callNumber}).wav`;
}

async function synthesize(call: CallSpec): Promise<Buffer> {
  const speakerA = call.dialogue[0].split(":")[0];
  const speakerB = call.dialogue[1].split(":")[0];
  const response = await platformGemini({
    model: "gemini-2.5-flash-preview-tts",
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Lies das folgende Telefongespräch natürlich, ruhig und in normalem Sprechtempo auf Deutsch vor:\n\n" +
              call.dialogue.join("\n"),
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: speakerA, voiceConfig: { prebuiltVoiceConfig: { voiceName: call.agent.voice } } },
            { speaker: speakerB, voiceConfig: { prebuiltVoiceConfig: { voiceName: call.client.voice } } },
          ],
        },
      },
    },
  });
  const url = response.images?.[0]?.url;
  if (!url) throw new Error("Die Sprachsynthese hat keine Audiodaten geliefert.");
  const pcm = Buffer.from(await (await fetch(url)).arrayBuffer());
  return wavFromPcm16(pcm);
}

const COMMENTS: Record<string, { author: string; text: string }[]> = {
  "1135": [
    {
      author: "lena.brunner@immotrustag.ch",
      text: "Sehr sauberer Einstieg. Der Hinweis auf die drei laufenden Besichtigungen erzeugt Dringlichkeit, ohne aufdringlich zu wirken.",
    },
    {
      author: "jonathanslehner@gmail.com",
      text: "Nebenkosten wurden konkret beziffert, das schafft Vertrauen. Beim Preisspielraum bitte künftig zuerst den Bedarf klären, bevor Zugeständnisse angedeutet werden.",
    },
  ],
  "1136": [
    {
      author: "samir.weber@immotrustag.ch",
      text: "Gute Bedarfsanalyse mit Baujahr, Fläche und Sanierungsstand. Honorarmodell klar und ohne Umschweife erklärt.",
    },
  ],
  "1137": [
    {
      author: "jonathanslehner@gmail.com",
      text: "Fachlich einwandfrei erklärt, insbesondere die Abgrenzung von hartem Eigenkapital und Pensionskassenmitteln.",
    },
    {
      author: "lena.brunner@immotrustag.ch",
      text: "Empfehlung von zwei unabhängigen Vermittlern statt eines Partners ist genau richtig.",
    },
  ],
  "1138": [
    {
      author: "jonathanslehner@gmail.com",
      text: "Verhandlung souverän geführt. Die Gegenleistung für den Preisnachlass wurde eingefordert, statt ihn einfach zu gewähren.",
    },
  ],
  "1140": [
    {
      author: "samir.weber@immotrustag.ch",
      text: "Reklamation ruhig aufgenommen und mit konkreten Fristen beantwortet. Schriftliche Bestätigung war die richtige Reaktion.",
    },
  ],
  "1141": [
    {
      author: "marco.fischer@immotrustag.ch",
      text: "Einwand Lärm mit Messwerten entkräftet und ein zweiter Termin zur Spitzenzeit angeboten. Vorbildlich.",
    },
  ],
};

const RATINGS: Record<string, { author: string; score: number }[]> = {
  "1135": [
    { author: "jonathanslehner@gmail.com", score: 8 },
    { author: "lena.brunner@immotrustag.ch", score: 9 },
  ],
  "1136": [
    { author: "jonathanslehner@gmail.com", score: 9 },
    { author: "samir.weber@immotrustag.ch", score: 8 },
  ],
  "1137": [
    { author: "jonathanslehner@gmail.com", score: 10 },
    { author: "lena.brunner@immotrustag.ch", score: 9 },
    { author: "marco.fischer@immotrustag.ch", score: 8 },
  ],
  "1138": [{ author: "jonathanslehner@gmail.com", score: 7 }],
  "1139": [{ author: "lena.brunner@immotrustag.ch", score: 7 }],
  "1140": [
    { author: "jonathanslehner@gmail.com", score: 6 },
    { author: "samir.weber@immotrustag.ch", score: 7 },
  ],
  "1141": [{ author: "marco.fischer@immotrustag.ch", score: 9 }],
  "1142": [{ author: "lena.brunner@immotrustag.ch", score: 3 }],
};

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset) {
    console.log("Bestehende Demodaten werden entfernt …");
    for (const collection of [
      Collections.recordings,
      Collections.transcriptIndex,
      Collections.transcriptParts,
      Collections.comments,
      Collections.ratings,
      Collections.jobs,
    ]) {
      await deleteMany(collection, {});
    }
  }

  console.log("Konten werden angelegt …");
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const account of ACCOUNTS) {
    await upsertById(Collections.users, account.email, {
      email: account.email,
      name: account.name,
      role: account.role,
      passwordHash,
      emailVerified: true,
      createdAt: new Date("2026-05-04T07:00:00.000Z").toISOString(),
    });
    console.log(`  ${account.email} (${account.role})`);
  }

  const accountByEmail = new Map(ACCOUNTS.map((account) => [account.email, account]));
  const existing = await findMany<{ fingerprint: string }>(Collections.recordings, {});
  const known = new Set(existing.map((row) => row.fingerprint));

  for (const call of CALLS) {
    const filename = filenameFor(call);
    const uploader = accountByEmail.get(call.uploader)!;
    console.log(`\n${filename}`);

    let recordingId: string | null = null;
    const provisionalFingerprint = [...known].find((entry) => entry.startsWith(filename.toLowerCase()));
    if (provisionalFingerprint) {
      console.log("  bereits vorhanden, wird übersprungen");
      const rows = await findMany<{ _id: string }>(Collections.recordings, {
        fingerprint: provisionalFingerprint,
      });
      recordingId = rows[0]?._id ?? null;
    } else {
      console.log("  Sprachsynthese läuft …");
      const wav = await synthesize(call);
      console.log(`  ${(wav.length / 1024 / 1024).toFixed(2)} MB erzeugt, wird abgelegt …`);
      const uploaded = await platformUploadAudio(wav);

      const [y, mo, d, h, mi, s] = call.when;
      const { recording } = await createRecording({
        originalFilename: filename,
        audioUrl: uploaded.url,
        mimeType: "audio/wav",
        byteSize: wav.length,
        durationMs: Math.round(((wav.length - 44) / (24000 * 2)) * 1000),
        callerName: `${call.agent.first} ${call.agent.last}`,
        callerFirstName: call.agent.first,
        callerLastName: call.agent.last,
        phoneNumber: call.phone,
        callNumber: call.callNumber,
        callAtUtc: new Date(cetToUtcMs(y, mo, d, h, mi, s)).toISOString(),
        metadataSource: "dateiname",
        templateVersion: 1,
        uploadedByEmail: uploader.email,
        uploadedByName: uploader.name,
        fingerprint: fingerprintOf(filename, wav.length),
      });
      recordingId = recording._id;
      console.log("  Transkription läuft …");
      const result = await transcribeRecording(recording._id);
      console.log(result.ok ? "  Transkript gespeichert" : `  Fehler: ${result.error}`);
    }

    if (!recordingId) continue;

    for (const comment of COMMENTS[call.callNumber] ?? []) {
      const author = accountByEmail.get(comment.author)!;
      await insertUnique(Collections.comments, {
        _id: randomUUID(),
        recordingId,
        text: comment.text,
        authorEmail: author.email,
        authorName: author.name,
        createdAt: new Date(
          cetToUtcMs(call.when[0], call.when[1], call.when[2] + 1, 9, 30, 0),
        ).toISOString(),
      });
    }

    for (const rating of RATINGS[call.callNumber] ?? []) {
      const author = accountByEmail.get(rating.author)!;
      const at = new Date(
        cetToUtcMs(call.when[0], call.when[1], call.when[2] + 1, 10, 0, 0),
      ).toISOString();
      await upsertById(Collections.ratings, `${recordingId}:${author.email}`, {
        recordingId,
        score: rating.score,
        authorEmail: author.email,
        authorName: author.name,
        createdAt: at,
        updatedAt: at,
      });
    }
    await refreshRatingSummary(recordingId);

    if (call.callNumber === "1142") {
      await setDeletionFlag(
        recordingId,
        true,
        "lena.brunner@immotrustag.ch",
        "Testanruf ohne Kundenbezug, kann entfernt werden",
      );
      console.log("  zur Löschung markiert");
    }
  }

  console.log("\nFertig. Zugangsdaten aller Demokonten:", DEMO_PASSWORD);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
