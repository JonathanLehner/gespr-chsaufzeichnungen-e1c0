# Gesprächsaufzeichnungen – Immotrust AG

Deutschsprachige Webanwendung zur Verwaltung, Wiedergabe, Transkription, Suche und Bewertung der
Verkaufsgespräche der Immotrust AG.

## Funktionsumfang

- **Konten**: Registrierung und Anmeldung mit E-Mail und Passwort, E-Mail-Bestätigung, Passwort
  zurücksetzen. Bestätigungs- und Reset-Mails gehen über einen einstellbaren Versanddienst hinaus.
  Zugelassen sind ausschliesslich Adressen `@immotrustag.ch` sowie `jonathanslehner@gmail.com`
  (Superuser, feste Admin-Rolle).
- **Sammelupload**: Mehrfachauswahl und Drag-and-drop für WAV und MP3, Metadaten aus dem Dateinamen,
  Korrektur-Modal für nicht lesbare Namen, Fortschritt und Ergebnis je Datei.
- **Transkription**: Nach dem Upload erzeugt Gemini automatisch ein deutsches Transkript mit
  Sprechertrennung. Aufnahmen über zwei Minuten werden dafür in Abschnitte von rund einer Minute
  geteilt, abschnittsweise transkribiert und wieder zusammengesetzt. Enthält eine Aufnahme nichts
  Gesprochenes, erhält sie den Status „Keine Sprache“ statt einer Fehlermeldung.
- **Zeiten aus der Aufnahme, nicht aus dem Modell**: Die Zeitangaben des Sprachmodells werden
  verworfen und durch gemessene ersetzt (`src/lib/forced-alignment.ts`). Aus dem Lautstärkeverlauf
  der Datei werden die Sprechabschnitte bestimmt; darauf wird der Text im Verhältnis der Silben
  verteilt und die Satzgrenzen werden per dynamischer Programmierung auf die Pausen gezogen.
  Am Bestand gemessen lag ein Satzanfang zuvor im Mittel 0,2 s und im schlechtesten Fall 80 s neben
  dem tatsächlichen Sprechbeginn; danach liegt er auf der Sprechflanke. Der Text selbst bleibt
  unverändert. Ist die Audiodatei nicht lesbar, bleiben die geschätzten Zeiten stehen und das
  Transkript wird sichtbar als „Zeiten geschätzt“ gekennzeichnet.
- **Eigener Name**: Unter „Einstellungen“ ändert jede Person den angezeigten Namen ihres Kontos
  selbst. Die Änderung zieht die bereits gespeicherten Kopien an Kommentaren, Bewertungen und
  hochgeladenen Aufnahmen mit; die E-Mail-Adresse bleibt als Kennung unverändert.
- **Aufnahmenübersicht**: Tabelle mit allen Metadaten, Volltextsuche über Metadaten und Transkripte
  mit hervorgehobenen Ausschnitten, Filter, Sortierung und serverseitige Seitennavigation.
- **Detailansicht**: WaveSurfer.js-Player (Wiedergabe, Scrubbing, Lautstärke, Tempo), synchron
  mitlaufendes Transkript, Sprung per Klick auf einen Satz, Suche im Transkript, Kommentare und
  persönliche Bewertung von 1 bis 10.
- **Mitlaufen im Transkript**: Hervorgehoben werden die laufende Zeile und darin das laufende Wort.
  Die Wortmarkierung ruht in Sprechpausen, weil die Wortzeiten auf gemessener Sprechzeit stehen und
  Pausen darin nicht vorkommen. Die Liste rückt erst nach, wenn die laufende Zeile den Ausschnitt
  verlässt, und gemessen wird dabei gegen die Liste statt gegen die Seite – vorher sprang sie bei
  jedem Satzwechsel ans Ende. Scrollen von Hand schaltet das Kästchen „Mitlaufen“ ab, damit die
  Wiedergabe die Ansicht nicht zurückzieht.
- **Tastaturbedienung der Detailansicht**: Im Transkript ist genau ein Satz eine Tabulator-Station;
  Enter springt an den Satzanfang. Mit der Maus springt ein Klick auf ein einzelnes Wort an dieses
  Wort, ein Klick daneben an den Satzanfang. Am Anfang des Seiteninhalts stehen die Sprunglinks
  „Zum Transkript“ und „Zu den Metadaten und Kommentaren“, die erst beim Fokussieren sichtbar
  werden.
- **Löschungen**: Mitarbeitende setzen nur eine Löschmarkierung („Zur Löschung markieren“ /
  „Markierung bestätigen“). Zeilenstatus und Beschriftung wechseln sofort nach dem Klick, während
  des Speicherns erscheint ein Wartehinweis, danach eine kurze Bestätigung. Endgültig gelöscht wird
  ausschliesslich im Admin-Dashboard, inklusive Audio, Transkript, Kommentaren und Bewertungen.
- **Admin-Dashboard**: Editor für die Dateinamensvorlage mit Testfeld und Parse-Vorschau,
  Auftragsübersicht, manueller Neustart fehlgeschlagener Transkriptionen, Liste der Löschmarkierungen,
  Einstellungen des E-Mail-Versands mit Testnachricht sowie je Konto die Aktion „Reset-Link erzeugen“.

## Entwicklung

```bash
npm install
npm run dev      # Entwicklung
npm run build    # Produktionsbuild
npm run start    # Produktionsserver
```

Erforderliche Variablen in `.env.local` (nicht im Repository enthalten):

```
CLAWCORP_API_KEY=...   # ClawCorp-Plattform: Datenbank, Gemini, Objektspeicher
AUTH_SECRET=...        # Signaturschlüssel für Wiedergabe-Tokens
```

Optional für den E-Mail-Versand. Dieselben Werte lassen sich im Admin-Dashboard hinterlegen; was dort
eingetragen ist, hat Vorrang. Ist beides leer, werden E-Mails nur protokolliert:

```
MAIL_PROVIDER=resend            # resend | postmark | sendgrid | mailgun | protokoll
MAIL_API_KEY=...                # Schlüssel des Dienstes
MAIL_FROM_ADDRESS=noreply@immotrustag.ch
MAIL_FROM_NAME=Gesprächsaufzeichnungen Immotrust AG
MAIL_REPLY_TO=...               # optional
MAIL_MAILGUN_DOMAIN=...         # nur für Mailgun
MAIL_MAILGUN_REGION=eu          # nur für Mailgun, eu oder us
APP_BASE_URL=https://…          # Basis der Links in den E-Mails; sonst der Host der Anfrage
```

## Konten

Konten entstehen ausschliesslich über die Registrierung in der Anwendung; zugelassen sind Adressen
`@immotrustag.ch` sowie `jonathanslehner@gmail.com`, das automatisch die Admin-Rolle erhält. Der
Bestand enthält ausschliesslich die von den Mitarbeitenden hochgeladenen Aufzeichnungen – es
werden keine Beispieldaten erzeugt.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/app/page.tsx`, `src/app/anmelden`, `src/app/registrieren`, `src/app/passwort-vergessen` | statisch vorgerenderte öffentliche Seiten |
| `src/app/(intern)` | Bereich hinter der Anmeldung: Aufnahmen, Upload, Einstellungen, Admin |
| `src/app/actions` | Server Actions für Anmeldung, Aufnahmen, Profil und Administration |
| `src/app/api/upload` | Entgegennahme der Audiodateien inklusive Signaturprüfung |
| `src/app/api/audio/[id]` | Ausliefern der Aufnahme mit Bereichsanfragen und signiertem Token |
| `src/lib` | Datenzugriff, Authentifizierung, E-Mail-Versand, Dateinamensanalyse, Transkription |
| `src/lib/audio-split.ts`, `src/lib/audio-envelope.ts` | verlustfreies Zerlegen der Aufnahme und ihr Lautstärkeverlauf (WAV direkt, MP3 über `global_gain` der Seiteninformation) |
| `src/lib/forced-alignment.ts`, `src/lib/syllables.ts` | Ausrichtung des Transkripts an der Aufnahme; Silbenzahl über `hypher` mit deutschen Trennmustern |
| `scripts` | Bildgenerierung, WebP-Varianten, Funktions- und Leistungstest |

## Prüfung

```bash
npm run build
npm run start -- -p 3010

ADMIN_PASSWORD=… node scripts/browser-check.mjs   # vollständiger Funktionsdurchlauf im echten Browser
PRUEF_PASSWORT=… node scripts/check-tastatur.mjs  # Tabulator-Reihenfolge und Sprunglinks im Detail
node scripts/logo-check.mjs      # Bildmarke, Icons und E-Mail-Validierung
node scripts/perf-check.mjs      # LCP, CLS, Blockierzeit und Bytes, mobil und Desktop
node scripts/check-einstellungen.mjs   # Einstellungen und Ändern des eigenen Namens

# ohne laufenden Server, direkt gegen Datenschicht und Transkriptionsdienst
npx tsx --env-file=.env.local --conditions=react-server scripts/check-audio-split.mts
npx tsx --env-file=.env.local --conditions=react-server scripts/check-namensabgleich.mts
npx tsx --env-file=.env.local --conditions=react-server scripts/check-transkription-abschnitte.mts

# Ausrichtung der Zeiten an der Aufnahme
npx tsx --env-file=.env.local --conditions=react-server scripts/check-ausrichtung.mts
npx tsx --env-file=.env.local --conditions=react-server scripts/check-mp3-verlauf.mts

# Gegenprobe zur Ausrichtung: schneidet Sätze an den ausgerichteten Zeiten aus
# und lässt nur diesen Ausschnitt transkribieren (kostet Aufrufe des Dienstes)
npx tsx --env-file=.env.local --conditions=react-server scripts/check-ausrichtung-hoerprobe.mts

# einmalige Nachbesserung: richtet Transkripte aus der Zeit vor der Ausrichtung
# nachträglich aus, ohne sie neu erzeugen zu lassen
npx tsx --env-file=.env.local --conditions=react-server scripts/realign-transcripts.mts

# Reset-Weg: kein Link in der Oberfläche, aber Reset-Link erzeugen im Dashboard funktioniert
ADMIN_PASSWORD=… node scripts/check-reset-link.mjs http://localhost:3010
npx tsx --env-file=.env.local --conditions=react-server scripts/cleanup-testdata.mts
```

`browser-check.mjs` durchläuft Registrierung, Bestätigung, Anmeldung, Passwort-vergessen, Übersicht mit
Suche, Filtern, Sortierung und Seitennavigation, die Detailansicht mit Player und Transkript,
Sammelupload inklusive Drag-and-drop und Korrektur-Modal sowie das gesamte Admin-Dashboard bis zur
endgültigen Löschung. Suchbegriff, Filterwerte und die geprüfte Detailansicht leitet das Skript aus
dem vorhandenen Bestand ab, es setzt also keine bestimmten Aufnahmen voraus. Für den Admin-Teil
meldet es sich mit `ADMIN_EMAIL` (Vorgabe: der Superuser) und `ADMIN_PASSWORD` an; das Passwort
liegt nicht im Repository. `cleanup-testdata.mts` entfernt anschliessend die dabei entstandenen
Testkonten, Testaufnahmen, Kommentare und Bewertungen.

`check-tastatur.mjs` prüft die Detailansicht allein mit der Tastatur: eine Tabulator-Station je Satz,
Enter als Sprung an die Audioposition, Mausklick im Satztext als Sprung an den Satzanfang sowie
Sichtbarkeit und Ziel der beiden Sprunglinks. Es wählt dafür das längste vorhandene Transkript und
meldet sich mit `PRUEF_EMAIL` (Vorgabe: ein Mitarbeitendenkonto) und `PRUEF_PASSWORT` an.

`check-mitlaufen.mjs` spielt eine transkribierte Aufnahme im Browser ab und misst das Mitlaufen:
kein einzeln markiertes Wort, die laufende Zeile bleibt im sichtbaren Ausschnitt, die Liste bewegt
sich höchstens um ihre eigene Höhe je Schritt, Scrollen von Hand schaltet das Mitlaufen ab und ein
Suchbegriff über mehrere Wörter wird markiert. Anmeldung über `CHECK_EMAIL`/`CHECK_PASSWORD`.

`check-einstellungen.mjs` prüft die Seite „Einstellungen“ im Browser: Erreichbarkeit über die
Navigation, den vorbelegten Namen, die Abweisung zu kurzer Eingaben, das Speichern samt sofortiger
Wirkung im Kopfbereich und die unveränderliche E-Mail-Adresse. Der ursprüngliche Name wird am Ende
wieder eingesetzt.

`check-namensabgleich.mts` legt ein Prüfkonto mit je einer Aufnahme, einem Kommentar und einer
Bewertung an und stellt sicher, dass eine Namensänderung alle drei Kopien mitzieht, den Anrufernamen
aus dem Dateinamen aber unberührt lässt. `check-audio-split.mts` rechnet nach, dass die Abschnitte
einer langen Aufnahme lückenlos aneinander anschliessen und zusammen wieder das Original ergeben.
`check-transkription-abschnitte.mts` lässt eine lange und eine stille Aufnahme wirklich
transkribieren und prüft aufsteigende Zeitstempel über die Abschnittsgrenzen hinweg sowie den
Abschluss `ohne_sprache`. Alle drei räumen ihre Daten selbst wieder ab.

Mit `BASE=https://…` laufen dieselben Skripte gegen die ausgelieferte Anwendung.

## Auslieferung

Die Anwendung läuft als Cloudflare Worker (`@opennextjs/cloudflare`, Konfiguration in
`wrangler.jsonc` und `open-next.config.ts`).

```bash
npx opennextjs-cloudflare build     # führt npm run build aus und bündelt den Worker
npx wrangler dev --port 8788        # Worker lokal prüfen (Variablen aus .dev.vars)
npx wrangler deploy                 # Ausliefern
```

`CLAWCORP_API_KEY` und `AUTH_SECRET` liegen als Worker-Secrets (`npx wrangler secret put NAME`),
lokal in `.dev.vars`. Für den E-Mail-Versand kommt `MAIL_API_KEY` auf demselben Weg dazu, sofern der
Schlüssel nicht im Admin-Dashboard hinterlegt wird.

## Technische Entscheidungen

- **Datenhaltung**: ClawCorp-Plattformdatenbank (MongoDB) über den HTTP-Endpunkt. Der Endpunkt
  sortiert und begrenzt nicht serverseitig und liefert höchstens 100 Dokumente pro Abfrage. Jede
  Aufnahme erhält deshalb beim Anlegen ein Lesefenster (`bucket`, je 50 Datensätze); die Übersicht
  liest diese Fenster vollständig ein und filtert, sortiert und paginiert anschliessend im Server.
- **Eigene Dokument-IDs**: Automatisch erzeugte ObjectIds lassen sich über den Endpunkt nicht wieder
  abfragen. Alle Dokumente verwenden deshalb sprechende String-IDs. Der Schlüssel einer Aufnahme
  wird aus Dateiname und Dateigrösse abgeleitet, wodurch ein wiederholter Upload derselben Datei
  keinen zweiten Datensatz erzeugt.
- **Audioablage**: Die Dateien liegen im S3-Speicher der ClawCorp-Plattform. Da deren Upload nur
  Medien-Container annimmt, werden die unveränderten Bytes darüber abgelegt; ausgeliefert werden sie
  über `/api/audio/[id]` mit dem korrekten MIME-Typ, Bereichsanfragen und einem signierten,
  kurzlebigen Token. Die Ablage-URL bleibt dadurch intern.
- **Transkription**: Der Gemini-Endpunkt begrenzt Anfragen auf 200 KB, weshalb die Aufnahme nicht
  eingebettet, sondern als Datei-Referenz übergeben wird. Die Antwort wird normalisiert
  (aufsteigende Zeiten, Wortzerlegung als Rückfallebene) und wegen der Grössenbegrenzung der
  Datenbank in Teildokumente zerlegt. Für Suche und Anzeige entsteht zusätzlich ein kompakter
  Volltext-Index.
- **Lange Aufnahmen**: Die Antwortzeit des Dienstes hängt an der Menge des erzeugten JSON. Eine
  ganze Aufnahme in einer Anfrage läuft ab wenigen Minuten Gesprächslänge in die
  Zeitüberschreitung des vorgelagerten Gateways – bei jedem Versuch gleich, eine Wiederholung mit
  derselben Datei hilft also nicht. Ab zwei Minuten wird die Datei deshalb ohne Neucodierung in
  Abschnitte von rund einer Minute geschnitten (WAV blockweise, MP3 an Frame-Grenzen), jeder
  Abschnitt einzeln transkribiert und das Ergebnis mit dem passenden Zeitversatz zusammengesetzt.
  Zwei Abschnitte laufen gleichzeitig; bei mehr geraten die Anfragen einander in die Quere.
  Wortzeiten werden nicht mehr beim Dienst angefragt, weil sie die Antwortzeit vervielfachten; sie
  werden innerhalb des gemessenen Satzes gleichmässig verteilt. Gemessen: fünf Minuten Gespräch in
  gut zwei Minuten statt gar nicht.
- **Lücken statt Totalausfall**: Bleibt ein einzelner Abschnitt auch nach drei Anläufen ohne
  Antwort, kostet das nur diesen Abschnitt. Der übrige Text wird gespeichert, der fehlende
  Zeitbereich am Datensatz vermerkt und über dem Transkript benannt, samt Schaltfläche für einen
  neuen Lauf.
- **Keine Sprache als Abschluss**: Ein leeres Ergebnis bedeutet, dass der Dienst die Aufnahme gehört
  und nichts Gesprochenes gefunden hat – bei Freizeichen, Besetztton oder aufgelegtem Hörer der
  Normalfall. Das gilt als Abschluss (`ohne_sprache`), nicht als Fehler: Es wird nicht wiederholt,
  nicht rot dargestellt und ist in der Übersicht filterbar.
- **Aufträge**: Jede Aufnahme hat genau einen Transkriptionsauftrag. Er wird vor der Ausführung
  gesperrt, sodass parallele Aufrufe, wiederholte Klicks oder ein erneuter Upload keine doppelten
  Läufe erzeugen. Hängengebliebene Aufträge werden nach zehn Minuten wieder aufgenommen.
- **E-Mail**: Bestätigungs- und Reset-Mails gehen über einen HTTP-Versanddienst hinaus (Resend,
  Postmark, SendGrid oder Mailgun); SMTP steht auf Cloudflare Workers nicht zur Verfügung.
  Versanddienst, Schlüssel und Absender stehen entweder in den Umgebungsvariablen oder im
  Admin-Dashboard, wobei das Dashboard Vorrang hat. Ist nichts hinterlegt, wird die Nachricht nur
  protokolliert und im Postausgang als nicht zugestellt vermerkt; der Bestätigungslink erscheint
  dann ersatzweise direkt im Formular.
- **Reset-Links**: Der Link zum Zurücksetzen des Passworts wird nie öffentlich angezeigt – weder auf
  der Passwort-vergessen-Seite noch im Postausgang –, weil sonst jede Person eine fremde Adresse
  eintippen und das Konto übernehmen könnte. Die Passwort-vergessen-Seite antwortet deshalb für
  bestehende und unbekannte Adressen identisch. Bleibt eine Zustellung aus, erzeugt der Superuser im
  Admin-Dashboard über „Reset-Link erzeugen“ einen frischen Link, der ihm genau einmal angezeigt
  wird. `scripts/check-reset-link.mjs` prüft beide Seiten dieser Regel.
- **Produktionsbuild mit webpack**: `npm run build` läuft mit `next build --webpack`. Der
  Turbopack-Build legt den Servercode in nachgeladenen Chunks ab; `@opennextjs/cloudflare` bindet
  diese Chunks nur ein, wenn die Pfade der Bauumgebung Schrägstriche verwenden. Unter Windows
  entstand dadurch ein Worker, dessen Chunk-Auflösung leer blieb und der jede Seite mit
  „Internal Server Error“ (`ChunkLoadError`) beantwortete. Der webpack-Build erzeugt ein
  eigenständiges Bundle und ist damit unabhängig von der Bauplattform.
- **Bildmarke**: `public/logo.png` ist die unveränderte Marke des Kunden. `scripts/generate-logo-assets.mjs`
  erzeugt daraus zur Bauzeit die Anzeigevariante `public/marke/logo-112.webp` sowie `favicon.ico`,
  `icon.png` (128 px) und `apple-icon.png` (180 px, weisser Grund für iOS).
