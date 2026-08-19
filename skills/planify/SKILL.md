---
name: planify
description: "Pläne als JSON bauen und über das Tool plan_render zu HTML rendern, optional mit Diagramm. Laden, bevor ein Plan, eine Spezifikation, ein Audit oder ein Umsetzungsvorschlag ausgegeben wird — enthält Schema, Feldbedeutungen, Schreibregeln und ein Beispiel."
compatibility: opencode
metadata:
  audience: alle Agents
  language: de-CH
---

# planify

Der Plan ist Inhalt, nicht Layout. Du lieferst JSON, das Layout kommt aus dem
Nunjucks-Template. Ausgabeweg ist immer das Tool `plan_render`: es validiert
gegen `schema/plan.schema.json`, schreibt
`docs/plans/<TICKET>-<slug>.plan.json` plus `<TICKET>-<slug>.html` und öffnet die
HTML-Datei im Standard-Browser.

Nie selbst HTML oder Markdown für einen Plan schreiben, nie eine Plan-Datei per
`write` oder `edit` anlegen. Schemafehler zurück → nichts geschrieben, Felder
korrigieren, erneut aufrufen.

## Sprache

Feldnamen englisch, Inhalte deutsch. Echte Umlaute (ä, ö, ü), nie ae/oe/ue. Kein
Eszett, immer "ss" — ausgenommen zitierte Daten, Fixtures, Eigennamen. Der
Renderer warnt bei Verstössen: korrigieren, neu rendern.

`slug` ist die Ausnahme: reines ASCII in Kebab-Case, er bildet nur den Dateinamen.

## Felder

| Feld | Pflicht | Inhalt |
| --- | --- | --- |
| `ticket` | ja | Ticket-Key aus dem Branch, Muster `[A-Z][A-Z0-9]+-[0-9]+`. Kein Treffer → nachfragen, nicht raten. |
| `slug` | ja | Kurztitel in Kebab-Case, ASCII, maximal 60 Zeichen. |
| `title` | ja | Titel des Vorhabens, deutsch, ohne Ticket-Nummer. |
| `intent` | ja | Ein Absatz: was gemacht wird und warum. Keine Wiederholung des Titels. |
| `context` | nein | `problem` (was heute schiefgeht), `outcome` (Zustand nach der Umsetzung). |
| `steps[]` | ja | Schritte in Reihenfolge: `title`, optional `rationale`, `files[]` mit exaktem `path` und `change`, optional `commands[]`. |
| `verification[]` | ja | `how` (Kommando oder Handgriff), `expected` (woran man Erfolg erkennt). |
| `risks[]` | nein | `risk`, `mitigation`. Nur echte Risiken, keine Allgemeinplätze. |
| `openDecisions[]` | nein | `question`, `recommendation`, `tradeoff`. Jede offene Entscheidung gehört hierher. |
| `outOfScope[]` | nein | Was bewusst nicht gemacht wird. |
| `diagram` | nein | `title`, optional `caption`, `svgPath`. Siehe unten. |
| `meta` | ja | `createdAt` (ISO-8601), optional `model`, `branch`, `repo`. |

## Schreibregeln

- Kurze Sätze, Aussagen statt Absichtserklärungen. HTML ist kein Freibrief für
  Füllmaterial: kein Abschnitt "Ansatz", kein "Non-Goals", keine Wiederholung des
  Kontexts in jedem Schritt.
- `files[].path`: exakter Pfad relativ zum Projekt, bestehend oder neu anzulegen.
  Nie "diverse Dateien", nie ein Verzeichnis als Sammelposten.
- `files[].change`: was in dieser Datei passiert, ein Satz.
- `rationale` nur, wenn die Begründung nicht offensichtlich ist.
- `verification` Ende zu Ende: Anwendung starten, Tests laufen lassen, Ausgabe
  prüfen. "Code kompiliert" ist keine Verifikation.
- Wiederverwendete Funktionen und Hilfsmittel nennen, mit Pfad.
- Entfernt ein Schritt etwas Bestehendes (Datei, Feature, UI-Element, Kommentar),
  sagt `change` das ausdrücklich.

## Diagramm

Nur, wenn es Struktur zeigt, die die Prosa nicht trägt: Abhängigkeiten,
Datenfluss, Zustände, Reihenfolgen mit Verzweigungen. Lineare Schrittfolge wird
aufgezählt, nicht gezeichnet.

1. Skill `diagram-design` laden, Diagramm als HTML erzeugen.
2. Daraus `.svg` exportieren, nach `references/export.md` des Skills
   `diagram-design`, Abschnitt "SVG export procedure": erstes `<svg>` extrahieren,
   `xmlns` und `viewBox` sicherstellen, `title`/`desc` erhalten. Nur SVG, kein
   PNG — Playwright wird nicht gebraucht.
3. Pfad in `diagram.svgPath`, dazu `title` und optional `caption`.

planify entfernt aktive Inhalte (`script`, `on*`) und den von `diagram-design`
injizierten Google-Fonts-Import und bettet das SVG inline ein; im Diagramm
greifen dann die Schriften des Themes. So bleibt die HTML-Datei eigenständig:
keine Bilddatei daneben, keine CDN-Skripte, keine Web-Fonts, keine entfernten
Bilder.

Ist `diagram-design` nicht verfügbar, `diagram` weglassen — kein handgeschriebenes
SVG, keine Mermaid-Blöcke im Plan.

## Beispiel

`references/beispiel-plan.json` ist ein vollständiger, schemakonformer Plan. Lies
ihn, wenn unklar ist, wie fein ein Schritt geschnitten sein soll.
