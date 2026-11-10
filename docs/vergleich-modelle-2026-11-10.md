# Modellvergleich Transkription (10.11.2026)

Test, nichts umgestellt: Standardmodell, Produktionsdaten und Deploy unverändert. Jedes Modell
transkribiert allein in einem Durchgang (kein Zwei-Pass, keine Kombination).

## Aufbau

- **Aufnahmen**: dieselben 10 Vergleichsgespräche wie am 10.11.2026 (WAV 8 kHz, 90–273 s, zusammen
  19,3 min) und Anruf 10980 (`rec_6a31e725d22faf8445f76373`, 6,2 min). Lesende Kopien ausserhalb
  der Datenbank.
- **Referenz**: das gespeicherte gemini-2.5-flash-Transkript. Für 10980 ist das die Fassung aus
  `transcript_history_parts` (16:08), weil das aktuelle Transkript seit 20:07 von
  gemini-3.5-transcribe stammt. Die Referenz ist keine geprüfte Abschrift.
- **Prompt-Modelle** (flash-lite, argon, carbon, 3.8-flash): wie im Dienst derselbe Prompt
  (`PROMPT`/`chunkPrompt` mit Vokabular aus `BASE_VOCABULARY` und den 7 Anrufernamen), dasselbe
  `responseSchema`, temperature 0, 60-s-Abschnitte, je Gespräch 2 Abschnitte gleichzeitig. Anders als
  im Dienst: **Originalaudio** (WAV-PCM, verlustfrei geschnitten, kein Opus) und direkt über
  `GEMINI_API_KEY`. Zeitgrenze 300 s, gezählt wird auch, was über die 120 s des Dienstes geht.
- **Denkstufen**: `minimal` nimmt nur flash-lite an. argon, carbon und 3.8-flash lehnen `minimal` ab
  („not supported for this model“), daher dort `low` gegen Standard (ohne `thinkingConfig`).
  gemini-4-argon erzeugt bei diesem Auftrag in beiden Stufen 0 Denk-Tokens.
- **gemini-3.5-transcribe**: nicht neu gestartet, sondern die Ergebnisse von Auftrag
  6af37fd2b70571a2e52d1579 (Varianten A–D) übernommen. Gezeigt wird die beste Variante (meiste
  behaltene Wörter ohne 9911). Der Lauf war nach 10 von 44 Anfragen stehen geblieben und wurde mit
  seinem eigenen Skript fortgesetzt, das fertige Anfragen überspringt. Stand beim Schreiben: 36 von 44
  Läufen fertig (Google lässt für dieses Modell 10 000 Eingabe-Tokens je Minute zu); die Spalte
  wird erneuert, wenn der Lauf fertig ist.
- **Preise** (USD je 1 Mio. Tokens, Ausgabe inkl. Denken): flash-lite 0,30/2,50; argon und carbon
  2/10 bis 30.11.2026, **4/20 ab 1.12.2026**; 3.8-flash 0,75/3,75 bis 31.12.2026, 1,50/7,50 ab
  1.1.2027; 3.5-transcribe 2/12.

Skripte: `scripts/vergleich-modelle.mts` (Lauf), `scripts/vergleich-modelle-bericht.mjs` (Tabellen).

## Ergebnis in Kürze

| | 3.5-flash-lite (Standard) | 4-argon low | 4-carbon low | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe |
| --- | --- | --- | --- | --- | --- | --- |
| Wörter ggü. gespeichert (ohne 9911) | 95 % | 106 % | 107 % | 104 % | 104 % | rund 60 % |
| Schweizerdeutsch (Lesecheck, 3 Fenster) | viele Fehler (32) | 2 | 2 | 4 | 2 | lückenhaft |
| Sprecher mit Namen | 38 % der Bezeichnungen | 57 % | 57 % | 48 % | 54 % | keine |
| Satzzeiten des Modells, Abstand zur Ausrichtung (Median) | 7,2 s | 1,7 s | 1,9 s | 1,0 s | 2,0 s | eigene Wortzeiten |
| Kosten je Audiominute | $0.0029 | $0.016, ab 1.12. $0.032 | $0.016, ab 1.12. $0.033 | $0.0060, ab 2027 $0.012 | $0.030, ab 2027 $0.060 | $0.0045 |
| Laufzeit je Audiominute | 2,9 s | 8,6 s | 9,3 s | 7,8 s | 45 s | 13 s |
| Ungültiges JSON / Zeitüberschreitung / Fehler | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0, 3 Anfragen über 120 s | 0 / 0 / 0 (429 wiederholt) |

Mehr Wörter als die Referenz heisst hier nicht „erfunden“: Die Referenz lässt selbst Stellen aus
(Gesprächsenden, kurze Antworten, Aufnahme 9911 auf Französisch). Die stärkeren Modelle geben diese
Stellen wieder (siehe Lesecheck).

## Lesecheck an drei Fenstern zu 30 s

**Einschränkung:** Ich kann die Aufnahmen nicht anhören. Die Zahlen unten sind deshalb kein
Abgleich mit dem Gehörten, sondern Abweichungen von der **Mehrheitslesart** der unabhängigen
Läufe (argon ×2, carbon ×2, 3.8-flash ×2, gespeichertes Transkript). Gezählt sind nur Abweichungen
im Sinn: verhörte oder unsinnige Wörter, falsche Namen, fehlende Sätze, falscher Sprecher. Kein
Fehler ist, wenn Schweizerdeutsch ins Hochdeutsche übertragen wird, wie es der Prompt verlangt.
Die Ausschnitte zum Anhören liegen ausserhalb des Repos (siehe unten). Das Abhören bleibt
offen und sollte bestätigen, bevor das Standardmodell wechselt.

| Fenster | 3.5-flash-lite | 4-argon low | 4-argon Std | 4-carbon low | 4-carbon Std | 3.8-flash low | 3.8-flash Std | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10425, 0–30 s (Kundin Schweizerdeutsch) | 10 | 0 | 0 | 1 | 0 | 1 | 1 | fast alles fehlt |
| 8028, 60–90 s (Kunde Schweizerdeutsch, schnell) | 10 | 1 | 0 | 0 | 0 | 2 | 0 | 6 |
| 10980, 0–30 s (beide Schweizerdeutsch) | 12 | 1 | 0 | 1 | 0 | 1 | 1 | offen |
| **Summe** | **32** | **2** | **0** | **2** | **0** | **4** | **2** | – |

Typische Fehler von flash-lite in diesen Fenstern: „der Schlafer Uzo“ statt „Labruzzo“, „Frau Malte“
statt „Frau Wälti“, „Grundstück in die Käsliche“, „Rigeschaft“ statt „Liegenschaft“, „Frau
Bachmann“ (Name aus dem Beispiel im Prompt, im Gespräch nicht gesagt). In 10980 vertauscht es die
Sprecher: Der Anrufer heisst „Sprecher 1“, die Kundin „Valerio Labruzzo“. argon, carbon und
3.8-flash geben dieselben Stellen fast wortgleich wieder. Strittig bleiben nur einzelne Namen
(„Rombach“ bei argon/carbon und im gespeicherten Transkript, „Rohrbach“ bei 3.8-flash; „Wälti“
gegen „Welti“) und in 10980 „aus Örlikon“ (Standard-Denken, 3.8-flash) gegen „Zürcher“ (low).

Ausschnitte: `~/clawcorp-results/gespr-e1c0-models/clips/` (`10425_0-30s.wav`, `8028_60-90s.wav`,
`10980_0-30s.wav`), die Texte aller Modelle je Fenster stehen am Ende der Tabellen.

## Beobachtungen

- **Vollständigkeit**: Alle Prompt-Modelle liefern jedes Gespräch ganz, keine Lücken, kein
  ungültiges JSON. flash-lite behält 95 % der Wörter der Referenz, argon, carbon und 3.8-flash
  104–107 %. gemini-3.5-transcribe bleibt bei rund 60 % und lässt vor allem schweizerdeutsche
  Passagen weg.
- **Sprecher**: Wie im Dienst werden die 60-s-Abschnitte über die Bezeichnung zusammengeführt. Weil
  jeder Abschnitt einzeln bezeichnet wird, kommen bei allen Prompt-Modellen neben Namen auch
  „Sprecher 1/2“ vor (3–4 Bezeichnungen für meist 2 Personen). Namen vergeben argon und carbon am
  häufigsten und meist so, wie sie im Gespräch fallen (Frau Rombach, Frau Wälti, Herr Lüthi, Frau
  Roos). flash-lite übernahm einmal einen fremden Anrufernamen aus dem Vokabular („Samir Weber“ in
  einem Gespräch von Ivana Zivkovic), 3.8-flash low einmal „Carlos“. gemini-3.5-transcribe liefert
  nur Nummern.
- **Namen und Begriffe**: „Immotrust“ schreiben argon, carbon und 3.8-flash überall richtig, auch wo
  die Referenz „Immo Trust“ oder „Emotrust“ hat. flash-lite schreibt einmal „Immo Trust“, einmal
  „Immotrast“. „Labruzzo“ stimmt bei allen ausser flash-lite in 10980 („Schlafer Uzo“). Strassen:
  „Zürcherstrasse“ (Schlieren), „Zugerstrasse“, „Grundstrasse“ (Knonau) bei argon/carbon richtig;
  3.8-flash low machte in 8116 aus „Zugerstrasse“ einmal „Zürcherstrasse“.
- **Satzzeiten vor dem Forced Alignment**: Keines der Modelle setzt Sätze ausserhalb des
  Abschnitts. flash-lite liegt im Median 7 s neben der akustischen Ausrichtung und hat 10 Sätze mit
  Ende vor Beginn. argon und carbon liegen bei 1,7–2,1 s, 96–97 % der Satzanfänge fallen in erkannte
  Sprache. 3.8-flash low liegt am nächsten an der Ausrichtung (1,0 s), hat aber 27 Sätze (6 %), die
  vor dem Ende des vorigen beginnen. Die Ausrichtung im Dienst bleibt für alle nötig.
- **Denken**: argon denkt bei dieser Aufgabe nicht (0 Tokens in beiden Stufen), Standard und low
  kosten gleich viel. carbon Standard denkt rund 940 Tokens je Minute (+57 % Kosten, doppelte
  Laufzeit) ohne sichtbar besseres Ergebnis. 3.8-flash Standard denkt rund 6100 Tokens je Minute,
  einzelne Abschnitte bis 25 000; 3 Anfragen dauerten über 120 s und würden im Dienst abbrechen.
  3.8-flash low denkt im Mittel 230 Tokens je Minute.
- **Audio-Tokens**: argon und carbon zählen dieselbe Minute als rund 1800 statt 1500 Tokens, den
  Prompt als 1530 statt 820.

## Empfehlung

**Standardmodell: gemini-3.8-flash mit Denkstufe `low`**, sobald das Abhören der drei Fenster den
Lesecheck bestätigt.

- Es liest Schweizerdeutsch, Namen und Strassen auf dem Niveau der Gemini-4-Modelle (Lesecheck 4
  gegen 32 Abweichungen bei flash-lite) und lässt nichts aus.
- Es kostet rund das Doppelte von flash-lite ($0.0060 statt $0.0029 je Audiominute, ab 1.1.2027
  $0.012) und braucht 7,8 s je Audiominute.
- gemini-4-argon und gemini-4-carbon (low) sind in diesem Test kaum besser als 3.8-flash low, kosten
  aber das 2,7-Fache und vom 1.12.2026 bis Ende 2026 das 5,4-Fache (ab 2027, wenn auch 3.8-flash teurer wird, wieder das 2,7-Fache). Lohnt sich nur, wenn das Abhören bei 3.8-flash
  deutlich mehr Fehler zeigt; dann **argon** (gleiche Qualität wie carbon, kein Denken, etwas
  günstiger).
- Nicht empfohlen: carbon und 3.8-flash mit Standard-Denken (teurer und langsamer ohne Gewinn;
  3.8-flash Standard überschreitet die 120-s-Grenze des Dienstes), gemini-3.5-transcribe
  (unvollständig).
- Für die Umstellung braucht der Dienst einen Eintrag für gemini-3.8-flash in
  `transcriber/shared/models.ts` (Denkstufe `low`, Weg direkt). Nicht Teil dieses Tests.

Kosten bei der genannten Menge (600 Aufnahmen × 5 min = 3000 Audiominuten), je Monat oder einmalig
für den ganzen Bestand; gemessen sind es heute 612 Aufnahmen mit zusammen 1559 Minuten:

| Modell | 3000 min | 1559 min (Bestand) |
| --- | --- | --- |
| 3.5-flash-lite (heute) | $8.60 | $4.47 |
| 3.8-flash low, bis 31.12.2026 / ab 1.1.2027 | $18 / $36 | $9.40 / $19 |
| 4-argon low, bis 30.11.2026 / ab 1.12.2026 | $48 / $97 | $25 / $50 |
| 4-carbon low, bis 30.11.2026 / ab 1.12.2026 | $49 / $98 | $25 / $51 |
| 4-carbon Standard, ab 1.12.2026 | $154 | $80 |
| 3.8-flash Standard, ab 1.1.2027 | $180 | $93 |

## Tabellen

Erzeugt mit `node scripts/vergleich-modelle-bericht.mjs` aus den Rohdaten in
`~/clawcorp-results/gespr-e1c0-models/results.json` und
`~/clawcorp-results/gespr-e1c0-settings/results.json`.

<!-- tabellen:start -->

### gemini-3.5-transcribe: Varianten aus Auftrag 6af37fd2 (ohne 9911)

| Variante | Läufe | Wörter behalten, gesamt | Median |
| --- | --- | --- | --- |
| B Opus, de-DE | 8/10 (unvollständig) | 61 % | 71 % |
| D Original, de-DE | 8/10 (unvollständig) | 56 % | 41 % |
| C Original, ohne Sprache | 8/10 (unvollständig) | 56 % | 57 % |
| A Opus, ohne Sprache | 8/10 (unvollständig) | 49 % | 52 % |

Beste Variante: **B (Opus, de-DE)**.

### Übersicht (10 Vergleichsgespräche, ohne 10980)

|  | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Läufe ok | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 9/10 |
| Wörter behalten gesamt (ohne 9911) | 95 % | 106 % | 107 % | 107 % | 106 % | 104 % | 104 % | 61 % |
| je Gespräch Median / schlechtestes | 96 % / 89 % | 106 % / 99 % | 108 % / 98 % | 105 % / 101 % | 105 % / 101 % | 104 % / 98 % | 104 % / 97 % | 71 % / 5 % |
| WER ggü. gespeichert, Mittel (ohne 9911) | 0.37 | 0.34 | 0.34 | 0.35 | 0.35 | 0.34 | 0.35 | 0.54 |
| Tokens je Audiominute Audio / Text / Ausgabe / Denken | 1500 / 824 / 868 / 0 | 1802 / 1533 / 942 / 0 | 1802 / 1533 / 931 / 0 | 1802 / 1533 / 959 / 0 | 1802 / 1533 / 950 / 942 | 1500 / 824 / 907 / 231 | 1500 / 824 / 1405 / 6108 | 1500 / 1 / 117 / 0 |
| Kosten je Audiominute | $0.0029 | $0.0161 (bis 30.11.2026)<br>$0.0322 (ab 1.12.2026) | $0.0160 (bis 30.11.2026)<br>$0.0320 (ab 1.12.2026) | $0.0163 (bis 30.11.2026)<br>$0.0325 (ab 1.12.2026) | $0.0256 (bis 30.11.2026)<br>$0.0512 (ab 1.12.2026) | $0.0060 (bis 31.12.2026)<br>$0.0120 (ab 1.1.2027) | $0.0299 (bis 31.12.2026)<br>$0.0598 (ab 1.1.2027) | $0.0044 |
| Laufzeit je Audiominute | 2.9 s | 8.6 s | 13.0 s | 9.3 s | 18.2 s | 7.8 s | 45.1 s | 13.1 s |
| ungültiges JSON / Zeitüberschr. / Fehler | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Anfragen über 120 s (Grenze im Dienst) | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| Abschnitte ohne Ergebnis | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Kosten hochgerechnet

| Modell | Preis | je Audiominute | 600 Aufnahmen × 5 min (Angabe) | Bestand gemessen: 612 Aufnahmen, 1559 min |
| --- | --- | --- | --- | --- |
| 3.5-flash-lite minimal | aktuell | $0.0029 | $8.60 | $4.47 |
| 4-argon low | bis 30.11.2026 | $0.0161 | $48.28 | $25.09 |
| 4-argon low | ab 1.12.2026 | $0.0322 | $96.56 | $50.18 |
| 4-argon Standard | bis 30.11.2026 | $0.0160 | $47.95 | $24.92 |
| 4-argon Standard | ab 1.12.2026 | $0.0320 | $95.89 | $49.83 |
| 4-carbon low | bis 30.11.2026 | $0.0163 | $48.77 | $25.35 |
| 4-carbon low | ab 1.12.2026 | $0.0325 | $97.54 | $50.69 |
| 4-carbon Standard | bis 30.11.2026 | $0.0256 | $76.77 | $39.90 |
| 4-carbon Standard | ab 1.12.2026 | $0.0512 | $153.54 | $79.79 |
| 3.8-flash low | bis 31.12.2026 | $0.0060 | $18.03 | $9.37 |
| 3.8-flash low | ab 1.1.2027 | $0.0120 | $36.07 | $18.74 |
| 3.8-flash Standard | bis 31.12.2026 | $0.0299 | $89.75 | $46.64 |
| 3.8-flash Standard | ab 1.1.2027 | $0.0598 | $179.51 | $93.28 |
| 3.5-transcribe B | aktuell | $0.0044 | $13.23 | $6.88 |

### Wörter behalten je Gespräch (gegenüber gespeichertem gemini-2.5-flash-Transkript)

| Anruf (Wörter gespeichert) | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9911 (74) | 228 % (169) | 222 % (164) | 220 % (163) | 224 % (166) | 218 % (161) | 151 % (112) | 243 % (180) | 61 % (45) |
| 9295 (161) | 96 % (155) | 109 % (176) | 109 % (175) | 108 % (174) | 105 % (169) | 105 % (169) | 107 % (173) | 71 % (114) |
| 8876 (77) | 95 % (73) | 99 % (76) | 100 % (77) | 101 % (78) | 103 % (79) | 99 % (76) | 97 % (75) | 84 % (65) |
| 10425 (244) | 102 % (249) | 115 % (281) | 118 % (288) | 118 % (289) | 117 % (285) | 111 % (270) | 113 % (275) | 5 % (13) |
| 8369 (247) | 93 % (230) | 100 % (246) | 98 % (242) | 101 % (250) | 101 % (250) | 98 % (243) | 101 % (250) | 100 % (247) |
| 8028 (709) | 93 % (662) | 106 % (751) | 104 % (735) | 105 % (741) | 104 % (740) | 101 % (717) | 100 % (709) | 47 % (332) |
| 8116 (388) | 89 % (344) | 103 % (401) | 108 % (419) | 105 % (406) | 105 % (408) | 106 % (412) | 107 % (417) | 88 % (342) |
| 8355 (262) | 97 % (255) | 108 % (284) | 110 % (287) | 109 % (285) | 108 % (283) | 103 % (270) | 104 % (272) | 71 % (186) |
| 8486 (157) | 104 % (163) | 104 % (163) | 104 % (163) | 105 % (165) | 104 % (163) | 104 % (163) | 102 % (160) | 48 % (76) |
| 8334 (110) | 105 % (115) | 114 % (125) | 114 % (125) | 114 % (125) | 116 % (128) | 115 % (126) | 111 % (122) | – |
| 10980 (1009) | 92 % (927) | 111 % (1117) | 112 % (1129) | 112 % (1127) | 114 % (1154) | 109 % (1099) | 112 % (1126) | – |

### Sprecher (Bezeichnungen wie gespeichert)

Bezeichnungen nach dem Zusammensetzen der 60-s-Abschnitte wie im Dienst (gleiche Bezeichnung = gleicher Sprecher). ⚠ = Name eines anderen Anrufers aus dem Vokabular.

| | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bezeichnungen je Gespräch, Mittel | 3.1 | 4.0 | 4.0 | 4.0 | 4.0 | 4.2 | 3.8 | nur Nummern |
| davon mit Namen | 38 % | 57 % | 57 % | 57 % | 59 % | 48 % | 55 % | – |
| fremder Anrufername als Sprecher | 1 | 0 | 0 | 0 | 0 | 1 | 0 | – |

| Anruf (Anrufer) | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9911 (Valerio Labruzzo) | 2: Valerio Labruzzo, Sprecher 1 | 2: Sprecher 1, Labruzzo | 2: Sprecher 1, Labruzzo | 2: Sprecher 1, Labruzzo | 2: Sprecher 1, Labruzzo | 2: Sprecher 1, Labruzzo | 2: Sprecher 1, Labruzzo | 2 (nur Nummern) |
| 9295 (Hossain Mortazavi) | 3: Hossain Mortazavi, Sprecher 2, Sprecher 1 | 5: Sprecher 1, Hoss, Herr Freh, Herr Reher, Sprecher 2 | 4: Sprecher 1, Hossain Mortazavi, Christian Frey, Sprecher 2 | 5: Sprecher 1, Hoss, Christian Frey, Herr Reer, Sprecher 2 | 4: Sprecher 1, Hoss, Christian Frei, Herr Wehr | 5: Sprecherin 1, Hossain Mortazavi, Herr Frei, Sprecher 1, Sprecher 2 | 3: Sprecher 1, Hoss, Herr Frei | 4 (nur Nummern) |
| 8876 (Oktay Arslantas) | 2: Sprecher 1, Sprecher 2 | 4: Frau Leib, Oktay, Sprecher 1, Sprecher 2 | 4: Frau Leib, Oktay, Sprecher 1, Sprecher 2 | 4: Frau Leib, Oktay, Sprecher 1, Sprecher 2 | 4: Leib, Oktay, Sprecher 1, Sprecher 2 | 4: Frau Leib, Oktay Arslantas, Sprecher 1, Sprecher 2 | 4: Leib, Oktay Arslantas, Sprecher 1, Sprecher 2 | 2 (nur Nummern) |
| 10425 (Valerio Labruzzo) | 4: Frau Rumbach, Hansjörg Rumbach, Sprecher 1, Sprecher 2 | 3: Frau Rombach, Valerio Labruzzo, Sprecher 1 | 3: Frau Rombach, Valerio Labruzzo, Sprecher 1 | 3: Frau Rombach, Valerio Labruzzo, Sprecher 1 | 3: Frau Rombach, Valerio Labruzzo, Sprecher 1 | 4: Frau Rohrbach, Valerio Labruzzo, Sprecher 1, Sprecher 2 | 4: Frau Rohrbach, Valerio Labruzzo, Sprecher 1, Sprecher 2 | 2 (nur Nummern) |
| 8369 (Ivana Zivkovic) | 4: Ivana Zivkovic, ⚠Samir Weber, Sprecher 1, Sprecher 2 | 4: Ivana Zivkovic, Lin, Sprecher 1, Sprecher 2 | 4: Ivana Zivkovic, Dan Lin, Sprecher 1, Sprecher 2 | 4: Ivana Zivkovic, Dan Lin, Sprecher 1, Sprecher 2 | 4: Ivana Zivkovic, Dan Nguyen, Sprecher 1, Sprecher 2 | 3: Ivana Zivkovic, Sprecher 2, Sprecher 1 | 4: Ivana Zivkovic, Dang Linh Nien, Sprecher 1, Sprecher 2 | 2 (nur Nummern) |
| 8028 (Hossain Mortazavi) | 4: Sprecher 1, Herr Lüte, Sprecher 2, Herr Ross | 6: Herr Lüthi, Herr Schoch, Sprecher 1, Sprecher 2, Hoss, Hossain Mortazavi | 6: Herr Lüthi, Schoch, Sprecher 1, Sprecher 2, Hoss, Herr Hoss | 6: Herr Lüthi, Schoch, Sprecher 1, Sprecher 2, Hoss, Herr Hoss | 6: Herr Lüthi, Scholz, Sprecher 1, Sprecher 2, Hoss, Herr Hoss | 6: Herr Lüthi, ⚠Carlos, Sprecher 1, Sprecher 2, Hoss, Herr Ross | 6: Herr Lüthi, Haas, Sprecher 1, Sprecher 2, Hoss, Herr Hoss | 2 (nur Nummern) |
| 8116 (Hossain Mortazavi) | 3: Sprecher 1, Frau Roos, Sprecher 2 | 5: Frau Roos, Scholz, Frau Russ, Sprecher 2, Sprecher 1 | 5: Frau Roos, Scholz, Frau Russ, Sprecher 2, Sprecher 1 | 4: Frau Roos, Sprecher 2, Frau Russ, Sprecher 1 | 5: Frau Roos, Schoss, Frau Russ, Sprecher 2, Sprecher 1 | 6: Frau Roos, Hossain Mortazavi, Sprecher 3, Frau Hess, Sprecher 2, Sprecher 1 | 4: Frau Roos, Hossain, Sprecher 2, Sprecher 1 | 2 (nur Nummern) |
| 8355 (Ivana Zivkovic) | 3: Sprecher 1, Ivana Zivkovic, Sprecher 2 | 4: Herr Pomes, Ivana Zivkovic, Sprecher 1, Sprecher 2 | 4: Herr Pommes, Ivana Zivkovic, Sprecher 1, Sprecher 2 | 4: Herr Pommes, Ivana Zivkovic, Sprecher 1, Sprecher 2 | 4: Herr Pomes, Ivana Zivkovic, Sprecher 1, Sprecher 2 | 4: Herr Thomas, Ivana Zivkovic, Sprecher 1, Sprecher 2 | 4: Herr Bommeli, Ivana Zivkovic, Sprecher 1, Sprecherin 2 | 2 (nur Nummern) |
| 8486 (Ivana Zivkovic) | 3: Sprecher 1, Ivana Zivkovic, Sprecher 2 | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3: Sprecher 1, Sprecher 2, Ivana Zivkovic | 3 (nur Nummern) |
| 8334 (Ivana Zivkovic) | 3: Sprecher 1, Ivana Zivkovic, Sprecher 2 | 3: Logel, Ivana Zivkovic, Sprecher 2 | 4: Frau Logel, Ivana Zivkovic, Frau Zivkovic, Sprecher 2 | 4: Logel, Ivana Zivkovic, Frau Zivkovic, Sprecher 2 | 4: Frau Laugel, Ivana Zivkovic, Frau Zivkovic, Sprecher 2 | 4: Sprecher 1, Ivana Zivkovic, Frau Zivkovic, Sprecher 2 | 3: Rochelle, Ivana Zivkovic, Sprecher 2 | – |
| 10980 (Valerio Labruzzo) | 3: Sprecher 1, Valerio Labruzzo, Sprecher 2 | 5: Frau Wälti, Valerio Labruzzo, Sprecher 1, Sprecher 2, Frau Marti | 5: Frau Wälti, Valerio Labruzzo, Sprecher 1, Sprecher 2, Frau Marti | 5: Frau Wälti, Labruzzo, Sprecher 1, Sprecher 2, Frau Marti | 5: Frau Wälti, Labruzzo, Sprecher 1, Sprecher 2, Frau Marti | 5: Frau Welti, Valerio Labruzzo, Sprecher 1, Sprecher 2, Sprecherin 1 | 5: Frau Walti, Labruzzo, Sprecher 1, Sprecher 2, Frau Asti | – |

### Namen und Begriffe

Immotrust: richtig geschrieben / Varianten; Labruzzo: richtig / Varianten; Strassen. Gespeichert = gemini-2.5-flash.

| Anruf | gespeichert | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard | 3.5-transcribe B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9911 | Immotrust 0 | Immotrust 1; Labruzzo 1; Schwantenholstrasse | Immotrust 1; Labruzzo 1; Schwandenholzstrasse | Immotrust 1; Labruzzo 1; Schwandenholzstrasse | Immotrust 1; Labruzzo 1; Schwandenholzstrasse | Immotrust 1; Labruzzo 1; Schwandenholzstrasse | Immotrust 1; Labruzzo 1; Schwandenholzstrasse | Immotrust 1; Labruzzo 1; Schwantenholzstrasse | Immotrust 0; Labruzzo 1 |
| 9295 | Immotrust 0 (Immo Trust); Eiglerstrasse, Hegelerstraße | Immotrust 6; Hegelerstrasse | Immotrust 5; Hegelerstrasse | Immotrust 6; Hegelerstrasse | Immotrust 6; Egelerstrasse, Hegelerstrasse | Immotrust 6; Hägelerstrasse, Hegelerstrasse | Immotrust 6; Hegelerstrasse, Heglerstrasse | Immotrust 6; Hägelerstrasse | Immotrust 4; Egelseestraße |
| 8876 | Immotrust 0 | Immotrust 0 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 0 |
| 10425 | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 1 (Immo Trust); Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 2; Labruzzo 1; Zürcherstrasse | Immotrust 1 |
| 8369 | Immotrust 0 (Immo Trust) | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 0 |
| 8028 | Immotrust 1 (Immo Trust) | Immotrust 9 (Immotrast) | Immotrust 12 | Immotrust 12 | Immotrust 12 | Immotrust 12 | Immotrust 12 | Immotrust 12 | Immotrust 0 |
| 8116 | Immotrust 0; Zugerstrasse | Immotrust 1; Zugerstraße | Immotrust 1; Zugerstrasse | Immotrust 1; Zugerstrasse | Immotrust 1; Zugerstrasse | Immotrust 1; Zugerstrasse | Immotrust 1; Zürcherstrasse | Immotrust 1; Zugerstrasse | Immotrust 1; Zugerstraße |
| 8355 | Immotrust 0 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 1 | Immotrust 0 |
| 8486 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 | Immotrust 0 |
| 8334 | Immotrust 0 | Immotrust 2 | Immotrust 2 | Immotrust 2 | Immotrust 2 | Immotrust 2 | Immotrust 2 | Immotrust 2 | – |
| 10980 | Immotrust 0 (Immo Trust); Labruzzo 1; Grundstrasse, Kunzstrasse | Immotrust 1; Grundstraße | Immotrust 1; Labruzzo 1; Grundstrasse | Immotrust 1; Labruzzo 1; Grundstrasse, Molkenrain | Immotrust 1; Labruzzo 1; Grundstrasse | Immotrust 1; Labruzzo 1; Grundstrasse | Immotrust 1; Labruzzo 1; Grundstrasse | Immotrust 1; Labruzzo 1; Grundstrasse | – |

### Satzzeiten des Modells vor dem Forced Alignment (alle 11 Gespräche)

| | 3.5-flash-lite minimal | 4-argon low | 4-argon Standard | 4-carbon low | 4-carbon Standard | 3.8-flash low | 3.8-flash Standard |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sätze | 379 | 446 | 443 | 463 | 455 | 440 | 475 |
| ausserhalb des Abschnitts | 0 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) |
| rückwärts/überlappend | 1 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) | 0 (0 %) | 27 (6 %) | 6 (1 %) |
| Ende ≤ Beginn | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| Satzanfang in erkannter Sprache (±0,3 s) | 90 % | 96 % | 96 % | 97 % | 97 % | 92 % | 90 % |
| Abstand zur Ausrichtung, Median je Gespräch (Median / P90) | 7.2 s / 12.4 s | 1.7 s / 5.3 s | 1.9 s / 5.2 s | 1.9 s / 5.4 s | 2.1 s / 5.9 s | 1.0 s / 4.2 s | 1.7 s / 4.8 s |

gemini-3.5-transcribe liefert eigene Wortzeiten (siehe Prüfung vom 10.11.2026); kein Forced Alignment.

### Ungültige Antworten, Zeitüberschreitungen, Fehler (Einzelereignisse)

Keine.

### Anruf 10980, erste Minute

**3.5-flash-lite minimal** (927 Wörter gesamt, 92 %)

> 0.1 s [Sprecher 1] Ja, grüß Sie Frau Malte, der Schlafer Uzo von der Firma Immotrust am Telefon. · 8.1 s [Valerio Labruzzo] Ja. · 9.3 s [Valerio Labruzzo] Wir sind Grundstück in die Käsliche. · 11.6 s [Valerio Labruzzo] Und du locket ganz paar spannende Grundstücken äh in Knonaus. · 14.9 s [Sprecher 1] Jetzt bin ich auf Grundstraße gestoßen auf Feuffi und natürlich auch. · 20.4 s [Sprecher 1] Ja. · 21.3 s [Sprecher 1] Kann ich mal ganz ungeniert welle nachfragen, über vielleicht selber gewisse Plan haben mit der Rigeschaft oder ob wir ihn auch Angebote dürfte machen, vielleicht mal an Fürsrich denkt? · 33.2 s [Sprecher 1] Wie sieht die das aus, wenn ich darf frage? · 35.8 s [Valerio Labruzzo] Ja, ich weiß es selber noch nicht recht was. · 38.1 s [Sprecher 1] Okay, aber sind gut unterwegs, sind gut miteinander. · 41.8 s [Valerio Labruzzo] Bin eigentlich schon nur zweige, ja. · 44.4 s [Sprecher 1] Und da denke ich mal, wird wahrscheinlich sehr sehr einfach möglichst lang drin zu blieben, solange alles gut. · 47.7 s [Valerio Labruzzo] Ja, ja, ja. · 50.5 s [Valerio Labruzzo] Ja. · 51.1 s [Sprecher 1] Ja, genau, genau. · 51.9 s [Sprecher 1] Gut, das kann schnell anders sie, oder? · 54.3 s [Valerio Labruzzo] Ja, wünsche mir sich natürlich nicht, ja. · 57.1 s [Sprecher 1] Oder aber ähm ja. · 59.9 s [Valerio Labruzzo] Was wäre denn so?

**4-argon low** (1117 Wörter gesamt, 111 %)

> 1.3 s [Frau Wälti] Ja, das ist Wälti. · 3.1 s [Valerio Labruzzo] Ja, grüss Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. · 8.5 s [Frau Wälti] Ja? · 9.6 s [Valerio Labruzzo] Wir sind Grundstücksentwickler, Zürcher. · 11.8 s [Valerio Labruzzo] Und wir schauen uns gerade ein paar spannende Grundstücke an in Knonau. · 15.4 s [Valerio Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, aufs Fünf und natürlich auch aufs Drei. · 20.1 s [Frau Wälti] Ja. · 20.9 s [Valerio Labruzzo] Jetzt habe ich einfach mal ganz ungeniert wollen nachfragen, ob Ihr vielleicht selber gewisse Pläne habt mit der Liegenschaft oder ob wir Ihnen mal das Angebot dürften machen, falls Ihr mal an eine Veräusserung denkt. · 31.9 s [Valerio Labruzzo] Wie sähe denn das aus, wenn ich darf fragen? · 34.2 s [Frau Wälti] Ja, ich weiss es selber noch nicht recht, was. · 37.8 s [Valerio Labruzzo] Okay. · 39.5 s [Valerio Labruzzo] Aber sind Ihr gut zwäg, sind Ihr gut beieinander, sage ich? · 42.2 s [Frau Wälti] Ich bin eigentlich schon noch zwäg, ja. · 44.4 s [Valerio Labruzzo] Und da denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lange drinnen zu bleiben, solange alles gut · 48.5 s [Frau Wälti] Ja, ja, ja. · 50.3 s [Valerio Labruzzo] Ja, genau, genau, gut. · 52.1 s [Frau Wälti] Das kann schnell anders sein, oder? · 54.7 s [Valerio Labruzzo] Ja, wünscht man sich natürlich nicht, ja, aber · 57.1 s [Frau Wälti] Oder, aber ja. · 59.0 s [Valerio Labruzzo] Was wäre denn so

**4-argon Standard** (1129 Wörter gesamt, 112 %)

> 1.2 s [Frau Wälti] Ja, das ist Wälti. · 3.0 s [Valerio Labruzzo] Ja, grüß Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. · 8.3 s [Frau Wälti] Ja? · 9.6 s [Valerio Labruzzo] Wir sind Grundstückentwickler aus Örlikon. · 12.0 s [Valerio Labruzzo] Und wir schauen jetzt gerade ein paar spannende Grundstücke an in Knonau. · 15.5 s [Valerio Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, aufs 5 und natürlich auch aufs 3. · 20.2 s [Frau Wälti] Ja. · 20.9 s [Valerio Labruzzo] Jetzt habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräusserung gedacht haben. · 32.0 s [Valerio Labruzzo] Wie sähe denn das aus, wenn ich darf fragen? · 34.3 s [Frau Wälti] Ja, ich weiss es selber noch nicht recht, was. · 38.6 s [Valerio Labruzzo] Okay. · 39.6 s [Valerio Labruzzo] Aber sind Sie gut zwäg, sind Sie gut beieinander sonst? · 42.2 s [Frau Wälti] Ja, ich bin eigentlich schon noch zwäg, ja. · 44.6 s [Valerio Labruzzo] Und da denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lange drinnen zu bleiben, solange alles gut ist. · 48.5 s [Frau Wälti] Ja, ja, ja, ja. · 50.8 s [Valerio Labruzzo] Ja, genau, genau, gut. · 52.1 s [Frau Wälti] Es kann schnell anders sein, oder? · 54.6 s [Valerio Labruzzo] Ja, wünscht man sich natürlich nicht, ja. · 57.2 s [Frau Wälti] Oder, aber ja. · 59.1 s [Valerio Labruzzo] Was wäre denn so

**4-carbon low** (1127 Wörter gesamt, 112 %)

> 1.2 s [Frau Wälti] Ja, das ist Wälti. · 3.0 s [Labruzzo] Ja, grüß Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. · 8.2 s [Frau Wälti] Ja? · 9.4 s [Labruzzo] Wir sind Grundstücksentwickler, Zürcher, und wir schauen uns gerade so ein paar spannende Grundstücke an in Knonau. · 15.4 s [Labruzzo] Jetzt bin ich auf die Grundstrasse gestoßen, auf die 5 und natürlich auch auf die 3. · 19.9 s [Frau Wälti] Ja. · 20.6 s [Labruzzo] Jetzt habe ich einfach ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräußerung denken. · 31.9 s [Labruzzo] Wie sieht denn das aus, wenn ich da frage? · 34.2 s [Frau Wälti] Ja, ich weiß es selber noch nicht recht, was. · 38.5 s [Labruzzo] Okay. · 39.4 s [Labruzzo] Aber Sie sind gut zwäg, sind gut beieinander so? · 41.9 s [Frau Wälti] Ja, ich bin eigentlich schon noch zwäg, ja. · 44.5 s [Labruzzo] Und dann denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lange drinnen zu bleiben, solange alles gut ist. · 48.5 s [Frau Wälti] Ja, ja, ja. · 50.5 s [Labruzzo] Ja, genau, genau, gut. · 51.9 s [Frau Wälti] Das kann schnell anders sein, oder? · 54.6 s [Labruzzo] Ja, wünscht man sich natürlich nicht, ja. · 56.7 s [Frau Wälti] Oder aber ja. · 58.9 s [Labruzzo] Was wäre denn so

**4-carbon Standard** (1154 Wörter gesamt, 114 %)

> 1.0 s [Frau Wälti] Ja, das ist Wälti. · 2.8 s [Labruzzo] Ja, grüß Sie Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. · 8.3 s [Frau Wälti] Ja? · 9.6 s [Labruzzo] Wir sind Grundstückentwickler aus Örlikon. · 11.9 s [Labruzzo] Wir schauen jetzt gerade so ein paar spannende Grundstücke an in Knonau. · 15.5 s [Labruzzo] Jetzt bin ich auf die Grundstrasse gestoßen, aufs Fünf und natürlich auch aufs Drei. · 20.4 s [Frau Wälti] Ja. · 21.2 s [Labruzzo] Jetzt habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräusserung denken. · 31.7 s [Labruzzo] Wie sieht denn das aus, wenn ich darf fragen? · 34.2 s [Frau Wälti] Ja, ich weiß es selber noch nicht recht, was. · 38.6 s [Labruzzo] Okay. · 39.7 s [Labruzzo] Aber sind Sie gut zwäg, sind Sie gut beieinander sonst? · 42.2 s [Frau Wälti] Ich bin eigentlich schon noch zwäg, ja. · 44.6 s [Labruzzo] Dann denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lange drinnen zu bleiben, solange alles gut ist. · 48.5 s [Frau Wälti] Ja, ja, ja. · 50.8 s [Labruzzo] Ja, genau, genau. · 52.0 s [Frau Wälti] Gut, das kann schnell anders sein, oder? · 54.8 s [Labruzzo] Ja, wünscht man sich natürlich nicht, ja. · 56.9 s [Frau Wälti] Oder aber äh, ja. · 59.0 s [Labruzzo] Was wäre denn so

**3.8-flash low** (1099 Wörter gesamt, 109 %)

> 0.7 s [Frau Welti] Ja, das Welti. · 2.0 s [Valerio Labruzzo] Ja, grüsse Sie, Frau Welti, da ist Labruzzo von der Firma Immotrust am Telefon. · 7.8 s [Frau Welti] Ja? · 8.8 s [Valerio Labruzzo] Wir sind Grundstückentwickler aus Oerlikon und wir schauen ab und zu die Grundstücke an. · 14.4 s [Valerio Labruzzo] In Knonau jetzt bin ich auf Grundstrasse gestossen, aufs 5 und natürlich aufs 3. · 20.4 s [Frau Welti] Ja. · 21.1 s [Valerio Labruzzo] Da habe ich einfach mal ganz ungeniert wollen nachfragen, ob ihr vielleicht selber gewisse Pläne habt mit der Liegenschaft oder ob man Ihnen mal ein Angebot dürfte machen. · 29.2 s [Valerio Labruzzo] Vielleicht mal an eine Veräusserung gedacht? · 31.0 s [Valerio Labruzzo] Wie sieht das aus, wenn ich darf fragen? · 33.4 s [Frau Welti] Ja, ich weiss es selber noch nicht recht, was. · 38.0 s [Valerio Labruzzo] Okay. · 39.1 s [Valerio Labruzzo] Aber Sie sind gut zuweg, Sie sind gut beieinander? · 42.0 s [Frau Welti] Ich bin eigentlich schon noch zuweg, ja. · 44.2 s [Valerio Labruzzo] Und dann denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lang drin zu bleiben, solange alles gut geht? · 48.6 s [Frau Welti] Ja, ja, ja. · 50.8 s [Frau Welti] Ja, genau, genau. · 52.0 s [Frau Welti] Gut, es kann schnell anders sein, oder? · 54.4 s [Valerio Labruzzo] Ja, wünscht man sich natürlich nicht, ja, klar. · 56.5 s [Frau Welti] Oder aber [hustet] ja. · 59.0 s [Valerio Labruzzo] Was wäre dann so

**3.8-flash Standard** (1126 Wörter gesamt, 112 %)

> 1.1 s [Frau Walti] Ja, hier Walti. · 2.8 s [Labruzzo] Ja, guten Tag, Frau Walti. · 4.3 s [Labruzzo] Hier ist Labruzzo von der Firma Immotrust am Telefon. · 7.9 s [Frau Walti] Ja? · 9.1 s [Labruzzo] Wir sind Grundstücksentwickler, sozusagen, und wir schauen uns gerade so spannende Grundstücke an in Knonau. · 15.3 s [Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, auf die 5 und natürlich auch auf die 3. · 20.1 s [Frau Walti] Ja. · 21.2 s [Labruzzo] Da habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft, oder ob wir Ihnen mal ein Angebot machen dürfen, vielleicht mal an eine Veräusserung gedacht? · 31.0 s [Labruzzo] Wie sieht denn das aus, wenn ich da frage? · 33.6 s [Frau Walti] Ja, ich weiss es selber noch nicht recht, was... · 37.7 s [Labruzzo] Okay. · 39.2 s [Labruzzo] Aber sind Sie gut zuweg, sind Sie gut beieinander, dass... · 42.2 s [Frau Walti] Nein, ich bin eigentlich schon noch gut zuweg, ja. · 44.3 s [Labruzzo] Und da denke ich mal, wird wahrscheinlich das Ziel sein, einfach möglichst lange drinnen zu bleiben, solange alles gut... · 48.4 s [Frau Walti] Ja, ja, ja. · 50.0 s [Frau Walti] Ja, genau, genau. · 51.7 s [Frau Walti] Gut, das kann schnell anders sein, oder? · 54.3 s [Labruzzo] Ja, wünscht man sich natürlich nicht, ja. · 56.3 s [Frau Walti] Nein, aber ja. · 58.9 s [Labruzzo] Was wäre denn so...

**3.5-transcribe B**

> kein Ergebnis

### Abhör-Fenster (Text je Modell, Sätze mit Beginn im Fenster, Modellzeiten)

#### 10425, 0–30 s

- **3.5-flash-lite minimal**: [Frau Rumbach] Frau Rumbach. [Hansjörg Rumbach] Ja, Sie Herr Frau Rumbach, das ist der Labruzzo von der Firma Immotrust am Telefon. [Frau Rumbach] Grüezi. [Hansjörg Rumbach] Herr Hansjörg Rumbach hätte ich gesucht gehabt. [Frau Rumbach] Der ist nicht da. [Frau Rumbach] Was gibt's? [Hansjörg Rumbach] Grundsätzlich gang, die ist euch drun, dass wir aktuell gerade ein paar Spanne die Liegenschaft prüft. [Hansjörg Rumbach] Jetzt bin ich auf eine gestoßen, wo laut Grundbuch am Team gehört in Schlieren Zürcherstrasse. [Hansjörg Rumbach] Und frage wäre eigentlich, ob wir einmal Volt mal dürfte das Angebot unterbreiten oder über selber gewisse Plan hättet in dem Sinn. [Hansjörg Rumbach] Also mit anderen Worten würde Ustrecke wär.
- **4-argon low**: [Frau Rombach] Rombach. [Valerio Labruzzo] Grüezi, Frau Rombach, da ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rombach] Grüezi. [Valerio Labruzzo] Herr Hans-Jörg Rombach hätte ich gesucht gehabt. [Frau Rombach] Er ist nicht da. [Frau Rombach] Um was geht es? [Valerio Labruzzo] Grundsätzlich ginge es eigentlich darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört, in Schlieren, Zürcherstrasse. [Frau Rombach] Ja. [Valerio Labruzzo] Und die Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürften ein Angebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn.
- **4-argon Standard**: [Frau Rombach] Rombach? [Valerio Labruzzo] Grüezi Frau Rombach, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rombach] Grüezi. [Valerio Labruzzo] Herr Hans-Jörg Rombach hätte ich gesucht gehabt. [Frau Rombach] Er ist nicht da. [Frau Rombach] Um was geht es? [Valerio Labruzzo] Grundsätzlich ginge es eigentlich darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört in Schlieren, Zürcherstrasse. [Frau Rombach] Ja. [Valerio Labruzzo] Und die Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürften ein Kaufangebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn. [Valerio Labruzzo] Also mit anderen Worten ein klein wenig die Fühler ausstrecken wäre so ein klein wenig das gewesen, wo ich mache.
- **4-carbon low**: [Frau Rombach] Rombach. [Valerio Labruzzo] Grüezi, eigentlich Frau Rombach, da ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rombach] Grüezi. [Valerio Labruzzo] Herr Hansjörg Rombach hätte ich gesucht gehabt. [Frau Rombach] Er ist nicht da. [Frau Rombach] Um was geht es? [Valerio Labruzzo] Grundsätzlich ginge es eigentlich darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört in Schlieren, Zürcherstrasse. [Frau Rombach] Ja. [Valerio Labruzzo] Und die Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürften ein Angebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn.
- **4-carbon Standard**: [Frau Rombach] Rombach. [Valerio Labruzzo] Grüezi, Frau Rombach, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rombach] Grüezi. [Valerio Labruzzo] Herrn Hansjörg Rombach hätte ich gesucht gehabt. [Frau Rombach] Er ist nicht da. [Frau Rombach] Um was geht es? [Valerio Labruzzo] Grundsätzlich ginge es eigentlich darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört, in Schlieren, Zürcherstrasse. [Frau Rombach] Ja. [Valerio Labruzzo] Und die Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürften ein Angebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn.
- **3.8-flash low**: [Frau Rohrbach] Rohrbach. [Valerio Labruzzo] Grüezi Frau Rohrbach, da ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rohrbach] Grüezi. [Valerio Labruzzo] Herr Hansjörg Rohrbach hätte ich gesucht gehabt. [Frau Rohrbach] Er ist nicht da. [Frau Rohrbach] Um was geht's? [Valerio Labruzzo] Grundsätzlich ginge es darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört in Schlieren, Zürcherstrasse. [Frau Rohrbach] Ja. [Valerio Labruzzo] Und Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürfen ein Angebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn. [Valerio Labruzzo] Also mit anderen Worten, ein bisschen die Fühler ausstrecken wäre so ein bisschen das gewesen, was ich vorhatte.
- **3.8-flash Standard**: [Frau Rohrbach] Rohrbach. [Valerio Labruzzo] Grüezi Frau Rohrbach, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Rohrbach] Grüezi. [Valerio Labruzzo] Herrn Hansjörg Rohrbach hätte ich gesucht gehabt. [Frau Rohrbach] Er ist nicht da, um was geht es? [Valerio Labruzzo] Grundsätzlich ginge es eigentlich darum, dass wir aktuell gerade ein paar spannende Liegenschaften prüfen. [Valerio Labruzzo] Jetzt bin ich auf eine gestossen, wo laut Grundbuchamt ihm gehört in Schlieren, Zürcherstrasse. [Frau Rohrbach] Ja. [Valerio Labruzzo] Und die Frage wäre eigentlich gewesen, ob wir ihm allenfalls mal dürfen ein Angebot unterbreiten oder ob er selber gewisse Pläne hat in dem Sinn. [Valerio Labruzzo] Also mit anderen Worten, ein bisschen die Fühler ausstrecken wäre so ein bisschen die Absicht gewesen, wo ich gehabt habe.
- **3.5-transcribe B**: [Sprecher 1] von der Firma. [Sprecher 2] Was gibt's?

#### 8028, 60–90 s

- **3.5-flash-lite minimal**: [Sprecher 1] Frau Bachmann, nein. [Sprecher 2] Sie sind Sie auf mich gekommen? [Sprecher 2] Ein mir schon mal miteinander geredet, oder? [Sprecher 1] Mit mir? [Sprecher 1] Nein, nein. [Sprecher 2] Mit mir nicht? [Sprecher 1] Nein. [Sprecher 2] Irgendwie die Stimme ist mir so bekannt, du weißt sind so viele Leute, wo da sich um meine Liegenschaft interessieren. [Sprecher 2] Also Da kann ich mir gut vorstellen, da kann ich mir gut vorstellen. [Sprecher 2] Ja, aber ne, mich wundert, wie können Sie da in können Sie da im Archiv, wer ist da vielleicht da ein alter Maul vielleicht da abgekratzt und sagt mal ha, der hätte Liegenschaft oder wie geht das so, dass alle auf mich zukommen?
- **4-argon low**: [Sprecher 1] nicht verkaufen, nein. [Sprecher 2] Mhm. [Sprecher 2] Da tue ich das so besprechen. [Sprecher 1] Wie sind Sie auf mich gekommen? [Sprecher 1] Haben wir schon mal miteinander geredet oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht. [Sprecher 2] Nein. [Sprecher 1] Irgendwie die Stimme ist mir so bekannt vorgekommen, ich meine, es sind so viele Leute, die da sich um meine Liegenschaft interessieren, also. [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, ja, eben. [Sprecher 1] Es nimmt mich wunder, wie gehen Sie da, gehen Sie da im Archiv schauen, wer ist da vielleicht da ein alter Mann, der vielleicht da gleich abkratzt und schaut man, aha, der hätte eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **4-argon Standard**: [Sprecher 1] nicht verkaufen, nein. [Sprecher 1] Wie sind Sie eigentlich auf mich gekommen, haben wir schon mal miteinander geredet, oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht. [Sprecher 2] Nein. [Sprecher 1] Irgendwie die Stimme ist mir eben so bekannt vorgekommen, ich meine, es sind so viele Leute, wo da sich um meine Liegenschaft interessieren, also. [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, eben, aber nimmt mich wunder, wie gehen Sie da in, gehen Sie da im Archiv schauen, wer ist da vielleicht da ein alter Mann, wo vielleicht da gleich abkratzt und sagt man, aha, der hat eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **4-carbon low**: [Sprecher 1] nicht verkaufen, nein. [Sprecher 2] [unverständlich] [Sprecher 1] Wie sind Sie auf mich gekommen? [Sprecher 1] Haben wir schon mal miteinander geredet, oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht? [Sprecher 2] Nein. [Sprecher 1] Irgendwie ist mir die Stimme so bekannt vorgekommen. [Sprecher 1] Ich meine, es sind so viele Leute, die sich da für meine Liegenschaft interessieren, also. [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, eben, aber es nimmt mich wunder, wie gehen Sie denn, gehen Sie da im Archiv nachschauen, wer ist da vielleicht da ein alter Mann, der vielleicht da gleich abkratzt und sagt man: Aha, der hat eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **4-carbon Standard**: [Sprecher 1] nicht verkaufen, nein. [Sprecher 2] Da tue ich das so speichern. [Sprecher 1] Wie sind Sie auf mich gekommen? [Sprecher 1] Haben wir schon mal miteinander geredet, oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht. [Sprecher 2] Nein. [Sprecher 1] Irgendwie die Stimme ist mir so bekannt vorgekommen. [Sprecher 1] Ich meine, es sind so viele Leute, die da sich um meine Liegenschaft interessieren, also [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, eben. [Sprecher 1] Nimmt mich wunder, wie gehen Sie da in, gehen Sie da im Archiv schauen, wer ist da vielleicht da ein alter Mann, wo vielleicht da gleich abkratzt und sagt man: Aha, der hat eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **3.8-flash low**: [Sprecher 1] verkaufen, nein. [Sprecher 1] Wie sind Sie auf mich gekommen? [Sprecher 1] Haben wir schon mal miteinander geredet, oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht? [Sprecher 2] Nein. [Sprecher 1] Irgendwie, die Stimme ist mir eben so bekannt vorgekommen, drum weiss ich nicht. [Sprecher 1] Gibt so viele Leute, wo da sich um meine Liegenschaft interessieren, also... [Sprecher 2] Ja, das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, eben, aber nimmt mich Wunder, wie Können Sie da in Können Sie da im Archiv gehen schauen, wer ist da vielleicht da ein alter Mann, wo vielleicht da gleich abkratzt, und dort mal ah, der hat eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **3.8-flash Standard**: [Sprecher 1] verkaufen, nein. [Sprecher 1] Wie sind Sie auf mich gekommen? [Sprecher 1] Haben wir schon mal miteinander geredet, oder? [Sprecher 2] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht? [Sprecher 2] Nein. [Sprecher 1] Irgendwie die Stimme ist mir eben so bekannt vorgekommen, darum weiss ich nicht. [Sprecher 1] Gibt so viele Leute, wo da sich um meine Liegenschaft interessieren, also... [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja eben, aber nimmt mich wunder, wie... [Sprecher 1] Gehen Sie da in... [Sprecher 1] Gehen Sie da im Archiv schauen, wer ist da vielleicht da ein alter Mann, wo vielleicht da gleich abkratzt, und sagt man: Aha, der hat eine Liegenschaft, oder wie geht das so, dass alle auf mich zukommen?
- **3.5-transcribe B**: [Sprecher 1] Nein, mit mir nie, nein. [Sprecher 1] Mit mir nicht. [Sprecher 1] Nein. [Sprecher 1] Irgendwie stimme ich mir aber so bekannt Jetzt so viele um meine Liegenschaft interessiere. [Sprecher 1] Also [Sprecher 2] Das kann ich mir gut vorstellen, das kann ich mir gut vorstellen. [Sprecher 1] Ja, ja eben aber oder wie geht das so, dass auf mich

#### 10980, 0–30 s

- **3.5-flash-lite minimal**: [Sprecher 1] Ja, grüß Sie Frau Malte, der Schlafer Uzo von der Firma Immotrust am Telefon. [Valerio Labruzzo] Ja. [Valerio Labruzzo] Wir sind Grundstück in die Käsliche. [Valerio Labruzzo] Und du locket ganz paar spannende Grundstücken äh in Knonaus. [Sprecher 1] Jetzt bin ich auf Grundstraße gestoßen auf Feuffi und natürlich auch. [Sprecher 1] Ja. [Sprecher 1] Kann ich mal ganz ungeniert welle nachfragen, über vielleicht selber gewisse Plan haben mit der Rigeschaft oder ob wir ihn auch Angebote dürfte machen, vielleicht mal an Fürsrich denkt?
- **4-argon low**: [Frau Wälti] Ja, das ist Wälti. [Valerio Labruzzo] Ja, grüss Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Wälti] Ja? [Valerio Labruzzo] Wir sind Grundstücksentwickler, Zürcher. [Valerio Labruzzo] Und wir schauen uns gerade ein paar spannende Grundstücke an in Knonau. [Valerio Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, aufs Fünf und natürlich auch aufs Drei. [Frau Wälti] Ja. [Valerio Labruzzo] Jetzt habe ich einfach mal ganz ungeniert wollen nachfragen, ob Ihr vielleicht selber gewisse Pläne habt mit der Liegenschaft oder ob wir Ihnen mal das Angebot dürften machen, falls Ihr mal an eine Veräusserung denkt.
- **4-argon Standard**: [Frau Wälti] Ja, das ist Wälti. [Valerio Labruzzo] Ja, grüß Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Wälti] Ja? [Valerio Labruzzo] Wir sind Grundstückentwickler aus Örlikon. [Valerio Labruzzo] Und wir schauen jetzt gerade ein paar spannende Grundstücke an in Knonau. [Valerio Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, aufs 5 und natürlich auch aufs 3. [Frau Wälti] Ja. [Valerio Labruzzo] Jetzt habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräusserung gedacht haben.
- **4-carbon low**: [Frau Wälti] Ja, das ist Wälti. [Labruzzo] Ja, grüß Sie, Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Wälti] Ja? [Labruzzo] Wir sind Grundstücksentwickler, Zürcher, und wir schauen uns gerade so ein paar spannende Grundstücke an in Knonau. [Labruzzo] Jetzt bin ich auf die Grundstrasse gestoßen, auf die 5 und natürlich auch auf die 3. [Frau Wälti] Ja. [Labruzzo] Jetzt habe ich einfach ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräußerung denken.
- **4-carbon Standard**: [Frau Wälti] Ja, das ist Wälti. [Labruzzo] Ja, grüß Sie Frau Wälti, das ist Labruzzo von der Firma Immotrust am Telefon. [Frau Wälti] Ja? [Labruzzo] Wir sind Grundstückentwickler aus Örlikon. [Labruzzo] Wir schauen jetzt gerade so ein paar spannende Grundstücke an in Knonau. [Labruzzo] Jetzt bin ich auf die Grundstrasse gestoßen, aufs Fünf und natürlich auch aufs Drei. [Frau Wälti] Ja. [Labruzzo] Jetzt habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft oder ob man Ihnen mal ein Angebot machen dürfte, falls Sie mal an eine Veräusserung denken.
- **3.8-flash low**: [Frau Welti] Ja, das Welti. [Valerio Labruzzo] Ja, grüsse Sie, Frau Welti, da ist Labruzzo von der Firma Immotrust am Telefon. [Frau Welti] Ja? [Valerio Labruzzo] Wir sind Grundstückentwickler aus Oerlikon und wir schauen ab und zu die Grundstücke an. [Valerio Labruzzo] In Knonau jetzt bin ich auf Grundstrasse gestossen, aufs 5 und natürlich aufs 3. [Frau Welti] Ja. [Valerio Labruzzo] Da habe ich einfach mal ganz ungeniert wollen nachfragen, ob ihr vielleicht selber gewisse Pläne habt mit der Liegenschaft oder ob man Ihnen mal ein Angebot dürfte machen. [Valerio Labruzzo] Vielleicht mal an eine Veräusserung gedacht?
- **3.8-flash Standard**: [Frau Walti] Ja, hier Walti. [Labruzzo] Ja, guten Tag, Frau Walti. [Labruzzo] Hier ist Labruzzo von der Firma Immotrust am Telefon. [Frau Walti] Ja? [Labruzzo] Wir sind Grundstücksentwickler, sozusagen, und wir schauen uns gerade so spannende Grundstücke an in Knonau. [Labruzzo] Jetzt bin ich auf die Grundstrasse gestossen, auf die 5 und natürlich auch auf die 3. [Frau Walti] Ja. [Labruzzo] Da habe ich einfach mal ganz ungeniert nachfragen wollen, ob Sie vielleicht selber gewisse Pläne haben mit der Liegenschaft, oder ob wir Ihnen mal ein Angebot machen dürfen, vielleicht mal an eine Veräusserung gedacht?
- **3.5-transcribe B**: kein Ergebnis

<!-- tabellen:end -->
