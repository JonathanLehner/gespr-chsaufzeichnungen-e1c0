# Prüfung der Einstellungen für gemini-3.5-transcribe (10.11.2026)

Frage: Fehlen bei gemini-3.5-transcribe weniger Wörter, wenn der Dienst die Sprache vorgibt oder die
Originalaufnahme statt Opus sendet? Ausgangslage aus der
[Prüfung vom 10.11.2026](pruefung-gemini-3.5-transcribe-2026-11-10.md): 58 % der Wörter des
gespeicherten Transkripts, schlechtestes Gespräch 32 %, WER 0,56.

Dieselben 10 Aufnahmen wie im [Vergleich vom 10.11.2026](vergleich-transkription-2026-11-10.md)
und Anruf 10980. Nur lesend: Audio über die gespeicherte Adresse, Ergebnisse ausserhalb der
Datenbank, kein Transkript überschrieben, Standardmodell unverändert. Skript:
`scripts/pruefung-transcribe-einstellungen.mts`.

Alle Varianten über Files API und Interactions-API mit
`mode = { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] }`,
Abschnitte von höchstens 5 Minuten wie im Dienst:

| Variante | Audio | Sprache |
| --- | --- | --- |
| A (heute im Dienst) | ffmpeg, Opus 24 kbit/s, mono, 16 kHz | automatisch |
| B | wie A | `language_codes: ["de-DE"]` |
| C | Originaldatei unverändert (WAV), bei 10980 verlustfrei in WAV-Abschnitte geschnitten | automatisch |
| D | wie C | `["de-DE"]` |

Referenz ist das gespeicherte Transkript (gemini-2.5-flash), keine Referenzabschrift.

**Stand:** 37 von 44 Läufen. Google hat die übrigen mit 429 abgelehnt: „limit: 100 requests per day
on Tier 1“. Es fehlen 8334 B, C, D und alle vier Varianten von 10980. Der Lauf wird fortgesetzt,
sobald das Tageslimit zurückgesetzt ist; die Tabellen unten werden dann ergänzt. Die Entscheidung
hängt nicht davon ab (siehe unten).

## Ergebnis

Neun Gespräche mit allen vier Varianten (17,5 Audiominuten). Anteile ohne Aufnahme 9911
(französisch, das gespeicherte Transkript hat dort nur 74 Wörter, alle Varianten liefern mehr).

| | A, heute | B, de-DE | C, Original | D, de-DE + Original |
| --- | --- | --- | --- | --- |
| Wörter gegenüber gespeichertem Transkript, gesamt | 49 % | 61 % | 56 % | 56 % |
| je Gespräch, Median / schlechtestes | 52 % / 32 % | 71 % / **5 %** | 57 % / 28 % | 41 % / 17 % |
| WER gegenüber gespeichertem Transkript, Mittel | 0,59 | 0,54 | 0,56 | 0,63 |
| Sprecher je Gespräch | 1–4 | 2–4 | 1–3 | 1–4 |
| Wortzeiten: rückwärts / Dauer 0 / ausserhalb (Rohwerte) | 14 / 22 / 0 von 1285 | 15 / 30 / 0 von 1421 | 14 / 21 / 0 von 1442 | 3 / 13 / 0 von 1418 |
| Tokens Audio / Ausgabe | 26 320 / 1856 | 26 320 / 2060 | 26 320 / 2101 | 26 320 / 2000 |
| Kosten je Audiominute | $0.0043 | $0.0044 | $0.0044 | $0.0044 |
| Anfrage, Median (Upload / Transkription) | 2,3 s / 5,4 s | 2,1 s / 4,6 s | 2,9 s / 5,2 s | 2,7 s / 4,8 s |

Gesendete Datenmenge: Opus rund 0,27 MB je 90 s, WAV rund 1,45 MB. Die Audio-Tokens sind gleich,
Google rechnet nach Dauer ab. Wortzeiten nach der Übernahme in die Transkriptstruktur: in allen
Varianten aufsteigend und innerhalb der Aufnahme.

### Je Gespräch

Wörter (Anteil am gespeicherten Transkript), WER, Sprecher.

| Gespräch | Referenz | A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| 9911 (franz.) | 74 | 185 (250 %), –, 2 | 45 (61 %), –, 2 | 186 (251 %), –, 2 | 159 (215 %), –, 1 |
| 9295 | 161 | 89 (55 %), 0,60, 4 | 114 (71 %), 0,49, 4 | 136 (84 %), 0,47, 3 | 98 (61 %), 0,55, 4 |
| 8876 | 77 | 53 (69 %), 0,55, 2 | 65 (84 %), 0,51, 2 | 23 (30 %), 0,74, 1 | 13 (17 %), 0,84, 2 |
| 10425 | 244 | 77 (32 %), 0,75, 2 | 13 (5 %), 0,95, 2 | 69 (28 %), 0,77, 2 | 53 (22 %), 0,82, 2 |
| 8369 | 247 | 257 (104 %), 0,16, 2 | 247 (100 %), 0,18, 2 | 249 (101 %), 0,16, 2 | 204 (83 %), 0,23, 2 |
| 8028 | 709 | 238 (34 %), 0,74, 1 | 332 (47 %), 0,63, 2 | 240 (34 %), 0,73, 1 | 587 (83 %), 0,45, 2 |
| 8116 | 388 | 164 (42 %), 0,66, 2 | 342 (88 %), 0,36, 2 | 247 (64 %), 0,52, 2 | 158 (41 %), 0,65, 2 |
| 8355 | 262 | 143 (55 %), 0,58, 2 | 186 (71 %), 0,50, 2 | 214 (82 %), 0,48, 2 | 80 (31 %), 0,79, 2 |
| 8486 | 157 | 78 (50 %), 0,66, 3 | 76 (48 %), 0,67, 3 | 78 (50 %), 0,61, 3 | 64 (41 %), 0,69, 3 |
| 8334 | 110 | 103 (94 %), 0,35, 2 | ausstehend | ausstehend | ausstehend |
| 10980 | 1008 | ausstehend | ausstehend | ausstehend | ausstehend |

Kosten je Gespräch $0.0032–0.0062 je Minute; Laufzeit je Gespräch 7–15 s, bis 78 s, wenn Google
mit 429 bremste und der Lauf eine Minute wartete.

Beobachtungen:

- Keine Variante ist durchgehend besser. Jede gewinnt bei einigen Gesprächen und verliert bei
  anderen deutlich: B holt 8116 von 42 auf 88 %, lässt aber 10425 fast ganz fallen (5 %). D holt
  8028 auf 83 %, verliert aber 8876 (17 %) und 8355 (31 %).
- Selbst A und C, die sich nur in der Kodierung unterscheiden, liegen bei 8876 bei 69 und 30 %. Die
  Auslassungen schwanken also von Anfrage zu Anfrage; der Unterschied zwischen den Varianten ist
  nicht grösser als diese Schwankung.
- A heute stimmt mit der ersten Prüfung überein (10425: 32 %, 8028: 34 %, WER 0,59 statt 0,56).
- Sprechertrennung: C fasst in 8876 und 8028 beide Seiten zu einem Sprecher zusammen, A in 8028
  ebenfalls.
- Originalaudio kostet nichts zusätzlich, verlängert aber den Upload (fünfmal so viele Daten).

## Schweizerdeutsche Passagen

Sätze des gespeicherten Transkripts, von denen die jeweilige Variante kein Wort getroffen hat.

| Gespräch | A | B | C | D | in allen vier Varianten |
| --- | --- | --- | --- | --- | --- |
| 10425 | 12 | 24 | 13 | 15 | 10 |
| 8028 | 40 | 26 | 41 | 6 | 6 |

In allen Varianten fehlen in 10425 (Gespräch mit Frau Rombach, Schlieren):

> 11,8 s „Herr Hans Jörg Rombach hätte ich gesucht gehabt.“ · 14,2 s „Er ist nicht da, um was geht
> es?“ · 16,2 s „Und es hat sich eigentlich darum, dass wir aktuell gerade ein paar spannende
> Liegenschaften prüfen …“ · 46,5 s „Dann haben wir keine Frage klären, selber.“ · 48,8 s „Wenn Sie in
> dem Sinn Entwickler und suchen einfach noch spannende Liegenschaften.“ · 53,5 s „Von dem her haben
> Sie dann eine, wo sie jetzt eher zur Veräusserung vorgesehen.“ · 56,1 s „Gar nicht, gar nicht.“ ·
> 58,9 s „Wir haben keine, wo wir möchten verkaufen.“ · 61,9 s „Wenn sich irgendetwas anderes heute
> könnte aus Zukunft als interessant …“

In allen Varianten fehlen in 8028 (Herr Lüthi):

> 13,8 s „Schön, schön, freut mich sehr, Herr Lüthi.“ · 16,4 s „Und zwar haben wir uns mal mit Ihrer
> Liegenschaft am Öschbrig 17 in Zürich.“ · 48,5 s „Wegen dem Verkauf von meiner Liegenschaft,
> meinen Sie, oder wie?“ · 182,9 s „Ja, da müsste ich mal mit Ihnen.“ · 200,1 s „Aber dass sie mir.“ ·
> 200,1 s „Soll ich mich dann wieder mal melden?“

A in 10425, erste Minute (zum Vergleich: Gruss, Frage nach Herrn Rombach und Anliegen fehlen):

> 0,1 s [Sprecher 1] von der Firma am Telefon. · 10,0 s [Sprecher 2] Ja. · 10,3 s Was gibt's? ·
> 21,6 s Ja. · 33,6 s Und welche Liegenschaft geht's? · 35,6 s Also in Zürichstraße? · 37,2 s
> [Sprecher 1] 19 in Schlieren. · 38,6 s [Sprecher 2] Ah, das ist ja. · 40,1 s Nein, das wollen wir
> nicht verkaufen. · 58,4 s [Sprecher 1] Okay. · 59,1 s Alles klar.

## Anruf 10980

Ausstehend (Tageslimit). Folgt mit Wörtern, WER, Sprechern, Wortzeiten, Kosten und der ersten Minute
je Variante.

## Entscheidung

Keine Variante ist klar besser als A. B und C erhöhen zwar den Gesamtanteil, aber jede Variante hat
ein schlechteres schlechtestes Gespräch als A (5 %, 28 %, 17 % gegenüber 32 %), und D hat die
schlechteste WER. Die fehlenden Läufe können daran nichts ändern: Das schlechteste Gespräch kann
mit weiteren Gesprächen nur schlechter werden.

Der Dienst bleibt deshalb bei Opus ohne Sprachangabe; Code, Admin-Einstellungen und Standardmodell
(gemini-3.5-flash-lite) bleiben unverändert. Die schweizerdeutschen Auslassungen lassen sich mit
diesen beiden Einstellungen nicht beheben.
