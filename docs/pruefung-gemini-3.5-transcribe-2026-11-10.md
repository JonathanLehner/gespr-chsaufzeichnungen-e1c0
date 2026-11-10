# Prüfung gemini-3.5-transcribe über die Gemini API direkt (10.11.2026)

Dieselben 10 Aufnahmen wie im [Vergleich vom 10.11.2026](vergleich-transkription-2026-11-10.md)
(WAV, 90–273 s, zusammen 19,3 Minuten), dazu Anruf 10980 (6,2 Minuten). Nur lesend: Audio über die
gespeicherte Adresse, Ergebnisse ausserhalb der Datenbank, kein Transkript überschrieben.

Weg: Files API (fortsetzbarer Upload, Opus 24 kbit/s) und Interactions-API mit
`transcription_config.mode = { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] }`,
ohne `custom_vocabulary` (Google lehnt die Kombination ab). Ganze Datei je Anfrage (alle unter 5
Minuten). Zwei Varianten: ohne Sprachangabe (so arbeitet der Dienst) und mit
`language_codes: ["de-CH", "de-DE"]`. Referenz ist das gespeicherte Transkript (gemini-2.5-flash) zum
Zeitpunkt des Vergleichs, keine Referenzabschrift.

## Ergebnis

| | gemini-3.5-transcribe, ohne Sprachangabe | mit de-CH/de-DE | gemini-3.5-flash-lite (Vergleich) |
| --- | --- | --- | --- |
| Wörter gegenüber gespeichertem Transkript, gesamt | 58 % | 56 % (9 Gespräche*) | rund 90 % |
| je Gespräch, Median / schlechtestes | 56 % / 32 % | 64 % / 6 % | 91 % / 68 % |
| WER gegenüber gespeichertem Transkript, Mittel ohne Aufnahme 1 (französisch) | 0,56 | 0,56 | 0,40 |
| Schleifen („Ja. Ja. …“) | keine, längste Wiederholung 10 Wörter | keine | – |
| Sprecher je Gespräch | 1–4, meist 2 | 2–3 | 2–5 |
| Kosten je Audiominute, gemessen | $0.0042 | $0.0041 | $0.0029 |

\* Eine Anfrage lehnte Google mit 429 ab: „limit: 10000 input tokens per minute on Tier 1“.

Wortzeiten (Rohwerte von Google, 1388 Wörter): keines ausserhalb der Aufnahme, Dauer im Median 0,2 s,
95 % unter 0,7 s, keines über 3 s; 14 Wörter beginnen vor ihrem Vorgänger, 23 haben die Dauer 0. Die
Übernahme in die Transkriptstruktur zieht solche Wörter auf den Vorgänger nach
(`transcriber/shared/word-timestamps.ts`); im gespeicherten Transkript sind die Zeiten aufsteigend.

Beobachtungen:

- Die Auslassungen bleiben. Am stärksten bei schweizerdeutschen Passagen: In Anruf 10425 fehlten
  68 % (mit Sprachangabe 94 %), in 8028 67 %. In 10980 fehlen die Stellen vor allem am
  Gesprächsanfang und betreffen dort beide Seiten.
- In mehreren Gesprächen fasst die Sprechertrennung Mitarbeiter und Kunde zu einem Sprecher zusammen
  (8028 ohne Sprachangabe: ein einziger Sprecher).
- Die Sprachangabe hilft nicht: Sie verschlechtert 10425 und ändert sonst wenig. Der Dienst sendet
  keine.
- Namen: „La Brusso“, „ImmoTrust“ gleicht die Nachkorrektur aus dem Vokabular an („Labruzzo“,
  „Immotrust“), ohne Zeiten zu ändern (14 Korrekturen in 3824 Wörtern, keine falsche). Stark
  verhörte Namen („Schlabrutzo“, „Imotras“) bleiben.

## Anruf 10980

| | gespeichert (gemini-2.5-flash) | gemini-3.5-transcribe, ganze Datei | gemini-3.5-transcribe im Dienst (2 Abschnitte in Pausen) |
| --- | --- | --- | --- |
| Wörter | 1008 | 630 (63 %) | 696 (69 %) |
| Wörter in 0–30 s / 30–60 s | 67 / 89 | 15 / 36 | 66 / 70 |
| Sprecher | 4 | 3 | 2 |
| Tokens Audio / Ausgabe | – | 9345 / 816 | 9345 / 886 |
| Kosten | – | $0.0285 | $0.0293 ($0.0047/min) |

Erste Minute, gespeichert:

> 1,2 s [Herr Verwalter] Ja, das wäre ich. · 3,1 s [Labruzzo] Ja, grüezi, Herr Verwalter, das Labruzzo
> von der Firma Immo Trust am Telefon. · 9,3 s [Labruzzo] Sie sind Grundstückentwickler, so ähnlich,
> und schauen, dass [unverständlich] die Grundstücke in Knonau. · 14,6 s Jetzt bin ich auf
> Grundstrasse gestossen, auf die Fünf und natürlich auch die Drei. · 21,5 s Da habe ich einfach mal
> ganz ungeniert nachfragen dürfen, ob sie vielleicht selber gewisse Pläne haben mit der Liegenschaft …

Erste Minute, gemini-3.5-transcribe im Dienst:

> 1,2 s [Sprecher 1] Ja, Frau Waldi. · 2,9 s [Sprecher 2] Ja, grüß dich Frau Waldi. · 4,1 s Der
> Schlabrutzo von der Firma Imotras am Telefon. · 9,3 s Sie sind Grundstück Entwickler in Und ganz
> spannend die Grundstücke nach in Jetzt bin ich auf Grundstraße gestoßen und natürlich auch Ja. ·
> 21,4 s Dann dann ich einfach ganz ungeniert nachher fragen über vielleicht selber gewisse Plan haben
> mit der Eigenschaft …

Die Lücke der ersten Minute ist im Dienst-Lauf kleiner, im Lauf mit der ganzen Datei nicht. Das
Ergebnis schwankt also von Anfrage zu Anfrage; vollständig ist keiner der Läufe.

## Entscheidung

gemini-3.5-transcribe ist nicht mindestens so vollständig wie die bisherigen Transkripte und wird
nicht Standard. Standard für alle neuen Transkripte ist ab diesem Deploy **gemini-3.5-flash-lite**;
gemini-2.5-flash ist abgelöst und bleibt nur Bezeichnung älterer Transkripte. gemini-3.5-transcribe
bleibt im Dashboard wählbar (direkt über `GEMINI_API_KEY`), etwa für Neu-Transkriptionen einzelner
Aufnahmen.

Grenze bei Google: Stufe 1 erlaubt 10 000 Eingabe-Tokens je Minute (rund 6,5 Audiominuten). Der Dienst
schneidet für gemini-3.5-transcribe deshalb Abschnitte von höchstens 5 Minuten in Pausen, statt der
30 Minuten, die Google mit Wortzeiten sonst zuliesse.
