# Vergleich der Transkriptionsmodelle (10.11.2026)

10 Aufnahmen (WAV, 90–273 s, zusammen 19,3 Minuten), neueste abgeschlossene. Nur lesend:
Audio über die gespeicherte Adresse geladen, Ergebnisse ausserhalb der Datenbank abgelegt,
kein Transkript überschrieben. Alle Anfragen über den Plattform-Endpunkt `/gemini`, nacheinander
mit 4 s Abstand, 60-s-Abschnitte (Opus 16 kbit/s).

## Einschränkung

`gemini-3.5-transcribe` liefert über `/gemini` nur Text: keine Sprecher, keine Wortzeiten, kein
Vokabular. Diese gibt es nur über die Interactions-API, die der Endpunkt nicht weiterleitet
(siehe README, „Transkriptionsmodell“). Wortzeiten von `gemini-3.5-transcribe` liessen sich deshalb
nicht messen. Ein Abgleich mit dem Gehörten war in diesem Lauf nicht möglich; die Wortgenauigkeit
ist als Abweichung (Wortfehlerrate, WER) zwischen den Modellen und gegenüber dem gespeicherten
Transkript (gemini-2.5-flash mit Denken, früherer Lauf) angegeben, nicht gegen eine
Referenzabschrift.

## Ergebnis

| | gemini-2.5-flash (bisher) | gemini-3.5-flash-lite (+ Vokabular) | gemini-3.5-transcribe (nur Text) |
| --- | --- | --- | --- |
| Kosten je Audiominute, gemessen | $0.0056 | $0.0029 | $0.0185 (ohne Ausreisser $0.0044) |
| Tokens je Minute Audio / Text / Ausgabe | 1921 / 529 / 1399 | 1578 / 858 / 865 | 1500 / 0 / 1291 |
| Denk-Tokens | 0 | 0 | – |
| Antwortzeit je Audiominute | 7,7 s | 4,4 s | 5,6 s |
| WER gegenüber gespeichertem Transkript, Mittel ohne Aufnahme 1 (französisch) | 0,25 | 0,40 | – |
| WER gegenüber gemini-2.5-flash, Mittel | – | 0,39 | 0,49 (ohne Ausreisser) |
| Sprecher | 2–4 je Gespräch | 2–5 je Gespräch | keine |
| Ungültige JSON-Antworten | 0 | 1 von rund 25 (Wiederholung gelang) | – |

Beobachtungen:

- `gemini-3.5-transcribe` liess in 6 von 10 Gesprächen grosse Teile weg (z. B. 52 statt 233,
  27 statt 69, 378 statt 655 Wörter), meist die Beiträge des Immotrust-Mitarbeiters. In einem
  Gespräch geriet es in eine Schleife („Ja. Ja. Ja. …“, 11 575 Wörter für 2 Minuten, $0.13/min).
  Wo es vollständig war, traf es Namen besser (ImmoTrust, Labruzzo, Schwantenholzstrasse, Weidhof).
- Aufnahme 1 ist französisch; das gespeicherte Transkript enthält dort nur „[unverständlich]“ und
  eine deutsche Übersetzung, beide neuen Läufe gaben das Französisch wieder.
- Mit Anrufernamen im Vokabular übernahm gemini-3.5-flash-lite in mehreren Gesprächen
  „Samir Weber“ als Sprecherbezeichnung (der Name steht auch im Beispiel des Prompts). Der
  Vokabular-Zusatz verbietet das jetzt ausdrücklich; das Ergebnis ist noch zu prüfen.
- Wortzeiten: Beide Flash-Wege nutzen dasselbe Forced Alignment; gemessene Wortzeiten eines
  Modells gab es nicht. Die Wortmarkierung im Player folgt jetzt je Bild `currentTime` des
  Audio-Elements (Browsertest: 464 von 482 Bildern exakt, die übrigen 18 ein Bild später beim
  Wortwechsel).

## Empfehlung

Nicht auf `gemini-3.5-transcribe` umstellen, solange der Endpunkt nur den Text-Modus erlaubt.
Bisheriges Modell beibehalten. Weil Google `gemini-2.5-flash` ab 1.12.2026 auf
`gemini-3.5-flash-lite` umleitet, vorher an einigen Aufnahmen mit Gehörtem vergleichen, ob
`gemini-3.5-flash-lite` (halb so teuer, schneller) genügt.
