# Gesprächsaufzeichnungen – Immotrust AG

Deutschsprachige Webanwendung zur Verwaltung, Wiedergabe, Transkription, Suche und Bewertung der
Verkaufsgespräche der Immotrust AG.

## Funktionsumfang

- **Konten**: Registrierung und Anmeldung mit E-Mail und Passwort, E-Mail-Bestätigung, Passwort
  zurücksetzen. Zugelassen sind ausschliesslich Adressen `@immotrustag.ch` sowie
  `jonathanslehner@gmail.com` (Superuser, feste Admin-Rolle).
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
  Auftragsübersicht, manueller Neustart fehlgeschlagener Transkriptionen, Liste der Löschmarkierungen.

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

## Demodaten

```bash
npx tsx --env-file=.env.local --conditions=react-server scripts/seed.mts
```

Das Skript legt vier Konten an, erzeugt acht deutschsprachige Beispielgespräche per Sprachsynthese,
speichert sie im Objektspeicher, transkribiert sie über die reguläre Verarbeitungsstrecke und
ergänzt Kommentare, Bewertungen und eine Löschmarkierung. Mit `--reset` werden vorhandene Aufnahmen
vorher entfernt.

Demokonten (Passwort `Immotrust2026!`):

| Konto | Rolle |
| --- | --- |
| `jonathanslehner@gmail.com` | Superuser mit Admin-Dashboard |
| `samir.weber@immotrustag.ch` | Mitarbeitend |
| `lena.brunner@immotrustag.ch` | Mitarbeitend |
| `marco.fischer@immotrustag.ch` | Mitarbeitend |

Die Passwörter sind vor dem produktiven Einsatz zu ändern.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/app/page.tsx`, `src/app/anmelden`, `src/app/registrieren`, `src/app/passwort-vergessen` | statisch vorgerenderte öffentliche Seiten |
| `src/app/(intern)` | Bereich hinter der Anmeldung: Aufnahmen, Upload, Admin |
| `src/app/actions` | Server Actions für Anmeldung, Aufnahmen und Administration |
| `src/app/api/upload` | Entgegennahme der Audiodateien inklusive Signaturprüfung |
| `src/app/api/audio/[id]` | Ausliefern der Aufnahme mit Bereichsanfragen und signiertem Token |
| `src/lib` | Datenzugriff, Authentifizierung, Dateinamensanalyse, Transkription |
| `scripts` | Bildgenerierung, WebP-Varianten, Demodaten, Funktions- und Leistungstest |

## Prüfung

```bash
npm run build
npm run start -- -p 3010

node scripts/browser-check.mjs   # 66 Prüfungen im echten Browser
node scripts/perf-check.mjs      # LCP, CLS, Blockierzeit und Bytes, mobil und Desktop
npx tsx --env-file=.env.local --conditions=react-server scripts/cleanup-testdata.mts
```

`browser-check.mjs` durchläuft Registrierung, Bestätigung, Anmeldung, Passwort-Reset, Übersicht mit
Suche, Filtern, Sortierung und Seitennavigation, die Detailansicht mit Player und Transkript,
Sammelupload inklusive Drag-and-drop und Korrektur-Modal sowie das gesamte Admin-Dashboard bis zur
endgültigen Löschung. `cleanup-testdata.mts` entfernt anschliessend die dabei entstandenen
Testkonten, Testaufnahmen, Kommentare und Bewertungen.

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
- **E-Mail**: In dieser Umgebung ist kein Versand konfiguriert. Bestätigungs- und Reset-Links werden
  direkt in der Oberfläche angezeigt und im Admin-Dashboard protokolliert.
