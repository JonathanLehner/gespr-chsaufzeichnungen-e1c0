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
  Sprechertrennung sowie Satz- und Wort-Zeitstempeln.
- **Aufnahmenübersicht**: Tabelle mit allen Metadaten, Volltextsuche über Metadaten und Transkripte
  mit hervorgehobenen Ausschnitten, Filter, Sortierung und serverseitige Seitennavigation.
- **Detailansicht**: WaveSurfer.js-Player (Wiedergabe, Scrubbing, Lautstärke, Tempo), synchron
  mitlaufendes Transkript, Sprung per Klick auf Wort oder Satz, Suche im Transkript, Kommentare und
  persönliche Bewertung von 1 bis 10.
- **Löschungen**: Mitarbeitende setzen nur eine Löschmarkierung. Endgültig gelöscht wird
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
| `src/app/(intern)` | Bereich hinter der Anmeldung: Aufnahmen, Upload, Admin |
| `src/app/actions` | Server Actions für Anmeldung, Aufnahmen und Administration |
| `src/app/api/upload` | Entgegennahme der Audiodateien inklusive Signaturprüfung |
| `src/app/api/audio/[id]` | Ausliefern der Aufnahme mit Bereichsanfragen und signiertem Token |
| `src/lib` | Datenzugriff, Authentifizierung, E-Mail-Versand, Dateinamensanalyse, Transkription |
| `scripts` | Bildgenerierung, WebP-Varianten, Funktions- und Leistungstest |

## Prüfung

```bash
npm run build
npm run start -- -p 3010

ADMIN_PASSWORD=… node scripts/browser-check.mjs   # vollständiger Funktionsdurchlauf im echten Browser
node scripts/logo-check.mjs      # Bildmarke, Icons und E-Mail-Validierung
node scripts/perf-check.mjs      # LCP, CLS, Blockierzeit und Bytes, mobil und Desktop

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
