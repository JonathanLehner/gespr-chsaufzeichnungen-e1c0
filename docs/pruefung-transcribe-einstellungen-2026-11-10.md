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

**Stand (11.11.2026):** alle 44 Läufe vollständig (11 Gespräche × 4 Varianten). 37 Läufe am
10.11.; die übrigen sieben (8334 B, C, D und alle vier Varianten von 10980) am 11.11. nach dem
Zurücksetzen des Tageslimits von Google (Tier 1: 100 Anfragen pro Tag).

## Ergebnis

Elf Gespräche (25,6 Audiominuten). Wortanteile und WER ohne Aufnahme 9911 (französisch, das
gespeicherte Transkript hat dort nur 74 Wörter, alle Varianten liefern mehr), also über
10 Gespräche mit 3364 Referenzwörtern. Wortzeiten, Tokens, Kosten und Laufzeit über alle elf.

| | A, heute | B, de-DE | C, Original | D, de-DE + Original |
| --- | --- | --- | --- | --- |
| Wörter gegenüber gespeichertem Transkript, gesamt | 56 % (1885) | 62 % (2077) | 60 % (2005) | 58 % (1959) |
| je Gespräch, Median / schlechtestes | 55 % / 32 % | 71 % / **5 %** | 64 % / 28 % | 50 % / 17 % |
| WER gegenüber gespeichertem Transkript, Mittel | 0,56 | 0,53 | 0,54 | 0,59 |
| Sprecher je Gespräch | 1–4 | 2–4 | 1–3 | 1–4 |
| Wortzeiten: rückwärts / Dauer 0 / ausserhalb (Rohwerte) | 15 / 27 / 0 von 2071 | 15 / 36 / 0 von 2123 | 14 / 36 / 0 von 2191 | 3 / 24 / 0 von 2120 |
| Tokens Audio / Ausgabe | 38 328 / 2900 | 38 328 / 2984 | 38 328 / 3084 | 38 328 / 2944 |
| Kosten gesamt / je Audiominute | $0.112 / $0.0044 | $0.113 / $0.0044 | $0.114 / $0.0044 | $0.112 / $0.0044 |
| Anfrage, Median (Upload / Transkription) | 2,4 s / 5,4 s | 2,2 s / 4,6 s | 2,9 s / 5,2 s | 2,7 s / 4,8 s |

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
| 8334 | 110 | 103 (94 %), 0,35, 2 | 88 (80 %), 0,46, 2 | 105 (95 %), 0,35, 2 | 100 (91 %), 0,38, 2 |
| 10980 | 1009 | 683 (68 %), 0,54, 2 | 614 (61 %), 0,57, 2 | 644 (64 %), 0,56, 2 | 602 (60 %), 0,54, 2 |

Kosten je Gespräch $0.0032–0.0062 je Minute; Laufzeit je Gespräch 7–15 s, bis 78 s, wenn Google
mit 429 bremste und der Lauf eine Minute wartete (10980 mit zwei Abschnitten: 114–125 s).

Beobachtungen:

- Keine Variante ist durchgehend besser. Jede gewinnt bei einigen Gesprächen und verliert bei
  anderen deutlich: B holt 8116 von 42 auf 88 %, lässt aber 10425 fast ganz fallen (5 %). D holt
  8028 auf 83 %, verliert aber 8876 (17 %) und 8355 (31 %).
- Selbst A und C, die sich nur in der Kodierung unterscheiden, liegen bei 8876 bei 69 und 30 %. Die
  Auslassungen schwanken also von Anfrage zu Anfrage; der Unterschied zwischen den Varianten ist
  nicht grösser als diese Schwankung.
- A heute stimmt mit der ersten Prüfung überein (10425: 32 %, 8028: 34 %, 10980: 683 von 1009
  Wörtern, WER 0,56).
- Bei den beiden neuen Gesprächen liegt keine Variante vor A: 8334 ist in allen Varianten fast
  vollständig (80–95 %), bei 10980 liefert A die meisten Wörter (68 % gegenüber 60–64 %).
- Sprechertrennung: C fasst in 8876 und 8028 beide Seiten zu einem Sprecher zusammen, A in 8028
  ebenfalls.
- Originalaudio kostet nichts zusätzlich, verlängert aber den Upload (fünfmal so viele Daten).

## Schweizerdeutsche Passagen

Sätze des gespeicherten Transkripts, von denen die jeweilige Variante kein Wort getroffen hat.

| Gespräch | A | B | C | D | in allen vier Varianten |
| --- | --- | --- | --- | --- | --- |
| 10425 | 12 | 24 | 13 | 15 | 10 |
| 8028 | 40 | 26 | 41 | 6 | 6 |
| 10980 | 27 | 30 | 30 | 27 | 15 |

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

6,2 Minuten, zwei Abschnitte je Variante (bei C und D verlustfrei geschnittene WAV-Abschnitte,
5,98 MB statt 1,13 MB Opus). Gespeichertes Transkript: 1009 Wörter.

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Wörter (Anteil) | 683 (68 %) | 614 (61 %) | 644 (64 %) | 602 (60 %) |
| WER | 0,54 | 0,57 | 0,56 | 0,54 |
| Sprecher je Abschnitt | 2, 2 | 2, 2 | 2, 2 | 2, 2 |
| Wortzeiten roh: rückwärts / Dauer 0 / ausserhalb | 1 / 4 / 0 | 0 / 4 / 0 | 0 / 14 / 0 | 0 / 8 / 0 |
| Wortzeiten übernommen | aufsteigend, innerhalb | aufsteigend, innerhalb | aufsteigend, innerhalb | aufsteigend, innerhalb |
| Tokens Audio / Ausgabe | 9345 / 894 | 9345 / 807 | 9345 / 830 | 9345 / 796 |
| Kosten je Audiominute | $0.0047 | $0.0046 | $0.0046 | $0.0045 |
| Upload / Transkription / gesamt | 4,5 s / 17,0 s / 114 s | 5,0 s / 16,4 s / 122 s | 6,3 s / 16,2 s / 122 s | 6,5 s / 16,1 s / 125 s |
| Sätze ohne getroffenes Wort | 27 | 30 | 30 | 27 |

Die Gesamtlaufzeit enthält die Wartezeiten wegen des Token-Limits pro Minute; die Transkription
selbst dauert rund 16–17 s.

Erste Minute je Variante:

**A** (heute)

> 1,2 s [Sprecher 1] Ja, Frau Waldi. · 2,9 s [Sprecher 2] Ja, grüß Sie, Frau Waldi. · 4,0 s
> [Sprecher 2] Das ist Labruzzo von der Firma Immotrust am Telefon. · 8,5 s [Sprecher 1] Ja. · 9,3 s
> [Sprecher 2] Sie sind Grundstücksentwickler und ganz paar spannende Grundstücke da. · 14,7 s
> [Sprecher 2] In Knonau jetzt bin ich auf Grundstraße gestoßen und natürlich auch Ja. · 23,8 s
> [Sprecher 2] über vielleicht selber gewisse Plan haben mit der Eigenschaft oder ob wir ihnen mal das
> Angebot dürften machen, vielleicht mal an der denkt. · 31,4 s [Sprecher 2] Wie gesagt, die das muss
> ich wieder fragen. · 34,0 s [Sprecher 1] Ja, ich weiß es selber noch nicht so was. · 38,6 s
> [Sprecher 2] Okay. · 39,5 s [Sprecher 2] Aber sind Sie gut Und da denke ich mal, einfach möglichst
> lang so lange alles gut. · 48,4 s [Sprecher 1] Ja, ja, ja. · 50,8 s [Sprecher 1] Ja, genau, genau. ·
> 51,9 s [Sprecher 1] Gut, das kann schnell anders ziehen oder · 54,7 s [Sprecher 2] Ja, wünsch mir
> sich natürlich nicht, ja, aber · 58,2 s [Sprecher 1] Ja. · 59,0 s [Sprecher 2] Was wäre dann so, also
> wenn Sie sich das einfach auch schon irgendwo Was wäre denn so die Alternative, wenn Sie es
> irgendwann muss Gefühl haben, es ist vielleicht doch groß, macht doch nicht viel Arbeit etc.?

**B** (de-DE): 9,3–14,7 s fehlt („Grundstücksentwickler …“), 39–48 s zu einem Satz zusammengezogen

> 1,2 s [Sprecher 1] Ja, grüß dich. · 2,9 s [Sprecher 2] Ja, grüß dich, Frau Walter. · 4,2 s
> [Sprecher 2] Der Schlabruzo von der Firma Immotrust am Telefon. · 8,5 s [Sprecher 1] Ja. · 14,7 s
> [Sprecher 2] In Knonau jetzt bin ich auf Grundstraße gestoßen und natürlich auch vielleicht selber
> gewisse Plan haben mit der Eigenschaft oder ob wir ihnen mal das Angebot dürfte machen, vielleicht
> mal an der Frühstück denkt. · 31,4 s [Sprecher 2] Wie gesagt, die das muss ich Ihnen ja fragen. ·
> 34,0 s [Sprecher 1] Ja, ich weiß es selber noch nicht Okay, aber sind der gut Und da denke ich mal,
> Ja, ja, ja. · 50,8 s [Sprecher 1] Ja, genau, genau. · 51,9 s [Sprecher 1] Gut, das kann schnell
> anders ziehen oder · 54,6 s [Sprecher 2] Ja, wünsch mir sich natürlich nicht, ja, aber · 58,2 s
> [Sprecher 1] Ja.

**C** (Original): als einzige Variante mit „So dann ich einfach ganz ungeniert fragen“ (21 s), dafür
„Immotrust“ als „Imotras“ und „Knonau“ fehlt

> 1,2 s [Sprecher 1] Ja, der Walter. · 2,9 s [Sprecher 2] Ja, grüß dich Frau Walter. · 4,1 s
> [Sprecher 2] Das ist Labruzzo von der Firma Imotras am Telefon. · 8,5 s [Sprecher 1] Ja. · 9,3 s
> [Sprecher 2] Sie sind Grundstück entdeckt oder und sie ganz vorne die Grundstücke auch. · 14,6 s
> [Sprecher 2] In jetzt bin ich auf Grundstraße gestoßen und natürlich auch Ja. · 21,0 s [Sprecher 2]
> So dann ich einfach ganz ungeniert fragen über vielleicht selber gewisse Plan haben mit der
> Eigenschaft oder ob wir ihnen mal das Angebot dürfte machen, vielleicht mal an der denkt sie gesagt
> die das wieder frage. · 34,0 s [Sprecher 1] Ja, ich weiß es selber noch nicht Okay, aber sind der
> gut · 44,4 s [Sprecher 2] Und da denke ich mal wird wahrscheinlich sehr sie einfach möglichst lang so
> lange · 48,1 s [Sprecher 1] Ja, ja, ja. · 50,7 s [Sprecher 1] Ja, genau, genau. · 51,9 s
> [Sprecher 1] Gut, das kann schnell anders oder · 54,6 s [Sprecher 2] Ja, wünscht man sich natürlich
> nicht, ja. · 58,2 s [Sprecher 1] Ja. · 59,0 s [Sprecher 2] Was wäre dann so also wenn Sie sich das
> einfach auch schon irgendwo was wäre denn so wenn wir jetzt irgendwann mal das Gefühl haben, das ist
> vielleicht doch groß, macht doch etc.

**D** (de-DE + Original): Begrüssung der Angerufenen und Firmenname fehlen, Sprecher vertauscht
(der Anrufer ist hier Sprecher 1), 14–34 s fehlt fast ganz

> 2,9 s [Sprecher 1] Ja, grüß dich Frau Walte. · 5,1 s [Sprecher 1] von der Firma am Telefon. · 8,5 s
> [Sprecher 2] Ja. · 9,3 s [Sprecher 1] Sie sind Grundstück In jetzt bin ich auf Grundstraße gestoßen
> und natürlich auch Ja. · 34,0 s [Sprecher 1] Ja, ich weiß es selber noch nicht Okay. · 39,4 s
> [Sprecher 1] Aber sind Ja, ja, ja. · 50,7 s [Sprecher 1] Ja, genau, genau. · 54,7 s [Sprecher 1] Ja,
> wünsch mir sich natürlich nicht, ja. · 58,2 s [Sprecher 2] Ja. · 59,0 s [Sprecher 1] Was wäre denn so,
> also wenn Sie Was wäre denn so die Alternative, wenn Sie mal das Gefühl haben, es ist vielleicht doch
> groß, Was würden Sie dann machen?

In allen vier Varianten fehlen in 10980 (Frau Walter, Liegenschaft in Knonau), vor allem
schweizerdeutsche Antworten der Angerufenen und der Schluss des Gesprächs:

> 44,3 s „Ich bin gut, ich bin schon gut beieinander, ja.“ · 76,2 s „Ja, halt du ja noch Kind, oder wo
> da dann wahrscheinlich noch mitredet, oder vermutlich.“ · 228,0 s „Es ist natürlich so, also man hat
> natürlich relativ viel Situationen, dass das eigentlich geplant ist, dass das vererbt wird innerhalb
> von der Familie.“ · 239,8 s „Es gab Ihnen, was sie in dem Haus.“ · 253,9 s „Das heisst, wenn Kind
> nicht selber sollen die wohnen.“ · 256,3 s „Müsste es natürlich irgendwann schon einmal ein wenig
> Geld in die Hand nehmen, das ist einfach ein Faktor, wo halt öfters vergessen wird, oder?“ ·
> 262,2 s „Also wenn Liegenschaft nicht selber bewohnt mit.“ · 289,9 s „Also halten wir es
> unverbindlich.“ · 327,5 s „Dass er wüsste, wo sich.“ · 329,1 s „Ja, das ist super.“ · 332,1 s „Wie
> können Sie Brief an Kunzstrasse 5 zu?“ · 334,2 s „Ähm, ist für die.“ · 335,0 s „Am Neer haben wir
> fünf, ja, stimmt.“ · 339,5 s „Genau, Sie sind im fünf, ja, stimmt.“ · 343,4 s „Ja, ja, stimmt.“

## Entscheidung

Keine Variante ist klar besser als A. Mit allen 44 Läufen erhöhen B und C den Gesamtanteil leicht
(62 % und 60 % gegenüber 56 %) bei etwas besserer WER (0,53 und 0,54 gegenüber 0,56), aber jede
Variante hat ein schlechteres schlechtestes Gespräch als A (5 %, 28 %, 17 % gegenüber 32 %), D hat
die schlechteste WER (0,59), und beim längsten Gespräch 10980 liefert A die meisten Wörter.

Der Dienst bleibt deshalb bei Opus ohne Sprachangabe; Code, Admin-Einstellungen und Standardmodell
(gemini-3.5-flash-lite) bleiben unverändert. Die schweizerdeutschen Auslassungen lassen sich mit
diesen beiden Einstellungen nicht beheben.
