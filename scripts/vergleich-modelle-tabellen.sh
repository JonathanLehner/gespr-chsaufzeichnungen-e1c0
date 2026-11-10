#!/bin/bash
# Erneuert den Tabellenteil (zwischen den Markern) in docs/vergleich-modelle-2026-11-10.md.
#   scripts/vergleich-modelle-tabellen.sh [ergebnisordner-modelle] [ergebnisordner-einstellungen]
set -euo pipefail
cd "$(dirname "$0")/.."
M=${1:-$HOME/clawcorp-results/gespr-e1c0-models}
S=${2:-$HOME/clawcorp-results/gespr-e1c0-settings}
DOC=docs/vergleich-modelle-2026-11-10.md
TAB=$(mktemp)
node scripts/vergleich-modelle-bericht.mjs "$M/results.json" "$S/results.json" "$M/vocabulary.json" "$M/callers-per-call.json" > "$TAB"
python3 -I -c '
import re, sys
doc, tab = sys.argv[1], open(sys.argv[2]).read().strip()
s = open(doc).read()
s = re.sub(r"<!-- tabellen:start -->.*<!-- tabellen:end -->", lambda m: "<!-- tabellen:start -->\n\n" + tab + "\n\n<!-- tabellen:end -->", s, flags=re.S)
open(doc, "w").write(s)
' "$DOC" "$TAB"
rm -f "$TAB"
